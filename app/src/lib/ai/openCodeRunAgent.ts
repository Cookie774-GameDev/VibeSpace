import type { Agent, ProviderId } from '@/types';
import type { CompiledJarvisPrompt } from '@/lib/jarvis/contracts';
import { openCodeHarness } from '@/lib/harness/openCodeHarness';
import type {
  HarnessEvent,
  HarnessModelSelection,
  HarnessSession,
  NormalizedUsage,
  VibeSpaceApproval,
  VibeSpaceHarness,
} from '@/lib/harness/types';
import {
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
  type ToolGatewayAuthorityClaim,
} from '@/lib/harness/toolGatewayAuthority';
import type {
  AiPurpose,
  LLMMessage,
  LLMResponse,
  LLMResponseObservation,
  LLMStreamChunk,
} from './types';
import {
  assertProductionOpenCodeSend,
  resolveProductionWorkingDirectory,
} from './openCodeProductionTransport';
import { classifyOpenCodeAuthFailure, HarnessError } from '@/lib/harness/errors';

const MAX_SESSIONS = 128;
const MAX_SCOPE_ID = 512;
const MAX_PROMPT_TEXT = 1_500_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]{1,64}$/;

interface SessionRecord {
  session: HarnessSession;
  messageCount: number;
  messageFingerprints: readonly string[];
  parentScopeId?: string;
  workingDirectory?: string;
  touchedAt: number;
}

export interface OpenCodeRunAgentInput {
  agent: Agent;
  messages: readonly LLMMessage[];
  selection: HarnessModelSelection;
  variant?: string;
  scopeId: string;
  parentScopeId?: string;
  purpose?: AiPurpose;
  signal?: AbortSignal;
  onChunk?: (chunk: LLMStreamChunk) => void;
  workingDirectory?: string;
  compiledPrompt?: Readonly<CompiledJarvisPrompt>;
  onResponseObservation?: (observation: LLMResponseObservation) => void;
  onActionDispatch?: (input: { observedAt: number }) => void;
  onApprovalRequested?: (approval: VibeSpaceApproval) => void | Promise<void>;
  onSessionBound?: (binding: {
    sessionId: string;
    parentSessionId?: string;
  }) => void | Promise<void>;
  onCompletionEvidence?: (evidence: OpenCodeCompletionEvidence) => void;
  tools?: Readonly<Record<string, boolean>>;
}

export interface OpenCodeCompletionEvidence {
  readonly observedAt: number;
  readonly usageEventObserved: true;
  readonly sessionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly usage: Readonly<NormalizedUsage>;
}

export interface OpenCodeRunAgentAdapter {
  run(input: OpenCodeRunAgentInput): Promise<LLMResponse>;
  clear(): Promise<void>;
}

export interface OpenCodeSessionAuthorityPort {
  capture(): ToolGatewayAuthorityClaim | null;
  bind(sessionId: string, expected: ToolGatewayAuthorityClaim): boolean;
  release(sessionId: string): void;
}

const productionSessionAuthority: OpenCodeSessionAuthorityPort = {
  capture: captureToolGatewayAuthorityClaim,
  bind: bindToolGatewaySessionAuthority,
  release: releaseToolGatewaySessionAuthority,
};

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError');
}

function normalizeScopeId(value: string): string {
  const scope = value.trim();
  if (!scope || scope.length > MAX_SCOPE_ID || /[\u0000-\u001f\u007f]/.test(scope)) {
    throw new Error('OpenCode session scope is invalid.');
  }
  return scope;
}

function validateWorkingDirectory(value: string | undefined): string {
  return resolveProductionWorkingDirectory(value);
}

function roleLabel(role: LLMMessage['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'system') return 'System';
  return 'User';
}

function promptParts(messages: readonly LLMMessage[]): readonly unknown[] {
  const textSegments: string[] = [];
  const files: Array<{ type: 'file'; mime: string; url: string; filename?: string }> = [];

  for (const message of messages) {
    const textParts: string[] = [];
    if (typeof message.content === 'string') {
      textParts.push(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          textParts.push(part.text);
          continue;
        }
        const data = part.data.trim();
        const mime = part.mimeType.trim().toLowerCase();
        const approximateBytes = Math.floor((data.length * 3) / 4);
        if (
          !data ||
          data.length % 4 !== 0 ||
          !BASE64_RE.test(data) ||
          approximateBytes > MAX_IMAGE_BYTES ||
          !IMAGE_MIME_RE.test(mime)
        ) {
          throw new Error('The image attachment is invalid or exceeds the safe size limit.');
        }
        const filename = part.name
          ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim()
          .slice(0, 512);
        files.push({
          type: 'file',
          mime,
          url: `data:${mime};base64,${data}`,
          ...(filename ? { filename } : {}),
        });
      }
    }
    if (textParts.length) textSegments.push(`${roleLabel(message.role)}: ${textParts.join('\n')}`);
  }

  const text = textSegments.join('\n\n');
  if (text.length > MAX_PROMPT_TEXT) {
    throw new Error('The OpenCode prompt exceeds the safe transport size limit.');
  }
  return [...(text ? [{ type: 'text', text }] : []), ...files];
}

function runtimeProviderId(providerId: string): string {
  if (providerId === 'local') return 'ollama';
  if (providerId === 'bedrock') return 'amazon-bedrock';
  return providerId;
}

async function fingerprintMessage(message: LLMMessage): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([message.role, message.content]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function eventDispatchesAction(event: HarnessEvent): boolean {
  return (
    event.type === 'file.read' ||
    event.type === 'file.changed' ||
    event.type === 'search.started' ||
    event.type === 'shell.started' ||
    event.type === 'tool.started' ||
    event.type === 'subagent.started'
  );
}

function usageValue(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function observedUsage(usage: NormalizedUsage): Readonly<NormalizedUsage> {
  const normalized: NormalizedUsage = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedTokens',
    'reasoningTokens',
    'costUsd',
  ] as const) {
    const value = usage[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('OpenCode reported invalid usage telemetry.');
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

export function createOpenCodeRunAgentAdapter(
  harness: VibeSpaceHarness = openCodeHarness,
  authority: OpenCodeSessionAuthorityPort = productionSessionAuthority,
): OpenCodeRunAgentAdapter {
  const sessions = new Map<string, SessionRecord>();

  const retireScopeTree = async (rootScopeId: string): Promise<void> => {
    const retiredScopes = new Set([rootScopeId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const [scope, record] of sessions) {
        if (record.parentScopeId && retiredScopes.has(record.parentScopeId)) {
          if (!retiredScopes.has(scope)) {
            retiredScopes.add(scope);
            expanded = true;
          }
        }
      }
    }
    const retired = [...sessions.entries()].filter(([scope]) => retiredScopes.has(scope));
    for (const [scope, record] of retired) {
      sessions.delete(scope);
      authority.release(record.session.id);
    }
    await Promise.all(
      retired.map(([, record]) =>
        harness.deleteSession?.(record.session.id, record.workingDirectory).catch(() => undefined),
      ),
    );
  };

  const evictIfNeeded = async (protectedScopes: ReadonlySet<string> = new Set()) => {
    while (sessions.size >= MAX_SESSIONS) {
      const referencedParentIds = new Set(
        [...sessions.values()]
          .map((record) => record.session.parentSessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const oldest = [...sessions.entries()]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
        .find(
          ([scope, record]) =>
            !protectedScopes.has(scope) && !referencedParentIds.has(record.session.id),
        );
      if (!oldest) {
        throw new Error('OpenCode session capacity is reserved by active child relationships.');
      }
      sessions.delete(oldest[0]);
      authority.release(oldest[1].session.id);
      await harness
        .deleteSession?.(oldest[1].session.id, oldest[1].workingDirectory)
        .catch(() => undefined);
    }
  };

  return {
    async run(input) {
      if (input.signal?.aborted) throw abortError();
      const selection: HarnessModelSelection = Object.freeze({
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        ...(input.selection.connectionId ? { connectionId: input.selection.connectionId } : {}),
        ...(input.selection.runtimeProviderId
          ? { runtimeProviderId: input.selection.runtimeProviderId }
          : {}),
      });
      const authorityClaim = authority.capture();
      if (!authorityClaim) throw new Error('OpenCode session authority is unavailable.');
      const scopeId = normalizeScopeId(input.scopeId);
      const parentScopeId =
        input.parentScopeId === undefined ? undefined : normalizeScopeId(input.parentScopeId);
      if (parentScopeId === scopeId) {
        throw new Error('OpenCode child session cannot use itself as its parent.');
      }
      const workingDirectory = validateWorkingDirectory(input.workingDirectory);
      const liveProviders = await harness.listProviders();
      assertProductionOpenCodeSend({
        providers: liveProviders,
        selection,
        variant: input.variant,
      });
      // Validate the complete caller payload before creating any server state.
      promptParts(input.messages);
      const messageFingerprints = await Promise.all(input.messages.map(fingerprintMessage));
      let existing = sessions.get(scopeId);
      if (existing && existing.parentScopeId !== parentScopeId) {
        throw new Error('OpenCode session parent relationship cannot change.');
      }
      let parentSessionId: string | undefined;
      if (parentScopeId) {
        let parent = sessions.get(parentScopeId);
        if (parent && !authority.bind(parent.session.id, authorityClaim)) {
          await retireScopeTree(parentScopeId);
          parent = undefined;
          existing = sessions.get(scopeId);
        }
        if (parent && parent.workingDirectory !== workingDirectory) {
          throw new Error('OpenCode child session working directory does not match its parent.');
        }
        if (!parent) {
          await evictIfNeeded(new Set([scopeId, parentScopeId]));
          const session = await harness.createSession({
            chatId: parentScopeId,
            title: input.agent.name.slice(0, 256),
            ...(workingDirectory ? { workingDirectory } : {}),
          });
          if (!authority.bind(session.id, authorityClaim)) {
            await harness.deleteSession?.(session.id, workingDirectory).catch(() => undefined);
            throw new Error('OpenCode session authority is unavailable.');
          }
          parent = {
            session,
            messageCount: 0,
            messageFingerprints: [],
            ...(workingDirectory ? { workingDirectory } : {}),
            touchedAt: Date.now(),
          };
          sessions.set(parentScopeId, parent);
        }
        parent.touchedAt = Date.now();
        parentSessionId = parent.session.id;
      }
      if (existing && !authority.bind(existing.session.id, authorityClaim)) {
        await retireScopeTree(scopeId);
        existing = undefined;
      }
      const canReuse =
        existing &&
        existing.workingDirectory === workingDirectory &&
        existing.session.parentSessionId === parentSessionId &&
        input.messages.length >= existing.messageCount &&
        existing.messageFingerprints.every(
          (fingerprint, index) => messageFingerprints[index] === fingerprint,
        );
      let record = canReuse ? existing : undefined;
      if (!record) {
        if (existing) {
          sessions.delete(scopeId);
          authority.release(existing.session.id);
          await harness
            .deleteSession?.(existing.session.id, existing.workingDirectory)
            .catch(() => undefined);
        }
        await evictIfNeeded(new Set([...(parentScopeId ? [parentScopeId] : []), scopeId]));
        const session = await harness.createSession({
          chatId: scopeId,
          title: input.agent.name.slice(0, 256),
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
        });
        if (!authority.bind(session.id, authorityClaim)) {
          await harness.deleteSession?.(session.id, workingDirectory).catch(() => undefined);
          throw new Error('OpenCode session authority is unavailable.');
        }
        record = {
          session,
          messageCount: 0,
          messageFingerprints: [],
          ...(parentScopeId ? { parentScopeId } : {}),
          ...(workingDirectory ? { workingDirectory } : {}),
          touchedAt: Date.now(),
        };
        sessions.set(scopeId, record);
      }
      await input.onSessionBound?.({
        sessionId: record.session.id,
        ...(record.session.parentSessionId
          ? { parentSessionId: record.session.parentSessionId }
          : {}),
      });
      if (!authority.bind(record.session.id, authorityClaim)) {
        await retireScopeTree(record.parentScopeId ?? scopeId);
        throw new Error('OpenCode session authority changed.');
      }

      const pendingMessages = input.messages.slice(record.messageCount);
      const parts = promptParts(pendingMessages);
      if (parts.length === 0) throw new Error('OpenCode requires prompt content.');

      let text = '';
      let first = true;
      let usage: NormalizedUsage = {};
      let usageEventObserved = false;
      let finishReason: string | undefined;
      let done = false;
      const expectedProvider =
        selection.runtimeProviderId ?? runtimeProviderId(selection.providerId);

      for await (const event of harness.send({
        sessionId: record.session.id,
        selection,
        ...(input.compiledPrompt ? { agent: 'vibespace' } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        system: input.compiledPrompt?.systemText ?? input.agent.system_prompt,
        parts,
        ...(workingDirectory ? { workingDirectory } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
      })) {
        if (input.signal?.aborted) throw abortError();
        if (eventDispatchesAction(event)) {
          input.onActionDispatch?.({ observedAt: Date.now() });
        }
        if (event.type === 'session.updated' && event.sessionId !== record.session.id) {
          throw new Error('OpenCode reported a different session identity.');
        } else if (event.type === 'assistant.delta') {
          input.onResponseObservation?.({ kind: 'sdk_chunk', observedAt: Date.now() });
          text += event.text;
          input.onChunk?.({ delta: event.text, ...(first ? { first: true } : {}) });
          first = false;
        } else if (event.type === 'approval.requested') {
          await input.onApprovalRequested?.(event.approval);
        } else if (event.type === 'usage.updated') {
          usageEventObserved = true;
          if (
            (event.usage.providerId && event.usage.providerId !== expectedProvider) ||
            (event.usage.modelId && event.usage.modelId !== selection.modelId)
          ) {
            throw new Error(
              'OpenCode reported a model identity different from the exact selection.',
            );
          }
          usage = { ...usage, ...event.usage };
        } else if (event.type === 'done') {
          finishReason = event.finishReason;
          done = true;
          break;
        } else if (event.type === 'error') {
          const authFailure = classifyOpenCodeAuthFailure(event.message);
          if (authFailure || event.code === 'HARNESS_AUTH_FAILED') {
            throw new HarnessError(
              authFailure ?? {
                code: 'HARNESS_AUTH_FAILED',
                message: event.message,
                repair:
                  'Run /connect in OpenCode and sign in with ChatGPT, or switch VibeSpace Chat to a local model.',
                recoverable: true,
              },
            );
          }
          throw new Error(event.message);
        }
      }

      if (input.signal?.aborted) throw abortError();
      if (!done) throw new Error('OpenCode ended without a terminal completion event.');
      if (!usageEventObserved) {
        throw new Error('OpenCode completed without an observed usage event.');
      }
      if (usage.providerId !== expectedProvider || usage.modelId !== selection.modelId) {
        throw new Error('OpenCode completed without exact model identity evidence.');
      }
      const completionUsage = observedUsage(usage);
      const completionEvidence: OpenCodeCompletionEvidence = Object.freeze({
        observedAt: Date.now(),
        usageEventObserved: true,
        sessionId: record.session.id,
        providerId: expectedProvider,
        modelId: selection.modelId,
        usage: completionUsage,
      });
      input.onCompletionEvidence?.(completionEvidence);
      record.messageCount = input.messages.length;
      record.messageFingerprints = messageFingerprints;
      record.touchedAt = Date.now();
      input.onChunk?.({ delta: '', done: true });

      return {
        text,
        usage: {
          input_tokens: usageValue(usage.inputTokens),
          output_tokens: usageValue(usage.outputTokens),
          cost_usd: usageValue(usage.costUsd),
        },
        provider: expectedProvider as ProviderId,
        model: selection.modelId,
        ...(finishReason ? { finish_reason: finishReason } : {}),
      };
    },
    async clear() {
      const records = [...sessions.values()];
      sessions.clear();
      for (const record of records) {
        authority.release(record.session.id);
      }
      await Promise.all(
        records.map((record) =>
          harness
            .deleteSession?.(record.session.id, record.workingDirectory)
            .catch(() => undefined),
        ),
      );
    },
  };
}

export const openCodeRunAgentAdapter = createOpenCodeRunAgentAdapter();
