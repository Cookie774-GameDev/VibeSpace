import { classifyOpenCodeAuthFailure, HarnessError, redactHarnessText } from './errors';
import { verifiedQwenCompatibleBaseUrl } from '@/lib/ai/nativeConnectionProbe';
import { normalizeOpenCodeEvent } from './eventNormalizer';
import { createOpenCodeHttpClient, type OpenCodeHttpClient } from './openCodeClient';
import {
  harnessRuntimeManager,
  type HarnessRuntimeManager,
  type OpenCodeServerConnection,
} from './runtimeManager';
import {
  catalogContainsSelection,
  parseOpenCodeProviderResponse,
  resolveOpenCodeSelection,
  trustedCatalogForSelection,
} from './providerReconciliation';
import type { OpenCodeSseEvent } from './sseParser';
import type {
  CreateHarnessSession,
  HarnessApprovalResponse,
  HarnessEvent,
  HarnessModel,
  HarnessProvider,
  HarnessReady,
  HarnessSendRequest,
  HarnessSession,
  VibeSpaceHarness,
} from './types';

interface OpenCodeHarnessOptions {
  fetch?: typeof globalThis.fetch;
  maxReconnectAttempts?: number;
  reconnectDelay?: (attempt: number) => Promise<void>;
  qwenEndpoint?: () => string | undefined;
  /**
   * How long a send may wait for OpenCode `/config/providers`. The full
   * provider scan regularly takes tens of seconds; greetings must not block
   * on it when the user already selected an exact model.
   */
  providerCatalogTimeoutMs?: number;
}

const MAX_RECENT_EVENTS = 256;
const MAX_ERROR_LENGTH = 2_048;
const MAX_RECOVERED_ASSISTANT_TEXT = 1_500_000;
const PROVIDER_CATALOG_TTL_MS = 5 * 60_000;
const DEFAULT_PROVIDER_CATALOG_TIMEOUT_MS = 1_200;

type FullTextSnapshotState = {
  assistantMessageIds: Set<string>;
  latestAssistantMessageId?: string;
  textPartsByMessage: Map<string, Map<string, string>>;
};

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : undefined;
}

function observeFullTextSnapshot(
  value: unknown,
  expectedSessionId: string,
  state: FullTextSnapshotState,
): void {
  const event = recordValue(value);
  const properties = recordValue(event?.properties);
  if (!event || !properties || properties.sessionID !== expectedSessionId) return;

  if (event.type === 'message.updated') {
    const info = recordValue(properties.info);
    const messageId = boundedString(info?.id, 512);
    if (messageId && info?.role === 'assistant') {
      state.assistantMessageIds.add(messageId);
      state.latestAssistantMessageId = messageId;
    }
    return;
  }
  if (event.type !== 'message.part.updated') return;

  const part = recordValue(properties.part);
  const messageId = boundedString(part?.messageID, 512);
  const partId = boundedString(part?.id, 512);
  const text = boundedString(part?.text, MAX_RECOVERED_ASSISTANT_TEXT);
  if (!part || part.type !== 'text' || !messageId || !partId || !text) return;
  let messageParts = state.textPartsByMessage.get(messageId);
  if (!messageParts) {
    messageParts = new Map();
    state.textPartsByMessage.set(messageId, messageParts);
  }
  if (messageParts.size >= 256 && !messageParts.has(partId)) return;
  messageParts.set(partId, text);
}

function latestAssistantTextSnapshot(state: FullTextSnapshotState): string {
  const messageId = state.latestAssistantMessageId;
  if (!messageId || !state.assistantMessageIds.has(messageId)) return '';
  const parts = state.textPartsByMessage.get(messageId);
  if (!parts) return '';
  const text = [...parts.values()].join('');
  return text.length <= MAX_RECOVERED_ASSISTANT_TEXT ? text : '';
}

function safeError(error: unknown, connection?: OpenCodeServerConnection): string {
  let message = error instanceof Error ? error.message : 'OpenCode stream failed.';
  if (connection) message = message.split(connection.password).join('[REDACTED]');
  return redactHarnessText(message).slice(0, MAX_ERROR_LENGTH);
}

class RecentEventSet {
  private readonly values = new Set<string>();
  private readonly order: string[] = [];

  add(event: OpenCodeSseEvent): boolean {
    let first = 2_166_136_261;
    let second = 5381;
    for (let index = 0; index < event.data.length; index += 1) {
      const code = event.data.charCodeAt(index);
      first = Math.imul(first ^ code, 16_777_619) >>> 0;
      second = (Math.imul(second, 33) ^ code) >>> 0;
    }
    const identity = `${event.id ?? ''}\0${event.event ?? ''}\0${event.data.length}:${first}:${second}`;
    if (this.values.has(identity)) return false;
    this.values.add(identity);
    this.order.push(identity);
    if (this.order.length > MAX_RECENT_EVENTS) {
      const expired = this.order.shift();
      if (expired !== undefined) this.values.delete(expired);
    }
    return true;
  }
}

function nextEvent(
  iterator: AsyncIterator<OpenCodeSseEvent>,
): Promise<IteratorResult<OpenCodeSseEvent>> {
  const pending = iterator.next();
  void pending.catch(() => undefined);
  return pending;
}

async function waitForServerConnected(
  pending: Promise<IteratorResult<OpenCodeSseEvent>>,
): Promise<void> {
  const item = await pending;
  if (item.done) throw new Error('OpenCode event stream closed before its handshake.');
  let value: unknown;
  try {
    value = JSON.parse(item.value.data) as unknown;
  } catch {
    throw new Error('OpenCode event stream returned an invalid handshake.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('type' in value) ||
    value.type !== 'server.connected'
  ) {
    throw new Error('OpenCode event stream did not confirm its handshake.');
  }
}

export class OpenCodeHarness implements VibeSpaceHarness {
  private readonly controllers = new Set<AbortController>();
  private readonly sessionDirectories = new Map<string, string>();
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: (attempt: number) => Promise<void>;
  private readonly qwenEndpoint: () => string | undefined;
  private readonly providerCatalogTimeoutMs: number;
  private appliedQwenEndpoint?: Readonly<{ generation: string; endpoint: string }>;
  private providerCache?: Readonly<{
    generation: string;
    providers: readonly HarnessProvider[];
    fetchedAt: number;
  }>;
  private providerFlight?: Promise<readonly HarnessProvider[]>;
  private disposed = false;

  constructor(
    private readonly runtime: HarnessRuntimeManager = harnessRuntimeManager,
    private readonly options: OpenCodeHarnessOptions = {},
  ) {
    this.maxReconnectAttempts = Math.max(0, Math.min(5, options.maxReconnectAttempts ?? 2));
    this.reconnectDelay =
      options.reconnectDelay ??
      ((attempt) => new Promise((resolve) => setTimeout(resolve, Math.min(1_000, attempt * 150))));
    this.qwenEndpoint = options.qwenEndpoint ?? verifiedQwenCompatibleBaseUrl;
    this.providerCatalogTimeoutMs = Math.max(
      0,
      Math.min(10_000, options.providerCatalogTimeoutMs ?? DEFAULT_PROVIDER_CATALOG_TIMEOUT_MS),
    );
  }

  private connection(): OpenCodeServerConnection {
    const connection = this.runtime.getConnection();
    if (!connection) {
      throw new HarnessError({
        code: 'HARNESS_HEALTH_FAILED',
        message: 'The private OpenCode server is not ready.',
        repair: 'Retry after the harness finishes starting.',
        recoverable: true,
      });
    }
    return connection;
  }

  private client(connection = this.connection()): OpenCodeHttpClient {
    return createOpenCodeHttpClient(connection, { fetch: this.options.fetch });
  }

  private async ensureQwenEndpoint(
    providerId: string,
    connection: OpenCodeServerConnection,
    client: OpenCodeHttpClient,
  ): Promise<void> {
    if (providerId !== 'qwen') return;
    const endpoint = this.qwenEndpoint();
    if (!endpoint) {
      throw new HarnessError({
        code: 'PROVIDER_NOT_CONFIGURED',
        message: 'Qwen has no endpoint authenticated by the current credential.',
        repair: 'Save a valid Qwen credential and wait for its authenticated endpoint probe.',
        recoverable: true,
      });
    }
    if (
      this.appliedQwenEndpoint?.generation === connection.generation &&
      this.appliedQwenEndpoint.endpoint === endpoint
    ) {
      return;
    }
    await client.configureQwenEndpoint(endpoint);
    this.appliedQwenEndpoint = Object.freeze({ generation: connection.generation, endpoint });
  }

  async ensureReady(): Promise<HarnessReady> {
    if (this.disposed) throw new Error('OpenCode harness is disposed.');
    if (!this.runtime.getConnection()) await this.runtime.refresh();
    const connection = this.connection();
    return { source: connection.source, version: connection.version };
  }

  private cachedProviders(generation: string): readonly HarnessProvider[] | undefined {
    if (
      !this.providerCache ||
      this.providerCache.generation !== generation ||
      Date.now() - this.providerCache.fetchedAt > PROVIDER_CATALOG_TTL_MS
    ) {
      return undefined;
    }
    return this.providerCache.providers;
  }

  private async refreshProviders(): Promise<readonly HarnessProvider[]> {
    if (this.providerFlight) return this.providerFlight;
    const connection = this.connection();
    this.providerFlight = this.client(connection)
      .configProviders()
      .then((raw) => {
        const providers = parseOpenCodeProviderResponse(raw);
        this.providerCache = Object.freeze({
          generation: connection.generation,
          providers,
          fetchedAt: Date.now(),
        });
        return providers;
      })
      .finally(() => {
        this.providerFlight = undefined;
      });
    return this.providerFlight;
  }

  private async resolveSelectionForSend(
    selection: HarnessSendRequest['selection'],
  ): Promise<ReturnType<typeof resolveOpenCodeSelection>> {
    const connection = this.connection();
    const cached = this.cachedProviders(connection.generation);
    if (cached && catalogContainsSelection(selection, cached)) {
      return resolveOpenCodeSelection(selection, cached);
    }
    const refresh = this.refreshProviders();
    const raced = await Promise.race([
      refresh.then((providers) => ({ ok: true as const, providers })),
      new Promise<{ ok: false }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), this.providerCatalogTimeoutMs);
      }),
    ]);
    if (raced.ok) return resolveOpenCodeSelection(selection, raced.providers);
    if (cached && catalogContainsSelection(selection, cached)) {
      return resolveOpenCodeSelection(selection, cached);
    }
    return resolveOpenCodeSelection(selection, [
      ...(cached ?? []),
      ...trustedCatalogForSelection(selection),
    ]);
  }

  async createSession(input: CreateHarnessSession): Promise<HarnessSession> {
    await this.ensureReady();
    const session = await this.client().createSession(
      {
        ...(input.title ? { title: input.title } : {}),
        ...(input.parentSessionId ? { parentID: input.parentSessionId } : {}),
      },
      input.workingDirectory,
    );
    if (input.workingDirectory) this.sessionDirectories.set(session.id, input.workingDirectory);
    return {
      id: session.id,
      chatId: input.chatId,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    };
  }

  async deleteSession(sessionId: string, workingDirectory?: string): Promise<void> {
    const directory = workingDirectory ?? this.sessionDirectories.get(sessionId);
    await this.client().deleteSession(sessionId, directory);
    this.sessionDirectories.delete(sessionId);
  }

  async *send(input: HarnessSendRequest): AsyncIterable<HarnessEvent> {
    await this.ensureReady();
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) controller.abort();
    this.controllers.add(controller);

    let connection = this.connection();
    let client = this.client(connection);
    let promptSubmitted = false;
    let terminal = false;
    let reconnects = 0;
    const recent = new RecentEventSet();
    const workingDirectory = input.workingDirectory ?? this.sessionDirectories.get(input.sessionId);
    const fullTextSnapshots: FullTextSnapshotState = {
      assistantMessageIds: new Set(),
      textPartsByMessage: new Map(),
    };
    let streamedAssistantText = '';

    try {
      await this.ensureQwenEndpoint(input.selection.providerId, connection, client);
      const resolvedSelection = await this.resolveSelectionForSend(input.selection);
      let iterator = client.events(controller.signal, workingDirectory)[Symbol.asyncIterator]();
      let pending = nextEvent(iterator);
      await waitForServerConnected(pending);
      pending = nextEvent(iterator);
      if (!controller.signal.aborted) {
        await client.promptAsync(
          input.sessionId,
          {
            model: {
              providerID: resolvedSelection.providerId,
              modelID: resolvedSelection.modelId,
            },
            ...(input.agent ? { agent: input.agent } : {}),
            ...(input.variant ? { variant: input.variant } : {}),
            parts: input.parts,
            ...(input.system ? { system: input.system } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
          },
          controller.signal,
          workingDirectory,
        );
        promptSubmitted = true;
      }

      while (!controller.signal.aborted && !terminal) {
        try {
          const item = await pending;
          if (item.done) throw new Error('OpenCode event stream closed before completion.');
          pending = nextEvent(iterator);
          if (!recent.add(item.value)) continue;

          let raw: unknown;
          try {
            raw = JSON.parse(item.value.data) as unknown;
          } catch {
            continue;
          }
          observeFullTextSnapshot(raw, input.sessionId, fullTextSnapshots);
          const normalized = normalizeOpenCodeEvent(raw, input.sessionId);
          for (const event of normalized) {
            if (event.type === 'assistant.delta') {
              streamedAssistantText += event.text;
            } else if (event.type === 'done') {
              const snapshot = latestAssistantTextSnapshot(fullTextSnapshots);
              if (snapshot.startsWith(streamedAssistantText)) {
                const missingText = snapshot.slice(streamedAssistantText.length);
                if (missingText) {
                  streamedAssistantText += missingText;
                  yield { type: 'assistant.delta', text: missingText };
                }
              }
            }
            yield event;
            if (event.type === 'done' || event.type === 'error') {
              terminal = true;
              break;
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          if (reconnects >= this.maxReconnectAttempts) {
            const detail = safeError(error, connection);
            yield {
              type: 'error',
              code: 'HARNESS_CRASHED',
              message: `OpenCode connection could not be recovered; retry the active turn.${
                detail ? ` ${detail}` : ''
              }`.slice(0, MAX_ERROR_LENGTH),
            };
            terminal = true;
            break;
          }
          reconnects += 1;
          await this.reconnectDelay(reconnects);
          try {
            await this.runtime.refresh();
            connection = this.connection();
            client = this.client(connection);
            await client.getSession(input.sessionId, workingDirectory);
            iterator = client.events(controller.signal, workingDirectory)[Symbol.asyncIterator]();
            pending = nextEvent(iterator);
            await waitForServerConnected(pending);
            pending = nextEvent(iterator);
          } catch (recoveryError) {
            if (reconnects >= this.maxReconnectAttempts) {
              const detail = safeError(recoveryError, connection);
              yield {
                type: 'error',
                code: 'HARNESS_CRASHED',
                message: `OpenCode server recovery failed; retry the active turn.${
                  detail ? ` ${detail}` : ''
                }`.slice(0, MAX_ERROR_LENGTH),
              };
              terminal = true;
            }
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = safeError(error, connection);
        const authFailure = classifyOpenCodeAuthFailure(detail);
        yield {
          type: 'error',
          code:
            authFailure?.code ??
            (error instanceof HarnessError
              ? error.code
              : promptSubmitted
                ? 'HARNESS_CRASHED'
                : 'HARNESS_START_FAILED'),
          message: authFailure?.message ?? detail,
        };
      }
    } finally {
      controller.abort();
      this.controllers.delete(controller);
      input.signal?.removeEventListener('abort', abort);
      if (((promptSubmitted && !terminal) || input.signal?.aborted) && !this.disposed) {
        try {
          await client.abortSession(input.sessionId, workingDirectory);
        } catch {
          // Best effort: the server may be the reason the stream ended.
        }
      }
    }
  }

  async cancel(sessionId: string): Promise<void> {
    this.controllers.forEach((controller) => controller.abort());
    await this.client().abortSession(sessionId, this.sessionDirectories.get(sessionId));
  }

  async listProviders(): Promise<readonly HarnessProvider[]> {
    const cached = this.runtime.getConnection()
      ? this.cachedProviders(this.connection().generation)
      : undefined;
    if (cached) return cached;
    return this.refreshProviders();
  }

  async listModels(providerId?: string): Promise<readonly HarnessModel[]> {
    const providers = await this.listProviders();
    return providerId
      ? (providers.find((provider) => provider.id === providerId)?.models ?? [])
      : providers.flatMap((provider) => provider.models);
  }

  async respondToApproval(input: HarnessApprovalResponse): Promise<void> {
    await this.client().replyPermission(
      input.sessionId,
      input.approvalId,
      input.response,
      this.sessionDirectories.get(input.sessionId),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
    this.sessionDirectories.clear();
    this.appliedQwenEndpoint = undefined;
    const connection = this.runtime.getConnection();
    if (connection) await this.client(connection).disposeInstance();
  }
}

export const openCodeHarness: VibeSpaceHarness = new OpenCodeHarness();
