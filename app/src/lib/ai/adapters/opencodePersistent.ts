import { isTauri } from '@/lib/utils';
import { nativeFetch } from '@/lib/nativeFetch';
import {
  cancelCliBridge,
  probeCliBridge,
  scanCliBridge,
  streamCliBridge,
  type DetectedExecutable,
} from './cliBridge';
import { openCodeDiagnosticCliAdapter } from './opencode';
import type {
  AuthProbeResult,
  DetectionResult,
  ProviderAdapter,
  ProviderDiscoveredModel,
  ProviderEvent,
  ProviderRequest,
  UsageSnapshot,
} from './types';
import {
  OpenCodeSessionPool,
  openCodeScopeKey,
  type HarnessScope,
  type OpenCodeClientFactory,
  type OpenCodeRuntimeHandle,
  type OpenCodeRuntimeSupervisor,
  type OpenCodeSessionRegistry,
} from '@/lib/harness/OpenCodeSessionPool';
import {
  OpenCodeSdkSessionClient,
  StrictModelControlPromptAdapter,
  type OpenCodeRawEvent,
  type OpenCodeSdkClientLike,
} from '@/lib/harness/OpenCodeSdkSessionClient';
import { OpenCodeTurnCoordinator } from '@/lib/harness/OpenCodeTurnCoordinator';
import {
  extractOpenCodeTextPartUpdate,
  OpenCodeTextAccumulator,
} from '@/lib/harness/OpenCodeTextAccumulator';
import { OpenCodeTurnGate } from '@/lib/harness/OpenCodeTurnGate';
import { assertObservedModelMatches } from '@/lib/harness/OpenCodeRequestControls';
import { normalizeOpenCodeEvent } from '@/lib/harness/eventNormalizer';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
  type ToolGatewayAuthorityClaim,
} from '@/lib/harness/toolGatewayAuthority';
import type { HarnessApprovalResponse, VibeSpaceApproval } from '@/lib/harness/types';
import {
  MUTATING_TOOL_GATEWAY_TOOLS,
  TOOL_GATEWAY_CATALOG,
} from '@/lib/harness/toolGatewayProtocol';
import type { ChatRuntimeSettings } from '@/features/chat/runtime/chatRuntimeCommandController';
import type {
  LiveModelRuntimeMetadata,
  LiveModelVariant,
} from '@/features/chat/runtime/runtimeModelControls';
import type { AccessLevel, InteractionMode } from '@/lib/permissions/OpenCodePermissionProfile';
import { decideContextRoute } from '@/features/context/rlm/routeDecision';

const HOST = '127.0.0.1';
const MIN_PORT = 41_600;
const PORT_SPAN = 1_200;
const START_ATTEMPTS = 8;
const START_TIMEOUT_MS = 15_000;
const SERVER_LIFETIME_TIMEOUT_MS = 86_400_000;
const SERVER_OUTPUT_LIMIT_BYTES = 1_048_576;
const SESSION_REGISTRY_KEY = 'vibespace.opencode-session-registry.v1';
const AUTH_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_TTL_MS = 60_000;
const MAX_SSE_EVENT_CHARS = 1_048_576;
const MAX_SSE_BUFFER_CHARS = 2_097_152;
const TURN_IDLE_POLL_MS = 500;
const TURN_MAX_WALL_MS = 30 * 60_000;

interface OpenCodeServerHandle extends OpenCodeRuntimeHandle {
  baseUrl: string;
  version: string;
  scope: HarnessScope;
  processRequestId: string;
}

export interface OpenCodeLiveModel {
  id: string;
  label: string;
  providerId: string;
  variants: readonly LiveModelVariant[];
  supportsIndependentReasoningEffort: boolean;
  serviceTiers: readonly string[];
  supportsOpenCodeFastMode: boolean;
}

interface OpenCodeMessageRecord {
  info?: Record<string, unknown>;
  parts?: readonly Record<string, unknown>[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayOfRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(recordOf(item)))
    : [];
}

function cleanIdentifier(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/u.test(clean)) return undefined;
  return clean;
}

function randomId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${id}`.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 120);
}

function stableHash(input: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function portCandidate(attempt: number): number {
  const entropy = globalThis.crypto?.getRandomValues
    ? globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
    : Math.floor(Math.random() * 0xffff_ffff);
  return MIN_PORT + ((entropy + attempt * 97) % PORT_SPAN);
}

function withDirectory(path: string, scope: Readonly<HarnessScope>): string {
  const directory = scope.workingDirectory?.trim();
  if (!directory) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`;
}

async function responseError(response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = (await response.text()).trim().slice(0, 2_048);
  } catch {
    detail = '';
  }
  return new Error(
    `OpenCode server request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''})${detail ? `: ${detail}` : ''}`,
  );
}

async function requestJson(
  baseUrl: string,
  scope: Readonly<HarnessScope>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  const response = await nativeFetch(`${baseUrl}${withDirectory(path, scope)}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    timeoutMs,
  });
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text.trim() ? JSON.parse(text) as unknown : undefined;
}

function unwrapData(value: unknown): unknown {
  const record = recordOf(value);
  return record && 'data' in record ? record.data : value;
}

async function* parseSseResponse(response: Response): AsyncGenerator<OpenCodeRawEvent> {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error('OpenCode event stream response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) throw new Error('OpenCode SSE buffer exceeded its safe bound.');
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0] ?? '\n\n';
        buffer = buffer.slice(boundary + delimiter.length);
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          if (data.length > MAX_SSE_EVENT_CHARS) throw new Error('OpenCode SSE event exceeded its safe bound.');
          const parsed = JSON.parse(data) as unknown;
          const event = recordOf(unwrapData(parsed));
          const type = cleanIdentifier(event?.type, 256);
          if (event && type) yield { type, properties: recordOf(event.properties) };
        }
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class OpenCodeHttpSdk implements OpenCodeSdkClientLike {
  constructor(
    readonly handle: OpenCodeServerHandle,
  ) {}

  readonly global = {
    health: async (): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      '/global/health',
      {},
      5_000,
    ),
  };

  readonly config = {
    providers: async (): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      '/config/providers',
      {},
      15_000,
    ),
  };

  readonly session = {
    create: async (input: { body: { title?: string } }): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      '/session',
      { method: 'POST', body: JSON.stringify(input.body) },
    ),
    get: async (input: { path: { id: string } }): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      `/session/${encodeURIComponent(input.path.id)}`,
    ),
    abort: async (input: { path: { id: string } }): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      `/session/${encodeURIComponent(input.path.id)}/abort`,
      { method: 'POST', body: '{}' },
    ),
    promptAsync: async (input: {
      path: { id: string };
      body: Readonly<Record<string, unknown>>;
    }): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      `/session/${encodeURIComponent(input.path.id)}/prompt_async`,
      { method: 'POST', body: JSON.stringify(input.body) },
      30_000,
    ),
    replyPermission: async (input: {
      path: { id: string; permissionId: string };
      body: { response: HarnessApprovalResponse['response'] };
    }): Promise<unknown> => requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      `/session/${encodeURIComponent(input.path.id)}/permissions/${encodeURIComponent(input.path.permissionId)}`,
      { method: 'POST', body: JSON.stringify(input.body) },
      30_000,
    ),
  };

  readonly event = {
    subscribe: async (): Promise<{ stream: AsyncIterable<OpenCodeRawEvent> }> => ({
      stream: this.events(),
    }),
  };

  async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeRawEvent> {
    const response = await nativeFetch(
      `${this.handle.baseUrl}${withDirectory('/event', this.handle.scope)}`,
      {
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
        signal,
        timeoutMs: 0,
      },
    );
    yield* parseSseResponse(response);
  }

  async status(sessionId: string): Promise<unknown> {
    const all = await requestJson(this.handle.baseUrl, this.handle.scope, '/session/status');
    return recordOf(unwrapData(all))?.[sessionId];
  }

  async messages(sessionId: string): Promise<readonly OpenCodeMessageRecord[]> {
    const value = unwrapData(await requestJson(
      this.handle.baseUrl,
      this.handle.scope,
      `/session/${encodeURIComponent(sessionId)}/message?limit=100`,
    ));
    return Array.isArray(value)
      ? value.map((entry) => recordOf(entry) as OpenCodeMessageRecord).filter(Boolean)
      : [];
  }

  async providerState(): Promise<unknown> {
    return requestJson(this.handle.baseUrl, this.handle.scope, '/provider', {}, 15_000);
  }
}

class PersistentOpenCodeClient extends OpenCodeSdkSessionClient {
  constructor(readonly http: OpenCodeHttpSdk) {
    super(http, new StrictModelControlPromptAdapter());
  }
}

class LocalStorageSessionRegistry implements OpenCodeSessionRegistry {
  private read(): Record<string, Record<string, { sessionId: string; runtimeGeneration: string }>> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_REGISTRY_KEY) ?? '{}') as unknown;
      return recordOf(value) as Record<string, Record<string, { sessionId: string; runtimeGeneration: string }>> ?? {};
    } catch {
      return {};
    }
  }

  private write(value: Record<string, Record<string, { sessionId: string; runtimeGeneration: string }>>): void {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.setItem(SESSION_REGISTRY_KEY, JSON.stringify(value)); } catch { /* best effort */ }
  }

  async load(scopeKey: string, chatId: string) {
    const value = this.read()[scopeKey]?.[chatId];
    return value && cleanIdentifier(value.sessionId) && cleanIdentifier(value.runtimeGeneration)
      ? { sessionId: value.sessionId, runtimeGeneration: value.runtimeGeneration }
      : null;
  }

  async save(scopeKey: string, chatId: string, mapping: { sessionId: string; runtimeGeneration: string }) {
    const all = this.read();
    const scope = { ...(all[scopeKey] ?? {}), [chatId]: mapping };
    all[scopeKey] = Object.fromEntries(Object.entries(scope).slice(-2_000));
    this.write(Object.fromEntries(Object.entries(all).slice(-100)));
  }

  async remove(scopeKey: string, chatId: string) {
    const all = this.read();
    if (all[scopeKey]) delete all[scopeKey]![chatId];
    this.write(all);
  }
}

let executableLoad: Promise<DetectedExecutable> | undefined;
async function findOpenCodeExecutable(): Promise<DetectedExecutable> {
  if (!executableLoad) {
    executableLoad = scanCliBridge({
      executableNames: ['opencode'],
      customPath: null,
      customPathConfirmed: false,
    }).then((result) => {
      const executable = result.executables[0];
      if (!executable) throw new Error('OpenCode is not installed or is not an approved executable.');
      return executable;
    }).catch((error) => {
      executableLoad = undefined;
      throw error;
    });
  }
  return executableLoad;
}

async function healthAt(baseUrl: string, scope: HarnessScope): Promise<{ version: string }> {
  const value = recordOf(unwrapData(await requestJson(baseUrl, scope, '/global/health', {}, 1_500)));
  const version = cleanIdentifier(value?.version, 128);
  if (value?.healthy !== true || !version) throw new Error('OpenCode health response is invalid.');
  return { version };
}

interface SharedOpenCodeServer {
  generation: string;
  baseUrl: string;
  version: string;
  processRequestId: string;
  abort: AbortController;
  monitor: Promise<void>;
  refs: number;
}

class PersistentServerSupervisor implements OpenCodeRuntimeSupervisor {
  private shared: SharedOpenCodeServer | undefined;
  private starting: Promise<SharedOpenCodeServer> | undefined;

  private async launch(): Promise<SharedOpenCodeServer> {
    if (!isTauri) throw new Error('Persistent OpenCode requires the VibeSpace desktop runtime.');
    const executable = await findOpenCodeExecutable();
    const serverScope: HarnessScope = { accountId: 'local-desktop-account' };
    let lastError: unknown;

    for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
      const port = portCandidate(attempt);
      const baseUrl = `http://${HOST}:${port}`;
      const processRequestId = randomId('opencode_server');
      const abort = new AbortController();
      let terminalError: Error | undefined;
      const monitor = (async () => {
        try {
          for await (const event of streamCliBridge({
            requestId: processRequestId,
            executableId: executable.executableId,
            args: [
              'serve',
              '--hostname', HOST,
              '--port', String(port),
              '--cors', 'tauri://localhost',
              '--cors', 'http://localhost:5173',
            ],
            cwd: null,
            stdin: null,
            timeoutMs: SERVER_LIFETIME_TIMEOUT_MS,
            outputLimitBytes: SERVER_OUTPUT_LIMIT_BYTES,
          }, abort.signal)) {
            if (event.status === 'failed' || event.status === 'timedOut') {
              terminalError = new Error(event.data || `OpenCode server ${event.status}.`);
            } else if (event.status === 'completed' && event.exitCode !== 0) {
              terminalError = new Error(`OpenCode server exited with code ${event.exitCode ?? 'unknown'}.`);
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) terminalError = error instanceof Error ? error : new Error(String(error));
        }
      })();

      try {
        const deadline = Date.now() + START_TIMEOUT_MS;
        let healthy: { version: string } | undefined;
        while (Date.now() < deadline) {
          if (terminalError) throw terminalError;
          try {
            healthy = await healthAt(baseUrl, serverScope);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }
        if (!healthy) throw terminalError ?? new Error('OpenCode server did not become healthy.');
        return {
          generation: `opencode:${healthy.version}:${stableHash(executable.executablePath)}`,
          baseUrl,
          version: healthy.version,
          processRequestId,
          abort,
          monitor,
          refs: 0,
        };
      } catch (error) {
        lastError = error;
        abort.abort();
        await cancelCliBridge(processRequestId).catch(() => false);
        await Promise.race([monitor.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('OpenCode server failed to start.');
  }

  private async ensureShared(): Promise<SharedOpenCodeServer> {
    if (this.shared) return this.shared;
    if (!this.starting) {
      this.starting = this.launch()
        .then((server) => {
          this.shared = server;
          return server;
        })
        .finally(() => {
          this.starting = undefined;
        });
    }
    return this.starting;
  }

  private async release(server: SharedOpenCodeServer): Promise<void> {
    server.refs = Math.max(0, server.refs - 1);
    if (server.refs > 0 || this.shared !== server) return;
    this.shared = undefined;
    server.abort.abort();
    await cancelCliBridge(server.processRequestId).catch(() => false);
    await Promise.race([
      server.monitor.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  async start(scope: HarnessScope): Promise<OpenCodeRuntimeHandle> {
    const server = await this.ensureShared();
    server.refs += 1;
    let disposed = false;
    const handle: OpenCodeServerHandle = {
      generation: server.generation,
      baseUrl: server.baseUrl,
      version: server.version,
      scope: { ...scope },
      processRequestId: server.processRequestId,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.release(server);
      },
    };
    return handle;
  }
}

const clientFactory: OpenCodeClientFactory = {
  async connect(handle: OpenCodeRuntimeHandle) {
    const server = handle as OpenCodeServerHandle;
    const client = new PersistentOpenCodeClient(new OpenCodeHttpSdk(server));
    await client.health();
    return client;
  },
};

const sessions = new OpenCodeSessionPool(
  new PersistentServerSupervisor(),
  clientFactory,
  { maxWarmScopes: 2, registry: new LocalStorageSessionRegistry() },
);
const coordinator = new OpenCodeTurnCoordinator(sessions);
const turnGate = new OpenCodeTurnGate();
const activeRequests = new Map<string, { scope: HarnessScope; chatId: string }>();
type ActivePersistentApprovalSession = {
  readonly requestId: string;
  readonly http: OpenCodeHttpSdk;
  readonly approvalIds: Set<string>;
  readonly gatewayAuthority?: ToolGatewayAuthorityClaim;
};
const activeApprovalSessions = new Map<string, ActivePersistentApprovalSession>();
const TOOL_GATEWAY_NAMES = new Set<string>(TOOL_GATEWAY_CATALOG);

export async function respondToPersistentOpenCodeApproval(
  input: Readonly<HarnessApprovalResponse>,
): Promise<void> {
  const sessionId = cleanIdentifier(input.sessionId, 512);
  const approvalId = cleanIdentifier(input.approvalId, 512);
  if (!sessionId || !approvalId) {
    throw new Error('OpenCode approval binding is invalid.');
  }
  const active = activeApprovalSessions.get(sessionId);
  if (!active || !active.approvalIds.has(approvalId)) {
    throw new Error('OpenCode approval session is no longer active.');
  }
  const result = await active.http.session.replyPermission({
    path: { id: sessionId, permissionId: approvalId },
    body: { response: input.response },
  });
  if (unwrapData(result) === false) {
    throw new Error('OpenCode rejected the approval response.');
  }
  active.approvalIds.delete(approvalId);
}

function upstreamProviderId(modelId: string): string {
  const separator = modelId.indexOf('/');
  if (separator <= 0) throw new Error(`OpenCode model “${modelId}” is not provider-qualified.`);
  const providerId = cleanIdentifier(modelId.slice(0, separator), 128);
  if (!providerId) throw new Error('OpenCode model provider is invalid.');
  return providerId;
}

function variantFrom(value: unknown, fallbackId?: string): LiveModelVariant | undefined {
  const record = recordOf(value);
  const id = cleanIdentifier(record?.id ?? fallbackId, 256);
  if (!id) return undefined;
  const normalized = id.toLocaleLowerCase('en-US');
  const effort = cleanIdentifier(record?.reasoningEffort ?? record?.reasoning_effort, 32)
    ?? (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)
      ? normalized
      : undefined);
  const fast = record?.fast === true || normalized === 'fast' || normalized.includes('fast');
  return {
    id,
    ...(cleanIdentifier(record?.label, 256) ? { label: cleanIdentifier(record?.label, 256) } : {}),
    ...(effort ? { reasoningEffort: effort as LiveModelVariant['reasoningEffort'] } : {}),
    ...(fast ? { fast: true } : {}),
    ...(fast && effort ? { kind: 'combined' as const } : fast ? { kind: 'latency' as const } : effort ? { kind: 'reasoning' as const } : {}),
  };
}

function variantsFrom(model: Record<string, unknown>): readonly LiveModelVariant[] {
  const source = model.variants ?? model.variant;
  const variants: LiveModelVariant[] = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      const variant = typeof item === 'string' ? variantFrom({}, item) : variantFrom(item);
      if (variant) variants.push(variant);
    }
  } else {
    const record = recordOf(source);
    for (const [id, value] of Object.entries(record ?? {})) {
      const variant = variantFrom(value, id);
      if (variant) variants.push(variant);
    }
  }
  return [...new Map(variants.map((variant) => [variant.id.toLocaleLowerCase('en-US'), variant])).values()];
}

/** Normalize the live `/config/providers` response without assuming one OpenCode minor-version shape. */
export function parseOpenCodeLiveModels(value: unknown): readonly OpenCodeLiveModel[] {
  const data = recordOf(unwrapData(value));
  const providers = Array.isArray(data?.providers)
    ? arrayOfRecords(data?.providers)
    : Array.isArray(unwrapData(value))
      ? arrayOfRecords(unwrapData(value))
      : [];
  const result: OpenCodeLiveModel[] = [];
  for (const provider of providers) {
    const providerId = cleanIdentifier(provider.id ?? provider.providerID ?? provider.providerId, 128);
    if (!providerId) continue;
    const rawModels = provider.models;
    const entries: Array<[string, Record<string, unknown>]> = Array.isArray(rawModels)
      ? arrayOfRecords(rawModels).map((model) => [cleanIdentifier(model.id ?? model.modelID ?? model.modelId) ?? '', model])
      : Object.entries(recordOf(rawModels) ?? {}).map(([id, model]) => [id, recordOf(model) ?? {}]);
    for (const [rawId, model] of entries) {
      const modelLocalId = cleanIdentifier(model.id ?? model.modelID ?? model.modelId ?? rawId);
      if (!modelLocalId) continue;
      const id = modelLocalId.includes('/') ? modelLocalId : `${providerId}/${modelLocalId}`;
      const label = cleanIdentifier(model.name ?? model.label, 256) ?? id;
      result.push({
        id,
        label,
        providerId,
        variants: variantsFrom(model),
        supportsIndependentReasoningEffort: false,
        serviceTiers: [],
        supportsOpenCodeFastMode: false,
      });
    }
  }
  return [...new Map(result.map((model) => [model.id.toLocaleLowerCase('en-US'), model])).values()]
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function modelMetadata(model: OpenCodeLiveModel): LiveModelRuntimeMetadata {
  return {
    connectionId: 'opencode-cli',
    modelId: model.id,
    variants: model.variants,
    supportsIndependentReasoningEffort: model.supportsIndependentReasoningEffort,
    serviceTiers: model.serviceTiers,
    supportsOpenCodeFastMode: model.supportsOpenCodeFastMode,
  };
}

function statusType(value: unknown): string {
  if (typeof value === 'string') return value.toLocaleLowerCase('en-US');
  const record = recordOf(value);
  return cleanIdentifier(record?.type ?? record?.status, 64)?.toLocaleLowerCase('en-US') ?? '';
}

function eventSessionId(event: OpenCodeRawEvent): string | undefined {
  const properties = event.properties;
  const part = recordOf(properties?.part);
  const info = recordOf(properties?.info ?? properties?.message);
  return cleanIdentifier(
    properties?.sessionID ?? properties?.sessionId ?? part?.sessionID ?? part?.sessionId
      ?? info?.sessionID ?? info?.sessionId,
  );
}

function normalizeToolEvent(event: OpenCodeRawEvent): ProviderEvent | undefined {
  if (event.type !== 'message.part.updated') return undefined;
  const part = recordOf(event.properties?.part);
  if (!part) return undefined;
  const partType = cleanIdentifier(part.type, 64)?.toLocaleLowerCase('en-US');
  if (partType !== 'tool' && partType !== 'tool_use') return undefined;
  const state = recordOf(part.state);
  const rawStatus = cleanIdentifier(state?.status ?? part.status, 64)?.toLocaleLowerCase('en-US');
  const status = rawStatus === 'completed' ? 'completed' : rawStatus === 'error' || rawStatus === 'failed' ? 'failed' : 'started';
  const name = cleanIdentifier(part.tool ?? part.name, 256);
  if (!name) return undefined;
  return {
    type: 'tool',
    name,
    status,
    ...(cleanIdentifier(part.callID ?? part.callId ?? part.id) ? { callId: cleanIdentifier(part.callID ?? part.callId ?? part.id) } : {}),
    ...(status === 'completed' && state && 'output' in state ? { result: state.output } : {}),
  };
}

function normalizeUsage(event: OpenCodeRawEvent): UsageSnapshot | undefined {
  if (event.type !== 'message.updated') return undefined;
  const info = recordOf(event.properties?.info ?? event.properties?.message);
  const tokens = recordOf(info?.tokens ?? info?.usage);
  if (!tokens && typeof info?.cost !== 'number') return undefined;
  const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = number(tokens?.input ?? tokens?.inputTokens ?? tokens?.input_tokens);
  const output = number(tokens?.output ?? tokens?.outputTokens ?? tokens?.output_tokens);
  const cost = number(info?.cost ?? tokens?.cost);
  return {
    capturedAt: Date.now(),
    ...(input === undefined ? {} : { inputTokens: { value: input, provenance: 'provider-reported' as const } }),
    ...(output === undefined ? {} : { outputTokens: { value: output, provenance: 'provider-reported' as const } }),
    ...(cost === undefined ? {} : { costUsd: { value: cost, provenance: 'provider-reported' as const } }),
  };
}

function observedIdentity(event: OpenCodeRawEvent): { providerId?: string; modelId?: string; variant?: string } {
  const properties = event.properties;
  const part = recordOf(properties?.part);
  const info = recordOf(properties?.info ?? properties?.message);
  return {
    providerId: cleanIdentifier(info?.providerID ?? info?.providerId ?? part?.providerID ?? part?.providerId),
    modelId: cleanIdentifier(info?.modelID ?? info?.modelId ?? part?.modelID ?? part?.modelId),
    variant: cleanIdentifier(info?.variant ?? part?.variant),
  };
}

function assistantTextFromMessages(messages: readonly OpenCodeMessageRecord[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index];
    const role = cleanIdentifier(record.info?.role, 32)?.toLocaleLowerCase('en-US');
    if (role !== 'assistant') continue;
    return (record.parts ?? [])
      .filter((part) => ['text', 'agent_message'].includes(String(part.type).toLocaleLowerCase('en-US')))
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .join('');
  }
  return '';
}

let modelCache: { loadedAt: number; models: readonly OpenCodeLiveModel[] } | undefined;
let modelLoad: Promise<readonly OpenCodeLiveModel[]> | undefined;

async function liveModels(scope: HarnessScope, force = false): Promise<readonly OpenCodeLiveModel[]> {
  if (!force && modelCache && Date.now() - modelCache.loadedAt < MODEL_CACHE_TTL_MS) return modelCache.models;
  if (!force && modelLoad) return modelLoad;
  modelLoad = (async () => {
    try {
      const entry = await sessions.clientForScope(scope);
      const client = entry.client as PersistentOpenCodeClient;
      const models = parseOpenCodeLiveModels(await client.listProviders());
      if (models.length > 0) modelCache = { loadedAt: Date.now(), models };
      return models.length > 0 ? models : modelCache?.models ?? [];
    } finally {
      modelLoad = undefined;
    }
  })();
  return modelLoad;
}

const authCache = new Map<string, { loadedAt: number; result: AuthProbeResult }>();
const authLoads = new Map<string, Promise<AuthProbeResult>>();
async function cachedAuthProbe(connection: ProviderRequest['connection']): Promise<AuthProbeResult> {
  const cached = authCache.get(connection.id);
  if (cached && Date.now() - cached.loadedAt < AUTH_CACHE_TTL_MS) return cached.result;
  const active = authLoads.get(connection.id);
  if (active) return active;
  const load: Promise<AuthProbeResult> = (async (): Promise<AuthProbeResult> => {
    try {
      const result = await openCodeDiagnosticCliAdapter.probeAuth?.(connection)
        ?? { status: 'unknown' as const, detail: 'OpenCode authentication probe is unavailable.' };
      // A timeout/unknown probe is not an authoritative sign-out and must not
      // erase the last verified authenticated snapshot.
      if (result.status === 'unknown' && cached?.result.status === 'authenticated') {
        return {
          ...cached.result,
          detail: result.detail
            ? `${cached.result.detail ?? 'Last verified authentication retained.'} ${result.detail}`
            : cached.result.detail,
        };
      }
      authCache.set(connection.id, { loadedAt: Date.now(), result });
      return result;
    } catch (error) {
      if (cached) return cached.result;
      return { status: 'unknown' as const, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      authLoads.delete(connection.id);
    }
  })();
  authLoads.set(connection.id, load);
  return load;
}

function requestScope(request: ProviderRequest): HarnessScope {
  const accountId = cleanIdentifier(request.accountId, 512);
  const workspaceId = cleanIdentifier(request.workspaceId, 512);
  if (!accountId || !workspaceId) {
    throw new Error('OpenCode requires an exact account and workspace scope.');
  }
  return {
    accountId,
    workspaceId,
    ...(cleanIdentifier(request.projectId, 512) ? { projectId: request.projectId!.trim() } : {}),
    ...(cleanIdentifier(request.worktreeId, 512) ? { worktreeId: request.worktreeId!.trim() } : {}),
    ...(request.workingDirectory?.trim() ? { workingDirectory: request.workingDirectory.trim() } : {}),
  };
}

function enabledGatewayTools(request: Readonly<ProviderRequest>): readonly string[] {
  return Object.entries(request.tools ?? {})
    .filter(([name, enabled]) => enabled === true && TOOL_GATEWAY_NAMES.has(name))
    .map(([name]) => name);
}

function captureRequestGatewayAuthority(
  request: Readonly<ProviderRequest>,
): ToolGatewayAuthorityClaim | undefined {
  if (enabledGatewayTools(request).length === 0) return undefined;
  const claim = captureToolGatewayAuthorityClaim();
  const accountId = cleanIdentifier(request.accountId, 512);
  const workspaceId = cleanIdentifier(request.workspaceId, 512);
  const projectId = cleanIdentifier(request.projectId, 512) ?? null;
  if (
    !claim ||
    !accountId ||
    !workspaceId ||
    claim.scope.accountId !== accountId ||
    claim.scope.workspaceId !== workspaceId ||
    claim.scope.projectId !== projectId
  ) {
    throw new Error('Tool Gateway authority does not match the active account/workspace scope.');
  }
  return claim;
}

function defaultRuntimeSettings(request: ProviderRequest): ChatRuntimeSettings {
  return request.runtimeSettings ?? {
    effort: 'auto',
    fastMode: 'auto',
    performance: 'quality',
    rlmEnabled: true,
  };
}

function contextSystemAddendum(
  request: Readonly<ProviderRequest>,
  settings: Readonly<ChatRuntimeSettings>,
): string {
  const question = request.prompt.trim();
  const historical = /\b(previous|history|old|earlier|decision|archive|look up|find in)\b/iu.test(question);
  const broad = /\b(entire|whole|everything|every file|every chat|across all|root cause)\b/iu.test(question);
  const route = decideContextRoute({
    rlmEnabled: settings.rlmEnabled,
    question,
    activeFileTask: Boolean(request.workingDirectory) && !historical && !broad,
    answerPresentInCurrentTurn: false,
    estimatedScopeBytes: 0,
    sourceFamilies: request.workingDirectory ? ['project'] : [],
    explicitHistoricalLookup: historical,
    explicitWholeProjectRequest: broad,
    performanceProfile: settings.performance,
  });
  if (route.route === 'direct') {
    return 'VibeSpace Context route: DIRECT. Use only the current approved prompt/context; do not start recursive retrieval.';
  }
  return [
    `VibeSpace Context route: ${route.route.toUpperCase()}.`,
    'Before asserting historical or cross-source facts, use the high-level VibeSpace tool `vibespace_context.query`.',
    'Treat returned pointers/provenance as opaque and fail closed: never forge, combine, clamp, or retarget pointers.',
    'If the tool is unavailable or returns no evidence, say so instead of inventing support.',
  ].join(' ');
}

function combineSystemPrompt(base: string | undefined, addendum: string): string {
  const clean = base?.trim();
  return clean ? `${clean}\n\n${addendum}` : addendum;
}

function toolsForPolicy(input: {
  mode: InteractionMode;
  access: AccessLevel;
  rlmEnabled: boolean;
  requested?: Readonly<Record<string, boolean>>;
}): Readonly<Record<string, boolean>> {
  const canWrite = input.access !== 'read-only';
  const canTerminal = input.access === 'full';
  const canSubagents = input.mode === 'agent';
  const baseline: Record<string, boolean> = {
    read: true,
    glob: true,
    grep: true,
    list: true,
    webfetch: true,
    websearch: true,
    edit: canWrite,
    write: canWrite,
    patch: canWrite,
    bash: canTerminal,
    shell: canTerminal,
    task: canSubagents,
    'vibespace_context.query': input.rlmEnabled,
  };
  if (!input.requested) return Object.freeze(baseline);

  const bounded: Record<string, boolean> = { ...baseline };
  for (const [name, enabled] of Object.entries(input.requested).slice(0, 512)) {
    if (!TOOL_GATEWAY_NAMES.has(name)) continue;
    const mutating = MUTATING_TOOL_GATEWAY_TOOLS.has(name as never);
    const terminalLike = name.startsWith('terminal.') || name === 'command.run';
    const subagentLike = name.startsWith('agent.') || name.startsWith('task.');
    bounded[name] =
      enabled === true &&
      (!mutating || canWrite) &&
      (!terminalLike || canTerminal) &&
      (!subagentLike || canSubagents);
  }
  bounded['vibespace_context.query'] =
    input.rlmEnabled && input.requested.vibespace_context === true;
  return Object.freeze(bounded);
}

async function* sendPersistent(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  const modelId = request.modelId?.trim();
  if (!modelId) throw new Error('OpenCode requires an exact model selection.');
  const scope = requestScope(request);
  const gatewayAuthority = captureRequestGatewayAuthority(request);
  const chatId = request.chatId?.trim() || request.sessionId?.trim() || request.requestId;
  const turn = turnGate.begin(chatId, request.requestId);
  activeRequests.set(request.requestId, { scope, chatId });
  const abortEvents = new AbortController();
  let boundSessionId: string | undefined;
  const abort = () => {
    turnGate.cancel(chatId);
    abortEvents.abort();
    void sessions.cancelChat(scope, chatId).catch(() => undefined);
  };
  request.signal?.addEventListener('abort', abort, { once: true });

  try {
    const session = await sessions.sessionForChat(scope, chatId);
    const client = session.client as PersistentOpenCodeClient;
    const models = await liveModels(scope);
    const liveModel = models.find((candidate) => candidate.id.toLocaleLowerCase('en-US') === modelId.toLocaleLowerCase('en-US'));
    if (!liveModel) throw new Error(`OpenCode model “${modelId}” is not present in the live authenticated catalog.`);
    const providerId = upstreamProviderId(modelId);
    const mode = request.interactionMode ?? 'agent';
    const access = request.accessLevel ?? (mode === 'ask' ? 'read-only' : mode === 'plan' ? 'read-only' : 'full');
    const eventIterator = client.http.events(abortEvents.signal)[Symbol.asyncIterator]();
    const settings = defaultRuntimeSettings(request);
    const systemPrompt = combineSystemPrompt(request.systemPrompt, contextSystemAddendum(request, settings));
    const dispatch = await coordinator.dispatch({
      scope,
      chatId,
      text: request.prompt,
      settings,
      selection: {
        connectionId: request.connection.id,
        providerId,
        modelId,
        metadata: modelMetadata(liveModel),
      },
      policy: {
        mode,
        access,
        approveAllForRun: request.approveAllForRun === true,
        projectRoot: scope.workingDirectory ?? request.workingDirectory ?? '.',
      },
      system: systemPrompt,
      tools: toolsForPolicy({
        mode,
        access,
        rlmEnabled: settings.rlmEnabled,
        requested: request.tools,
      }),
    });
    if (dispatch.kind === 'command') throw new Error('VibeSpace slash commands must be consumed before provider dispatch.');
    if (dispatch.kind === 'rejected') throw new Error(dispatch.message);
    boundSessionId = dispatch.sessionId;
    if (gatewayAuthority && !bindToolGatewaySessionAuthority(dispatch.sessionId, gatewayAuthority)) {
      await client.abort(dispatch.sessionId).catch(() => undefined);
      throw new Error('Tool Gateway session authority changed before dispatch.');
    }
    activeApprovalSessions.set(dispatch.sessionId, {
      requestId: request.requestId,
      http: client.http,
      approvalIds: new Set<string>(),
      ...(gatewayAuthority ? { gatewayAuthority } : {}),
    });
    await request.onSessionBound?.({ sessionId: dispatch.sessionId });
    yield { type: 'session', sessionId: dispatch.sessionId };

    const accumulator = new OpenCodeTextAccumulator();
    let emittedText = '';
    let observed = false;
    let done = false;
    let finishReason = 'stop';
    const startedAt = Date.now();
    let pendingEvent = eventIterator.next();

    while (!done) {
      if (!turnGate.isCurrent(turn)) throw new DOMException('The OpenCode turn was superseded.', 'AbortError');
      if (request.signal?.aborted) throw new DOMException('The OpenCode turn was aborted.', 'AbortError');
      if (Date.now() - startedAt > TURN_MAX_WALL_MS) {
        await client.abort(dispatch.sessionId).catch(() => undefined);
        throw new Error('OpenCode turn exceeded the maximum wall time.');
      }

      const next = await Promise.race([
        pendingEvent.then((value) => ({ kind: 'event' as const, value })),
        new Promise<{ kind: 'poll' }>((resolve) => setTimeout(() => resolve({ kind: 'poll' }), TURN_IDLE_POLL_MS)),
      ]);
      if (next.kind === 'poll') {
        const status = statusType(await client.http.status(dispatch.sessionId).catch(() => undefined));
        if (status === 'idle') {
          const canonical = assistantTextFromMessages(await client.http.messages(dispatch.sessionId).catch(() => []));
          if (canonical && canonical !== emittedText) {
            const delta = canonical.startsWith(emittedText) ? canonical.slice(emittedText.length) : canonical;
            if (delta) {
              request.onResponseObservation?.({ kind: 'bytes', byteLength: new TextEncoder().encode(delta).byteLength, observedAt: Date.now() });
              yield { type: 'text', delta };
              emittedText = canonical;
            }
          }
          done = true;
        }
        continue;
      }
      if (next.value.done) throw new Error('OpenCode event stream ended before the session completed.');
      const event = next.value.value;
      pendingEvent = eventIterator.next();
      const eventScope = eventSessionId(event);
      if (eventScope && eventScope !== dispatch.sessionId) continue;

      for (const normalized of normalizeOpenCodeEvent(event, dispatch.sessionId)) {
        if (normalized.type !== 'approval.requested') continue;
        const active = activeApprovalSessions.get(dispatch.sessionId);
        if (!active || active.requestId !== request.requestId) {
          await client.abort(dispatch.sessionId).catch(() => undefined);
          throw new Error('OpenCode approval arrived outside the active request binding.');
        }
        if (active.approvalIds.has(normalized.approval.id)) continue;
        active.approvalIds.add(normalized.approval.id);
        if (!request.onApprovalRequested) {
          await respondToPersistentOpenCodeApproval({
            sessionId: dispatch.sessionId,
            approvalId: normalized.approval.id,
            response: 'reject',
          }).catch(() => undefined);
          throw new Error('OpenCode requested approval without an active approval handler.');
        }
        await request.onApprovalRequested(normalized.approval);
      }

      const identity = observedIdentity(event);
      if (identity.modelId) {
        const observedModelId = identity.modelId.includes('/')
          ? identity.modelId
          : `${identity.providerId ?? providerId}/${identity.modelId}`;
        assertObservedModelMatches({
          requested: {
            connectionId: request.connection.id,
            providerId,
            modelId,
            ...(dispatch.controls.variant ? { variant: dispatch.controls.variant } : {}),
          },
          observed: {
            connectionId: request.connection.id,
            providerId: identity.providerId ?? providerId,
            modelId: observedModelId,
            ...(identity.variant ? { variant: identity.variant } : {}),
          },
        });
        if (!observed) {
          observed = true;
          yield { type: 'model', modelId: observedModelId };
        }
      }

      const update = extractOpenCodeTextPartUpdate(event);
      if (update) {
        const emission = accumulator.ingest(update);
        if (emission.kind === 'delta' && emission.channel === 'text' && emission.text) {
          emittedText = accumulator.fullText('text');
          request.onResponseObservation?.({ kind: 'bytes', byteLength: new TextEncoder().encode(emission.text).byteLength, observedAt: Date.now() });
          yield { type: 'text', delta: emission.text };
        } else if (emission.kind === 'replace' && emission.channel === 'text') {
          // The legacy ProviderEvent surface is append-only. Emit only a safe suffix when possible;
          // the final message poll below repairs any non-prefix correction canonically.
          const full = emission.fullText;
          if (full.startsWith(emittedText)) {
            const suffix = full.slice(emittedText.length);
            if (suffix) yield { type: 'text', delta: suffix };
          }
          emittedText = full;
        } else if (emission.kind === 'delta' && emission.channel === 'reasoning' && emission.text) {
          yield { type: 'reasoning', delta: emission.text };
        }
      }
      const tool = normalizeToolEvent(event);
      if (tool) {
        if (tool.type === 'tool' && tool.status === 'started') {
          request.onActionDispatch?.({ observedAt: Date.now() });
        }
        yield tool;
      }
      const usage = normalizeUsage(event);
      if (usage) yield { type: 'usage', usage };
      if (event.type === 'session.error') {
        const message = cleanIdentifier(event.properties?.message ?? recordOf(event.properties?.error)?.message, 2_048)
          ?? 'OpenCode reported a session error.';
        yield { type: 'error', message };
        return;
      }
      if (event.type === 'session.idle') done = true;
      if (event.type === 'session.status') {
        const status = statusType(event.properties?.status);
        if (status === 'idle') done = true;
        if (status === 'error') {
          finishReason = 'error';
          yield { type: 'error', message: 'OpenCode session entered an error state.' };
          return;
        }
      }
    }

    const canonical = assistantTextFromMessages(await client.http.messages(dispatch.sessionId).catch(() => []));
    if (canonical && canonical !== emittedText) {
      const delta = canonical.startsWith(emittedText) ? canonical.slice(emittedText.length) : canonical;
      if (delta) yield { type: 'text', delta };
    }
    yield { type: 'done', finishReason };
  } finally {
    request.signal?.removeEventListener('abort', abort);
    abortEvents.abort();
    if (boundSessionId) {
      const active = activeApprovalSessions.get(boundSessionId);
      if (active?.requestId === request.requestId) {
        activeApprovalSessions.delete(boundSessionId);
      }
      releaseToolGatewaySessionAuthority(boundSessionId);
    }
    turnGate.finish(turn);
    activeRequests.delete(request.requestId);
  }
}

async function detectPersistent(): Promise<DetectionResult> {
  if (!isTauri) return { status: 'unavailable', detail: 'OpenCode is available in the VibeSpace desktop app.' };
  try {
    const executable = await findOpenCodeExecutable();
    const probe = await probeCliBridge({
      executableId: executable.executableId,
      args: ['--version'],
      timeoutMs: 3_000,
      outputLimitBytes: 16_384,
    });
    if (probe.timedOut || probe.exitCode !== 0) return { status: 'requires_attention', detail: 'OpenCode did not pass its version probe.' };
    return { status: 'available', version: probe.stdout.data.trim(), executablePath: executable.executablePath };
  } catch (error) {
    return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
}

const catalogScope: HarnessScope = { accountId: 'local-desktop-account' };

export const openCodePersistentAdapter: ProviderAdapter = Object.freeze({
  id: 'opencode-cli',
  detect: detectPersistent,
  probeAuth: (connection: ProviderRequest['connection']) => cachedAuthProbe(connection),
  listModels: async () => {
    try {
      const models = await liveModels(catalogScope);
      if (models.length > 0) {
        return models.map((model) => ({
          id: model.id,
          label: model.label,
          variants: model.variants.map((variant) => variant.id),
        }));
      }
    } catch {
      // Model discovery is allowed to use the guarded one-shot diagnostic probe;
      // normal chat transport never does.
    }
    return openCodeDiagnosticCliAdapter.listModels?.() ?? [];
  },
  send: (request: ProviderRequest) => sendPersistent(request),
  cancel: async (requestId: string) => {
    const active = activeRequests.get(requestId);
    if (!active) return;
    turnGate.cancel(active.chatId);
    await sessions.cancelChat(active.scope, active.chatId);
  },
});

export function invalidateOpenCodePersistentModelCache(): void {
  modelCache = undefined;
}

export async function disposeOpenCodePersistentRuntimes(): Promise<void> {
  activeRequests.clear();
  for (const sessionId of activeApprovalSessions.keys()) {
    releaseToolGatewaySessionAuthority(sessionId);
  }
  activeApprovalSessions.clear();
  turnGate.clear();
  await sessions.disposeAll();
}
