import { recordOpenCodeToolPolicyReceipt, toolReceiptBinding } from './providerToolSchemaReceipt';
import { openCodeToolDetails } from '../publicToolDetails';
import { selectOpenCodeDispatchPrompt } from './restoredConversationPrompt';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { resolveOpenCodeChildControl } from './openCodeChildControls';
import { newOpenCodeMessageId, sendOpenCodePromptOnce } from './openCodePromptAcceptance';
import { bindCodexQuestionRoute, replyCodexQuestion, replyCodexApproval } from './codexControlBridge';
import { isTauri } from '@/lib/utils';
import { questionEventsWithActivity } from '../openCodeQuestionActivity';
import type {
  AuthProbeResult,
  DetectionResult,
  ProviderAdapter,
  ProviderDiscoveredModel,
  ProviderEvent,
  ProviderQuestionRequest,
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
  type PersistedSessionMapping,
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
import {
  assertObservedModelMatches,
  type OpenCodeRequestControls,
} from '@/lib/harness/OpenCodeRequestControls';
import { normalizeOpenCodeEvent } from '@/lib/harness/eventNormalizer';
import { redactHarnessText } from '@/lib/harness/errors';
import { OpenCodeApprovalAcknowledgements } from '@/lib/harness/OpenCodeApprovalAcknowledgement';
import { recordOpenCodeApprovalStatus } from '@/lib/harness/openCodeApprovalState';
import { nativeShellFailure, projectNativeTaskActivity } from '../openCodeNativeActivity';
import {
  isProviderRateLimitError,
  isProviderUsageLimitError,
  presentProviderError,
  providerErrorDetails,
  ProviderRuntimeError,
} from '../providerError';
import {
  bindToolGatewayObservedExecutionAuthority,
  bindToolGatewaySessionAuthority,
  captureToolGatewayAuthorityClaim,
  releaseToolGatewaySessionAuthority,
  type ToolGatewayAuthorityClaim,
} from '@/lib/harness/toolGatewayAuthority';
import type {
  HarnessApprovalResponse,
  HarnessModelPricing,
  VibeSpaceApproval,
} from '@/lib/harness/types';
import { parseOpenCodeModelPricing } from '@/lib/harness/providerReconciliation';
import {
  MUTATING_TOOL_GATEWAY_TOOLS,
  TOOL_GATEWAY_CATALOG,
} from '@/lib/harness/toolGatewayProtocol';
import type { ChatRuntimeSettings } from '@/features/chat/runtime/chatRuntimeCommandController';
import type { OpenCodeApprovalHarnessRoute } from '@/features/jarvis-interaction/types';
import type {
  LiveModelRuntimeMetadata,
  LiveModelVariant,
} from '@/features/chat/runtime/runtimeModelControls';
import { resolveRuntimeModelControls } from '@/features/chat/runtime/runtimeModelControls';
import { isFastVariant, variantReasoningEffort } from '@/lib/ai/catalog/modelVariants';
import type { AccessLevel, InteractionMode } from '@/lib/permissions/OpenCodePermissionProfile';
import { applySecretPolicy } from '@/lib/security/secretDetector';
import { decideContextRoute } from '@/features/context/rlm/routeDecision';
import { harnessRuntimeManager, type HarnessRuntimeManager } from '@/lib/harness/runtimeManager';
import { nativeOpenCodeEvents, nativeOpenCodeRequest } from '@/lib/harness/openCodeNativeTransport';
import { normalizePortableAbsolutePath } from '@/lib/actions/filePolicy';
import { sanitizeOpenCodeChecklistSnapshot } from '@/lib/ai/openCodeChecklist';
import type { OpenCodeQuestionReplyRoute } from '@/lib/ai/openCodeQuestionProjection';
import type {
  OpenCodeQuestionRequestAuthority,
  OpenCodeQuestionReplyRequest,
  OpenCodeQuestionRejectRequest,
} from '@/lib/ai/openCodeQuestionReply';
import {
  isFailedOpenCodeToolOutput,
  isFailedVibeSpaceContextOutput,
  projectOpenCodePublicTimeline,
} from '@/lib/ai/openCodePublicTimeline';
import {
  executeOpenCodeQuestionRequest,
  type OpenCodeQuestionDispatchReceipt,
} from '@/lib/ai/openCodeQuestionDispatch';

const SESSION_REGISTRY_KEY = 'vibespace.opencode-session-registry.v1';
const ACCEPTED_TURN_REGISTRY_KEY = 'vibespace.opencode-accepted-turns.v1';
const AUTH_CACHE_TTL_MS = 60_000;
const MODEL_CACHE_TTL_MS = 60_000;
// Match the picker's existing failure retry while retaining bounded negative caching.
const EMPTY_MODEL_CACHE_TTL_MS = 15_000;
const TURN_IDLE_POLL_MS = 500;
const TURN_NO_EVIDENCE_GRACE_MS = 2_000;
const TURN_IDLE_FAILED_TOOL_GRACE_MS = 5_000;
const TURN_MAX_WALL_MS = 30 * 60_000;
export const OPENCODE_RATE_LIMIT_RETRY_WINDOW_MS = 60_000;

export function shouldStopOpenCodeRateLimitRetry(
  rateLimitStartedAt: number | undefined,
  now = Date.now(),
  windowMs = OPENCODE_RATE_LIMIT_RETRY_WINDOW_MS,
): boolean {
  return rateLimitStartedAt !== undefined &&
    Number.isFinite(rateLimitStartedAt) &&
    Number.isFinite(now) &&
    now - rateLimitStartedAt >= Math.max(0, windowMs);
}

type PersistentTurnFailureStage =
  | 'request_identity'
  | 'request_scope'
  | 'gateway_authority'
  | 'turn_binding'
  | 'session_binding'
  | 'live_model_authority'
  | 'runtime_controls'
  | 'prompt_dispatch'
  | 'session_authority'
  | 'event_stream'
  | 'context_gateway'
  | 'completion_authority'
  | 'provider_reported';

function reportPersistentTurnFailure(stage: PersistentTurnFailureStage): void {
  // Deliberately exclude the caught error: native/provider failures can carry
  // prompt or credential material. The DevConsole console patcher captures this
  // closed code, which is enough to locate a protected-turn boundary safely.
  console.warn('OpenCode protected turn failed.', { diagnosticCode: stage });
}

export function shouldReportPersistentTurnFailure(error: unknown): boolean {
  return !(
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}

interface OpenCodeServerHandle extends OpenCodeRuntimeHandle {
  version: string;
  scope: HarnessScope;
}

export interface OpenCodeLiveModel {
  id: string;
  label: string;
  providerId: string;
  upstreamModelId: string;
  variants: readonly LiveModelVariant[];
  pricing?: Readonly<HarnessModelPricing>;
  supportsIndependentReasoningEffort: boolean;
  serviceTiers: readonly string[];
  supportsOpenCodeFastMode: boolean;
  isFastRoute?: boolean;
}

export interface OpenCodeMessageRecord {
  info?: Record<string, unknown>;
  parts?: readonly Record<string, unknown>[];
}

const MAX_OPEN_CODE_MESSAGE_BASELINE = 100;

function canonicalOpenCodeMessageId(message: OpenCodeMessageRecord): string | undefined {
  return cleanIdentifier(message.info?.id);
}

function captureOpenCodeMessageBaseline(
  messages: readonly OpenCodeMessageRecord[],
): ReadonlySet<string> {
  if (messages.length > MAX_OPEN_CODE_MESSAGE_BASELINE) {
    throw new Error('OpenCode session history exceeded the bounded current-turn baseline.');
  }
  const ids = new Set<string>();
  for (const message of messages) {
    const id = canonicalOpenCodeMessageId(message);
    if (!id) {
      throw new Error('OpenCode session history lacks canonical message identity.');
    }
    ids.add(id);
  }
  return ids;
}

export function currentTurnOpenCodeMessages(
  messages: readonly OpenCodeMessageRecord[],
  baselineMessageIds: ReadonlySet<string>,
): readonly OpenCodeMessageRecord[] {
  return messages.filter((message) => {
    const id = canonicalOpenCodeMessageId(message);
    return Boolean(id && !baselineMessageIds.has(id));
  });
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

function cleanQuestionText(value: unknown, max: number, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (
    (!clean && !allowEmpty) ||
    clean.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(clean)
  ) {
    return undefined;
  }
  return clean;
}

function withDirectory(path: string, scope: Readonly<HarnessScope>): string {
  const directory = scope.workingDirectory?.trim();
  if (!directory) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}directory=${encodeURIComponent(directory)}`;
}

async function responseError(response: Response): Promise<Error> {
  let detail = '';
  let payload: Record<string, unknown> | undefined;
  try {
    const text = (await response.text()).trim();
    detail = text.slice(0, 2_048);
    if (text.length <= 16_384) {
      try { payload = recordOf(JSON.parse(text)); } catch { /* Keep bounded non-JSON detail. */ }
    }
  } catch {
    detail = '';
  }
  const envelope = recordOf(payload?.error) ?? payload;
  // OpenCode also uses named APIError envelopes with provider fields in data.
  const data = recordOf(envelope?.data);
  const source = data ? { ...envelope, ...data,
    retryable: data.retryable ?? data.isRetryable ?? envelope?.retryable,
  } : envelope;
  return new ProviderRuntimeError(providerErrorDetails(source, {
    message: `OpenCode server request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ''})${detail ? `: ${detail}` : ''}`,
  }));
}

async function requestJson(
  generation: string,
  scope: Readonly<HarnessScope>,
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<unknown> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abort = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abort();
  else upstreamSignal?.addEventListener('abort', abort, { once: true });
  const timeout =
    timeoutMs > 0
      ? setTimeout(() => controller.abort(new Error('OpenCode request timed out.')), timeoutMs)
      : undefined;
  try {
    const response = await nativeOpenCodeRequest(
      generation,
      withDirectory(path, scope),
      {
        ...init,
        signal: controller.signal,
      },
      timeoutMs,
    );
    if (!response.ok) throw await responseError(response);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text.trim() ? (JSON.parse(text) as unknown) : undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abort);
  }
}

function unwrapData(value: unknown): unknown {
  const record = recordOf(value);
  return record && 'data' in record ? record.data : value;
}

// Cold project-scoped discovery may initialize providers before returning.
// This grace applies only to read-only catalog routes, never prompt dispatch.
const PROVIDER_CATALOG_TIMEOUT_MS = 60_000;

function awaitOpenCodePreparation<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('The OpenCode turn was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    // The bounded shared catalog may finish for another caller after this turn
    // stops. Observe both outcomes without cancelling its generation-safe load.
    void pending.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

class OpenCodeHttpSdk implements OpenCodeSdkClientLike {
  private readonly toolReceiptBindings = new Map<string, Awaited<ReturnType<typeof toolReceiptBinding>>>();
  bindToolReceipt(sessionId: string, binding: Awaited<ReturnType<typeof toolReceiptBinding>>): () => void {
    this.toolReceiptBindings.set(sessionId, binding);
    return () => { if (this.toolReceiptBindings.get(sessionId) === binding) this.toolReceiptBindings.delete(sessionId); };
  }
  constructor(readonly handle: OpenCodeServerHandle) {}

  readonly global = {
    health: async (): Promise<unknown> =>
      // This is the once-per-scope setup handshake, before any prompt is sent.
      // A cold native server can answer correctly after the former five-second cap.
      requestJson(this.handle.generation, this.handle.scope, '/global/health', {}, 30_000),
  };

  readonly config = {
    providers: async (): Promise<unknown> =>
      requestJson(this.handle.generation, this.handle.scope, '/config/providers', {}, PROVIDER_CATALOG_TIMEOUT_MS),
  };

  readonly command = {
    list: async (): Promise<unknown> =>
      requestJson(this.handle.generation, this.handle.scope, '/command', {}, 30_000),
  };

  readonly skill = {
    list: async (): Promise<unknown> =>
      requestJson(this.handle.generation, this.handle.scope, '/skill', {}, 30_000),
  };

  readonly session = {
    create: async (input: { body: { title?: string } }): Promise<unknown> =>
      requestJson(
        this.handle.generation,
        this.handle.scope,
        '/session',
        { method: 'POST', body: JSON.stringify(input.body) },
        30_000,
      ),
    get: async (input: { path: { id: string } }): Promise<unknown> =>
      requestJson(
        this.handle.generation,
        this.handle.scope,
        `/session/${encodeURIComponent(input.path.id)}`,
        {},
        30_000,
      ),
    abort: async (input: { path: { id: string } }): Promise<unknown> =>
      requestJson(
        this.handle.generation,
        this.handle.scope,
        `/session/${encodeURIComponent(input.path.id)}/abort`,
        { method: 'POST', body: '{}' },
        30_000,
      ),
    promptAsync: async (input: {
      path: { id: string };
      body: Readonly<Record<string, unknown>>;
    }): Promise<unknown> => {
      const messageId = newOpenCodeMessageId();
      const path = `/session/${encodeURIComponent(input.path.id)}`;
      return sendOpenCodePromptOnce({
        sessionId: input.path.id,
        messageId,
        send: async () => {
          const binding = this.toolReceiptBindings.get(input.path.id);
          // Dispatch intent is not delivery or schema acceptance.
          if (binding) recordOpenCodeToolPolicyReceipt(binding, input.body, messageId, input.path.id, 'dispatch-started');
          const result = await requestJson(this.handle.generation, this.handle.scope, path + '/prompt_async',
            { method: 'POST', body: JSON.stringify({ ...input.body, messageID: messageId }) }, 30_000);
          if (binding) recordOpenCodeToolPolicyReceipt(binding, input.body, messageId, input.path.id, 'http-accepted');
          return result;
        },
        messages: () => requestJson(this.handle.generation, this.handle.scope, `${path}/message`, {}, 5_000),
      });
    },
    command: async (input: {
      signal?: AbortSignal;
      path: { id: string };
      body: {
        command: string;
        arguments: string;
        model?: string;
        variant?: string;
        agent: import('@/lib/permissions/OpenCodePermissionProfile').OpenCodeExecutionAgentId;
      };
    }): Promise<unknown> =>
      requestJson(
        this.handle.generation,
        this.handle.scope,
        `/session/${encodeURIComponent(input.path.id)}/command`,
        { method: 'POST', body: JSON.stringify(input.body), signal: input.signal },
        TURN_MAX_WALL_MS,
      ),
    replyPermission: async (input: {
      path: { id: string; permissionId: string };
      body: { response: HarnessApprovalResponse['response'] };
    }): Promise<unknown> =>
      requestJson(
        this.handle.generation,
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
    for await (const event of nativeOpenCodeEvents(
      this.handle.generation,
      withDirectory('/event', this.handle.scope),
      signal,
    )) {
      approvalAcknowledgments.observe(this.handle.generation, event);
      yield event;
    }
  }

  async status(sessionId: string): Promise<unknown> {
    const all = await requestJson(
      this.handle.generation,
      this.handle.scope,
      '/session/status',
      {},
      30_000,
    );
    return recordOf(unwrapData(all))?.[sessionId];
  }

  async messages(sessionId: string): Promise<readonly OpenCodeMessageRecord[]> {
    const value = unwrapData(
      await requestJson(
        this.handle.generation,
        this.handle.scope,
        `/session/${encodeURIComponent(sessionId)}/message?limit=100`,
        {},
        30_000,
      ),
    );
    if (!Array.isArray(value) || value.some((entry) => !recordOf(entry))) {
      throw new ProviderRuntimeError({
        code: 'malformed_response',
        message: 'OpenCode returned malformed session history; the request was not restored.',
        retryable: false,
      });
    }
    return value as OpenCodeMessageRecord[];
  }

  async pendingQuestions(): Promise<readonly Record<string, unknown>[]> {
    const value = unwrapData(
      await requestJson(this.handle.generation, this.handle.scope, '/question', {}, 30_000),
    );
    return Array.isArray(value)
      ? value.map((entry) => recordOf(entry)).filter((entry) => entry !== undefined)
      : [];
  }

  async pendingPermissions(): Promise<readonly Record<string, unknown>[]> {
    const value = unwrapData(
      await requestJson(this.handle.generation, this.handle.scope, '/permission', {}, 30_000),
    );
    return Array.isArray(value)
      ? value.map((entry) => recordOf(entry)).filter((entry) => entry !== undefined)
      : [];
  }

  async providerState(): Promise<unknown> {
    return requestJson(this.handle.generation, this.handle.scope, '/provider', {}, PROVIDER_CATALOG_TIMEOUT_MS);
  }
}

class PersistentOpenCodeClient extends OpenCodeSdkSessionClient {
  constructor(readonly http: OpenCodeHttpSdk) {
    super(http, new StrictModelControlPromptAdapter());
  }
}

class LocalStorageSessionRegistry implements OpenCodeSessionRegistry {
  private read(): Record<string, Record<string, PersistedSessionMapping>> {
    if (typeof localStorage === 'undefined') return {};
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_REGISTRY_KEY) ?? '{}') as unknown;
      return (
        (recordOf(value) as Record<
          string,
          Record<string, PersistedSessionMapping>
        >) ?? {}
      );
    } catch {
      return {};
    }
  }

  private write(
    value: Record<string, Record<string, PersistedSessionMapping>>,
  ): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(SESSION_REGISTRY_KEY, JSON.stringify(value));
    } catch {
      /* best effort */
    }
  }

  async load(scopeKey: string, chatId: string) {
    const value = this.read()[scopeKey]?.[chatId];
    return value && cleanIdentifier(value.sessionId) && cleanIdentifier(value.runtimeGeneration) &&
        (value.instructionFingerprint === undefined ||
          /^sha256:[a-f0-9]{64}$/u.test(value.instructionFingerprint))
      ? { sessionId: value.sessionId, runtimeGeneration: value.runtimeGeneration,
          ...(value.instructionFingerprint ? { instructionFingerprint: value.instructionFingerprint } : {}) }
      : null;
  }

  async save(
    scopeKey: string,
    chatId: string,
    mapping: PersistedSessionMapping,
  ) {
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

type AcceptedOpenCodeTurn = Readonly<{
  requestId: string;
  chatId: string;
  scopeKey: string;
  sessionId: string;
  runtimeGeneration: string;
}>;

class LocalStorageAcceptedTurnRegistry {
  private read(): readonly AcceptedOpenCodeTurn[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const value = JSON.parse(localStorage.getItem(ACCEPTED_TURN_REGISTRY_KEY) ?? '[]') as unknown;
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry) => {
        const record = recordOf(entry);
        const requestId = cleanIdentifier(record?.requestId);
        const chatId = cleanIdentifier(record?.chatId);
        const scopeKey = cleanIdentifier(record?.scopeKey, 4_096);
        const sessionId = cleanIdentifier(record?.sessionId);
        const runtimeGeneration = cleanIdentifier(record?.runtimeGeneration);
        return requestId && chatId && scopeKey && sessionId && runtimeGeneration
          ? [{ requestId, chatId, scopeKey, sessionId, runtimeGeneration }]
          : [];
      });
    } catch {
      return [];
    }
  }

  load(requestId: string): AcceptedOpenCodeTurn | undefined {
    return this.read().find((entry) => entry.requestId === requestId);
  }

  save(entry: AcceptedOpenCodeTurn): void {
    if (typeof localStorage === 'undefined') return;
    const retained = this.read().filter((candidate) => candidate.requestId !== entry.requestId);
    try {
      localStorage.setItem(
        ACCEPTED_TURN_REGISTRY_KEY,
        JSON.stringify([...retained, entry].slice(-2_000)),
      );
    } catch {
      /* best effort: the accepted provider turn remains authoritative */
    }
  }
}

export function createPersistentOpenCodeRuntimeSupervisor(
  runtime: HarnessRuntimeManager = harnessRuntimeManager,
): OpenCodeRuntimeSupervisor {
  return {
    currentGeneration: () => runtime.getConnection()?.generation,
    async start(scope: HarnessScope): Promise<OpenCodeRuntimeHandle> {
      let connection = runtime.getConnection();
      if (!connection) {
        await runtime.refresh();
        connection = runtime.getConnection();
      }
      if (!connection) {
        throw new Error(
          'The managed OpenCode runtime did not provide a private server connection.',
        );
      }
      const handle: OpenCodeServerHandle = {
        generation: connection.generation,
        version: connection.version,
        scope: { ...scope },
        // Native runtimeManager owns the single app-scoped server and its Exit cleanup.
        // Releasing a warm chat scope must not terminate that shared runtime.
        dispose: async () => undefined,
      };
      return handle;
    },
  };
}

const clientFactory: OpenCodeClientFactory = {
  async connect(handle: OpenCodeRuntimeHandle) {
    const server = handle as OpenCodeServerHandle;
    const client = new PersistentOpenCodeClient(new OpenCodeHttpSdk(server));
    await client.health();
    return client;
  },
};

const sessionRegistry = new LocalStorageSessionRegistry();
const acceptedTurnRegistry = new LocalStorageAcceptedTurnRegistry();
const sessions = new OpenCodeSessionPool(
  createPersistentOpenCodeRuntimeSupervisor(),
  clientFactory,
  { maxWarmScopes: 2, registry: sessionRegistry },
);
const coordinator = new OpenCodeTurnCoordinator(sessions);
const turnGate = new OpenCodeTurnGate();
const activeRequests = new Map<string, { scope: HarnessScope; chatId: string; released: Promise<void> }>();

/** Kernel cancellation may finish before the provider generator retires. */
export async function waitForPersistentOpenCodeChatRelease(chatId: string): Promise<void> {
  const previous = [...activeRequests.values()].filter(active => active.chatId === chatId);
  if (!previous.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(previous.map(active => active.released)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OpenCode is still stopping the previous turn. The message remains queued.')), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
type ActivePersistentApprovalSession = {
  readonly requestId: string;
  readonly http: OpenCodeHttpSdk;
  readonly approvals: Map<string, Readonly<VibeSpaceApproval>>;
  readonly gatewayAuthority?: ToolGatewayAuthorityClaim;
};
const activeApprovalSessions = new Map<string, ActivePersistentApprovalSession>();
type ActivePersistentQuestionSession = {
  readonly requestId: string;
  readonly http: OpenCodeHttpSdk;
  readonly pending: Map<string, Readonly<ProviderQuestionRequest>>;
  readonly settled: Set<string>;
  readonly authorities: Map<string, Readonly<OpenCodeQuestionRequestAuthority>>;
};
const activeQuestionSessions = new Map<string, ActivePersistentQuestionSession>();
export function isActiveOpenCodeChildApproval(
  rootSessionId: string,
  approval: Readonly<VibeSpaceApproval>,
): boolean {
  const root = activeApprovalSessions.get(rootSessionId);
  return approval.sessionId !== rootSessionId && root !== undefined &&
    activeApprovalSessions.get(approval.sessionId) === root &&
    root.approvals.get(approval.id) === approval;
}
export function isActiveOpenCodeChildQuestion(
  rootSessionId: string,
  question: Readonly<ProviderQuestionRequest>,
): boolean {
  const root = activeQuestionSessions.get(rootSessionId);
  return question.sessionId !== rootSessionId && root !== undefined &&
    activeQuestionSessions.get(question.sessionId) === root &&
    root.pending.get(question.id) === question;
}
const TOOL_GATEWAY_NAMES = new Set<string>(TOOL_GATEWAY_CATALOG);
const OPENCODE_BUILTIN_TOOL_NAMES = Object.freeze([
  'bash',
  'batch',
  'codesearch',
  'edit',
  'glob',
  'grep',
  'invalid',
  'list',
  'lsp',
  'multiedit',
  'patch',
  'question',
  'read',
  'shell',
  'skill',
  'task',
  'todo',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'write',
]);

const approvalResponseFlights = new Map<
  string,
  Readonly<{ response: HarnessApprovalResponse['response']; promise: Promise<void> }>
>();
const settledApprovalResponses = new Set<string>();
const approvalAcknowledgments = new OpenCodeApprovalAcknowledgements();

function reconcileNativeApprovalReply(generation: string, event: OpenCodeRawEvent): void {
  if (event.type !== 'permission.replied') return;
  const sessionId = cleanIdentifier(event.properties?.sessionID);
  const approvalId = cleanIdentifier(event.properties?.requestID);
  const reply = event.properties?.reply;
  if (!sessionId || !approvalId || (reply !== 'once' && reply !== 'always' && reply !== 'reject')) return;
  const active = activeApprovalSessions.get(sessionId);
  if (active?.http.handle.generation !== generation ||
      active.approvals.get(approvalId)?.sessionId !== sessionId) return;
  // Native pattern approval may also settle other pending requests. Only an
  // exact acknowledgment on this generation's stream can clear their wait.
  active.approvals.delete(approvalId);
  settledApprovalResponses.add(`${sessionId}\u0000${approvalId}`);
  recordOpenCodeApprovalStatus(sessionId, approvalId,
    reply === 'reject' ? 'denied' : reply === 'always' ? 'approved_plan' : 'approved');
}

function approvalScope(route: Readonly<OpenCodeApprovalHarnessRoute>): HarnessScope {
  const accountId = cleanIdentifier(route.accountId, 512);
  const workspaceId = cleanIdentifier(route.workspaceId, 512);
  if (route.protocol !== 'opencode-approval-v1' || !accountId || !workspaceId) {
    throw new Error('OpenCode approval route is invalid.');
  }
  return {
    accountId,
    workspaceId,
    ...(cleanIdentifier(route.projectId, 512) ? { projectId: route.projectId!.trim() } : {}),
    ...(cleanIdentifier(route.worktreeId, 512) ? { worktreeId: route.worktreeId!.trim() } : {}),
    ...(route.workingDirectory?.trim() ? { workingDirectory: route.workingDirectory.trim() } : {}),
  };
}

async function executePersistentOpenCodeApproval(
  input: Readonly<HarnessApprovalResponse & { route?: OpenCodeApprovalHarnessRoute }>,
  sessionId: string,
  approvalId: string,
): Promise<void> {
  const active = activeApprovalSessions.get(sessionId);
  let http: OpenCodeHttpSdk;
  if (active) {
    const approval = active.approvals.get(approvalId);
    if (!approval) {
      throw new Error('OpenCode approval is no longer pending.');
    }
    if (
      input.route &&
      (input.route.sessionId !== sessionId ||
        input.route.approvalId !== approvalId ||
        input.route.capability !== approval.capability)
    ) {
      throw new Error('OpenCode approval route does not match the pending request.');
    }
    http = active.http;
  } else {
    const route = input.route;
    if (
      !route ||
      route.sessionId !== sessionId ||
      route.approvalId !== approvalId ||
      !cleanIdentifier(route.capability, 256) ||
      !cleanIdentifier(route.chatId, 512)
    ) {
      throw new Error('OpenCode approval session is no longer active.');
    }
    const scope = approvalScope(route);
    const mapping = await sessionRegistry.load(openCodeScopeKey(scope), route.chatId);
    if (!mapping || mapping.sessionId !== sessionId) {
      throw new Error('OpenCode approval route is no longer current.');
    }
    const entry = await sessions.clientForScope(scope);
    if (entry.runtimeGeneration !== mapping.runtimeGeneration) {
      throw new Error('OpenCode approval runtime changed.');
    }
    const client = entry.client as PersistentOpenCodeClient;
    const session = await client.getSession?.(sessionId).catch(() => null);
    if (session?.id !== sessionId) {
      throw new Error('OpenCode approval session is no longer available.');
    }
    const pending = (await client.http.pendingPermissions())
      .flatMap((properties) =>
        normalizeOpenCodeEvent({ type: 'permission.asked', properties }, sessionId),
      )
      .find(
        (event) =>
          event.type === 'approval.requested' &&
          event.approval.id === approvalId &&
          event.approval.sessionId === sessionId &&
          event.approval.capability === route.capability,
      );
    if (!pending) throw new Error('OpenCode approval is no longer pending.');
    http = client.http;
  }
  const reconcileAcknowledgment = () => {
    active?.approvals.delete(approvalId);
    recordOpenCodeApprovalStatus(sessionId, approvalId,
      input.response === 'reject' ? 'denied' : input.response === 'always' ? 'approved_plan' : 'approved');
  };
  await approvalAcknowledgments.execute(
    { ...input, generation: http.handle.generation, sessionId, approvalId },
    async () => {
      const result = await http.session.replyPermission({
        path: { id: sessionId, permissionId: approvalId },
        body: { response: input.response },
      });
      if (unwrapData(result) === false) throw new Error('OpenCode rejected the approval response.');
    },
    reconcileAcknowledgment,
  );
  // A persisted card can reattach after an earlier exact acknowledgment.
  reconcileAcknowledgment();
}

export async function respondToPersistentOpenCodeApproval(
  input: Readonly<
    Omit<HarnessApprovalResponse, 'response'> & {
      response: HarnessApprovalResponse['response'] | 'cancel';
      route?: OpenCodeApprovalHarnessRoute;
    }
  >,
): Promise<void> {
  if (input.approvalId.startsWith('codex-approval-')) return replyCodexApproval(input);
  if (input.response === 'cancel') {
    throw new Error('OpenCode approval cancellation is not supported by this route.');
  }
  const sessionId = cleanIdentifier(input.sessionId, 512);
  const approvalId = cleanIdentifier(input.approvalId, 512);
  if (!sessionId || !approvalId) {
    throw new Error('OpenCode approval binding is invalid.');
  }
  const key = `${sessionId}\u0000${approvalId}`;
  if (settledApprovalResponses.has(key)) {
    throw new Error('OpenCode approval is no longer pending.');
  }
  const existing = approvalResponseFlights.get(key);
  if (existing) {
    if (existing.response !== input.response) {
      throw new Error('OpenCode approval already has a different pending decision.');
    }
    return existing.promise;
  }
  const promise = executePersistentOpenCodeApproval({ ...input, response: input.response }, sessionId, approvalId)
    .then(() => {
      if (settledApprovalResponses.size >= 4_096) settledApprovalResponses.clear();
      settledApprovalResponses.add(key);
    })
    .finally(() => {
      if (approvalResponseFlights.get(key)?.promise === promise) {
        approvalResponseFlights.delete(key);
      }
    });
  approvalResponseFlights.set(key, { response: input.response, promise });
  return promise;
}

function sameQuestionTool(
  left: Readonly<{ messageId: string; callId: string }> | undefined,
  right: Readonly<{ messageId: string; callId: string }> | undefined,
): boolean {
  return left?.messageId === right?.messageId && left?.callId === right?.callId;
}

export function bindPersistentOpenCodeQuestionRoute(route: OpenCodeQuestionReplyRoute): void {
  if (bindCodexQuestionRoute(route)) return;
  const active = activeQuestionSessions.get(route.sessionId);
  const pending = active?.pending.get(route.requestId);
  if (
    !active ||
    !pending ||
    pending.sessionId !== route.sessionId ||
    !sameQuestionTool(pending.tool, route.tool)
  ) {
    throw new Error('OpenCode question binding is no longer active.');
  }
  active.authorities.set(route.requestId, {
    protocol: route.protocol,
    blockId: route.blockId,
    requestId: route.requestId,
    sessionId: route.sessionId,
    ...(route.tool ? { tool: { ...route.tool } } : {}),
  });
}

export async function respondToPersistentOpenCodeQuestion(input: {
  request: OpenCodeQuestionReplyRequest | OpenCodeQuestionRejectRequest;
  expectedSessionId: string;
  expectedBlockId: string;
  signal?: AbortSignal;
}): Promise<OpenCodeQuestionDispatchReceipt> {
  if (input.request.authority.requestId.startsWith('que_codex_')) return replyCodexQuestion(input);
  const active = activeQuestionSessions.get(input.expectedSessionId);
  if (!active) throw new Error('OpenCode question is no longer active.');
  const receipt = await executeOpenCodeQuestionRequest(
    input.request,
    {
      readWaitingAuthority: async (sessionId, requestId) =>
        activeQuestionSessions.get(sessionId)?.authorities.get(requestId),
      request: async (path, init) =>
        unwrapData(
          await requestJson(active.http.handle.generation, active.http.handle.scope, path, init),
        ),
    },
    {
      sessionId: input.expectedSessionId,
      blockId: input.expectedBlockId,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  active.settled.add(`${receipt.sessionId}\u0000${receipt.requestId}`);
  active.pending.delete(receipt.requestId);
  active.authorities.delete(receipt.requestId);
  return receipt;
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
  const declaredEffort = cleanIdentifier(
    record?.reasoningEffort ?? record?.reasoning_effort,
    32,
  );
  const id = cleanIdentifier(record?.id ?? fallbackId ?? declaredEffort, 256);
  if (!id) return undefined;
  const normalized = id.toLocaleLowerCase('en-US');
  const tokens = normalized.split(/[-+_/:.]+/u).filter(Boolean);
  const effort =
    declaredEffort ??
    tokens.find((token) =>
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(token),
    );
  const fast = record?.fast === true || tokens.includes('fast');
  return {
    id,
    ...(cleanIdentifier(record?.label, 256) ? { label: cleanIdentifier(record?.label, 256) } : {}),
    ...(effort ? { reasoningEffort: effort as LiveModelVariant['reasoningEffort'] } : {}),
    ...(fast ? { fast: true } : {}),
    ...(fast && effort
      ? { kind: 'combined' as const }
      : fast
        ? { kind: 'latency' as const }
        : effort
          ? { kind: 'reasoning' as const }
          : {}),
  };
}

function exactBooleanCapability(
  model: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): boolean {
  const value = model[camelCase] ?? model[snakeCase];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new Error(`OpenCode returned malformed ${camelCase} capability metadata.`);
  }
  return value;
}

function serviceTiersFrom(model: Record<string, unknown>): readonly string[] {
  const value = model.serviceTiers ?? model.service_tiers;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('OpenCode returned malformed service tier metadata.');
  }
  const tiers = value.map((tier) => cleanIdentifier(tier, 64));
  if (tiers.some((tier) => !tier)) {
    throw new Error('OpenCode returned malformed service tier metadata.');
  }
  return [...new Set(tiers as string[])];
}

function variantsFrom(model: Record<string, unknown>): readonly LiveModelVariant[] {
  // OpenCode releases have used all of these names for the same live
  // capability. Keep the exact route while accepting the Codex-shaped
  // `supportedReasoningEfforts` response used by newer bridges.
  const source =
    model.variants ??
    model.variant ??
    model.reasoningEfforts ??
    model.reasoning_efforts ??
    model.supportedReasoningEfforts ??
    model.supported_reasoning_efforts;
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
  return [
    ...new Map(
      variants.map((variant) => [variant.id.toLocaleLowerCase('en-US'), variant]),
    ).values(),
  ];
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
    const providerId = cleanIdentifier(
      provider.id ?? provider.providerID ?? provider.providerId,
      128,
    );
    if (!providerId) continue;
    const rawModels = provider.models;
    const entries: Array<[string, Record<string, unknown>]> = Array.isArray(rawModels)
      ? arrayOfRecords(rawModels).map((model) => [
          cleanIdentifier(model.id ?? model.modelID ?? model.modelId) ?? '',
          model,
        ])
      : Object.entries(recordOf(rawModels) ?? {}).map(([id, model]) => [id, recordOf(model) ?? {}]);
    for (const [rawId, model] of entries) {
      const modelLocalId = cleanIdentifier(model.id ?? model.modelID ?? model.modelId ?? rawId);
      if (!modelLocalId) continue;
      const providerPrefix = `${providerId}/`;
      const id = modelLocalId.startsWith(providerPrefix)
        ? modelLocalId
        : `${providerPrefix}${modelLocalId}`;
      const upstreamModelId = id.slice(providerPrefix.length);
      const label = cleanIdentifier(model.name ?? model.label, 256) ?? id;
      const pricing = parseOpenCodeModelPricing(model.cost);
      const supportsIndependentReasoningEffort = exactBooleanCapability(
        model,
        'supportsIndependentReasoningEffort',
        'supports_independent_reasoning_effort',
      );
      const supportsOpenCodeFastMode = exactBooleanCapability(
        model,
        'supportsOpenCodeFastMode',
        'supports_opencode_fast_mode',
      );
      result.push({
        id,
        label,
        providerId,
        upstreamModelId,
        variants: variantsFrom(model),
        ...(pricing ? { pricing } : {}),
        supportsIndependentReasoningEffort,
        serviceTiers: serviceTiersFrom(model),
        supportsOpenCodeFastMode,
        ...(['fast', 'priority'].includes(String(recordOf(model.options)?.serviceTier ?? '').toLowerCase())
          ? { isFastRoute: true } : {}),
      });
    }
  }
  return [
    ...new Map(result.map((model) => [model.id.toLocaleLowerCase('en-US'), model])).values(),
  ].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function toOpenCodeDiscoveredModels(
  models: readonly Readonly<OpenCodeLiveModel>[],
): readonly Readonly<ProviderDiscoveredModel>[] {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    variants: model.variants.map((variant) => variant.id),
    ...(model.pricing ? { pricing: model.pricing } : {}),
  }));
}

export async function openCodeCatalogRevision(
  models: readonly Readonly<OpenCodeLiveModel>[],
): Promise<string> {
  const canonical = JSON.stringify(
    models.map((model) => ({
      id: model.id,
      label: model.label,
      providerId: model.providerId,
      upstreamModelId: model.upstreamModelId,
      variants: model.variants.map((variant) => ({ ...variant })),
      pricing: model.pricing ? { ...model.pricing } : null,
      supportsIndependentReasoningEffort: model.supportsIndependentReasoningEffort,
      serviceTiers: [...model.serviceTiers],
      supportsOpenCodeFastMode: model.supportsOpenCodeFastMode,
      isFastRoute: model.isFastRoute,
    })),
  );
  const digest = await globalThis.crypto?.subtle?.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  if (!digest) throw new Error('OpenCode catalog revision hashing is unavailable.');
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function parseConnectedOpenCodeProviderIds(value: unknown): readonly string[] {
  const data = recordOf(unwrapData(value));
  if (!data || !Array.isArray(data.connected) || data.connected.length > 512) {
    throw new Error('OpenCode returned malformed provider status.');
  }
  const connected = data.connected.map((providerId) => cleanIdentifier(providerId, 128));
  if (connected.some((providerId) => !providerId)) {
    throw new Error('OpenCode returned malformed provider status.');
  }
  return [...new Set(connected as string[])];
}

export function filterOpenCodeModelsToConnectedProviders(
  models: readonly Readonly<OpenCodeLiveModel>[],
  connectedProviderIds: readonly string[],
): readonly OpenCodeLiveModel[] {
  const connected = new Set(
    connectedProviderIds.map((providerId) => providerId.toLocaleLowerCase('en-US')),
  );
  return models.filter((model) => connected.has(model.providerId.toLocaleLowerCase('en-US')));
}

export function managedOpenCodeAuthResult(value: unknown): AuthProbeResult {
  const connected = parseConnectedOpenCodeProviderIds(value);
  return connected.length > 0
    ? {
        status: 'authenticated',
        detail: 'Authentication verified by the managed OpenCode provider service.',
      }
    : {
        status: 'unauthenticated',
        detail: 'The managed OpenCode provider service reports no connected providers.',
      };
}

function modelMetadata(model: OpenCodeLiveModel, connectionId: string): LiveModelRuntimeMetadata {
  return {
    connectionId,
    modelId: model.id,
    variants: model.variants,
    supportsIndependentReasoningEffort: model.supportsIndependentReasoningEffort,
    serviceTiers: model.serviceTiers,
    supportsOpenCodeFastMode: model.supportsOpenCodeFastMode,
    isFastRoute: model.isFastRoute,
  };
}

function sameLiveModelId(candidateId: string, requestedId: string): boolean {
  const left = candidateId.trim().toLocaleLowerCase('en-US');
  const right = requestedId.trim().toLocaleLowerCase('en-US');
  return left === right;
}

export function requireAuthoritativeOpenCodeModel(
  models: readonly OpenCodeLiveModel[],
  requestedModelId: string,
): OpenCodeLiveModel {
  const requested = requestedModelId.trim();
  if (!requested.includes('/')) {
    throw new Error(
      'OpenCode requires a provider-qualified model from the live authenticated catalog.',
    );
  }
  const model = models.find((candidate) => sameLiveModelId(candidate.id, requested));
  if (!model) {
    throw new Error(
      `OpenCode model “${requested}” is not present in the live authenticated catalog.`,
    );
  }
  return model;
}

function statusType(value: unknown): string | undefined {
  if (typeof value === 'string') return value.toLocaleLowerCase('en-US');
  const record = recordOf(value);
  return cleanIdentifier(record?.type ?? record?.status, 64)?.toLocaleLowerCase('en-US');
}

function eventSessionId(event: OpenCodeRawEvent): string | undefined {
  const properties = event.properties;
  const part = recordOf(properties?.part);
  const info = recordOf(properties?.info ?? properties?.message);
  return cleanIdentifier(
    properties?.sessionID ??
      properties?.sessionId ??
      part?.sessionID ??
      part?.sessionId ??
      info?.sessionID ??
      info?.sessionId,
  );
}

export function persistentOpenCodeSessionErrorMessage(
  event: OpenCodeRawEvent,
  sessionId: string,
): string {
  return persistentOpenCodeSessionErrorDetails(event, sessionId).message;
}

function isGenericPersistentOpenCodeSessionError(message: string): boolean {
  return message === 'OpenCode session entered an error state.' ||
    message === 'OpenCode reported a provider session error.';
}

export function persistentOpenCodeSessionErrorDetails(
  event: OpenCodeRawEvent,
  sessionId: string,
): Readonly<{
  message: string;
  code?: string;
  providerId?: string;
  modelId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  resetAt?: number;
}> {
  const normalized = normalizeOpenCodeEvent(event, sessionId).find((item) => item.type === 'error');
  if (normalized?.type === 'error') {
    const hasProviderDetails = Boolean(
      normalized.code || normalized.providerId || normalized.modelId ||
      normalized.retryable !== undefined || normalized.retryAfterMs !== undefined ||
      normalized.resetAt !== undefined,
    );
    return Object.freeze({
      message: event.type === 'session.status' && normalized.message === 'OpenCode session failed.' &&
        !hasProviderDetails
        ? 'OpenCode session entered an error state.'
        : normalized.message,
      ...(normalized.code ? { code: normalized.code } : {}),
      ...(normalized.providerId ? { providerId: normalized.providerId } : {}),
      ...(normalized.modelId ? { modelId: normalized.modelId } : {}),
      ...(normalized.retryable === undefined ? {} : { retryable: normalized.retryable }),
      ...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
      ...(normalized.resetAt === undefined ? {} : { resetAt: normalized.resetAt }),
    });
  }
  return Object.freeze({ message: 'OpenCode reported a provider session error.' });
}

function openCodeRateLimitRetryTimeout(
  details: Readonly<ReturnType<typeof persistentOpenCodeSessionErrorDetails>> | undefined,
): Extract<ProviderEvent, { type: 'error' }> {
  const usageLimit = details ? isProviderUsageLimitError(details) : false;
  return {
    type: 'error',
    message:
      usageLimit
        ? 'OpenCode stopped retrying after 60 seconds because the provider usage limit remained active.'
        : 'OpenCode stopped retrying after 60 seconds because the provider remained temporarily rate limited.',
    code: details?.code ?? 'opencode_rate_limit_timeout',
    ...(details?.providerId ? { providerId: details.providerId } : {}),
    ...(details?.modelId ? { modelId: details.modelId } : {}),
    retryable: true,
    ...(details?.retryAfterMs === undefined ? {} : { retryAfterMs: details.retryAfterMs }),
    ...(details?.resetAt === undefined ? {} : { resetAt: details.resetAt }),
  };
}

function openCodeRateLimitRetryNotice(
  details: Readonly<ReturnType<typeof persistentOpenCodeSessionErrorDetails>>,
  verifiedRoute: Readonly<{ providerId: string; modelId: string }>,
): Extract<ProviderEvent, { type: 'warning' }> {
  const presentation = presentProviderError(details);
  const route = [verifiedRoute.providerId, verifiedRoute.modelId]
    .map((value) => redactHarnessText(value))
    .join('/');
  return {
    type: 'warning',
    message:
      `${presentation.title}${route ? ` for ${route}` : ''}. ` +
      `${presentation.message} OpenCode is retrying for up to 60 seconds before stopping.`,
  };
}

const OPENCODE_RATE_LIMIT_ABORT_TIMEOUT_MS = 1_000;

export const OPENCODE_FAILURE_ABORT_TIMEOUT_MS = 1_000;

async function boundedOpenCodeFailureAbort(cancel: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    cancel().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, OPENCODE_FAILURE_ABORT_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

async function abortOpenCodeRateLimitSession(
  client: { abort: (sessionId: string) => Promise<unknown> },
  sessionId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    client.abort(sessionId).catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, OPENCODE_RATE_LIMIT_ABORT_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export function classifyExplicitRootInventoryScope(
  tool: Readonly<{
    name: string;
    status: 'started' | 'completed' | 'failed';
    input?: unknown;
  }>,
  request: Pick<ProviderRequest, 'explicitReadRoot' | 'workingDirectory'>,
): Extract<ProviderEvent, { type: 'tool' }>['scope'] | undefined {
  if (tool.name !== 'read' || tool.status !== 'completed' || request.explicitReadRoot !== true) {
    return undefined;
  }
  const root = normalizePortableAbsolutePath(request.workingDirectory?.trim() ?? '');
  const input = recordOf(tool.input);
  const rawTarget = cleanIdentifier(input?.filePath ?? input?.path, 4_096);
  const target = rawTarget ? normalizePortableAbsolutePath(rawTarget) : null;
  if (!root || !target) return undefined;
  const windowsPath = /^(?:[A-Za-z]:\\|\\\\)/u.test(root);
  const matches = windowsPath
    ? root.toLocaleLowerCase('en-US') === target.toLocaleLowerCase('en-US')
    : root === target;
  return matches ? 'explicit_root_inventory' : undefined;
}

const MAX_QUESTION_COUNT = 8;
const MAX_QUESTION_OPTION_COUNT = 8;

/**
 * Project an official OpenCode `question.asked` envelope into the append-only
 * provider event surface. The mapper intentionally excludes arbitrary event or
 * tool payload data; the reply transport is a separate runtime-owned boundary.
 */
export function normalizeQuestionEvent(
  event: OpenCodeRawEvent,
  expectedSessionId: string,
): Extract<ProviderEvent, { type: 'question' }> | undefined {
  if (event.type !== 'question.asked') return undefined;
  const properties = event.properties;
  const id = cleanIdentifier(properties?.id, 512);
  const sessionId = cleanIdentifier(properties?.sessionID, 512);
  if (!id?.startsWith('que') || !sessionId || sessionId !== expectedSessionId) return undefined;
  if (!Array.isArray(properties?.questions)) return undefined;
  if (properties.questions.length === 0 || properties.questions.length > MAX_QUESTION_COUNT) {
    return undefined;
  }

  const questions = properties.questions.map((candidate) => {
    const question = recordOf(candidate);
    if (!question || !Array.isArray(question.options)) return undefined;
    if (question.options.length > MAX_QUESTION_OPTION_COUNT) return undefined;
    if (question.multiple !== undefined && typeof question.multiple !== 'boolean') return undefined;
    if (question.custom !== undefined && typeof question.custom !== 'boolean') return undefined;
    const header = cleanQuestionText(question.header, 64);
    const prompt = cleanQuestionText(question.question, 2_048);
    if (!header || !prompt) return undefined;

    const options = question.options.map((candidateOption) => {
      const option = recordOf(candidateOption);
      if (!option) return undefined;
      const label = cleanQuestionText(option.label, 160);
      const description = cleanQuestionText(option.description, 512, true);
      return label && description !== undefined ? { label, description } : undefined;
    });
    if (options.some((option) => option === undefined)) return undefined;

    return {
      header,
      prompt,
      options: options as { label: string; description: string }[],
      multiple: question.multiple === true,
      allowCustomAnswer: question.custom !== false,
    };
  });
  if (questions.some((question) => question === undefined)) return undefined;

  let tool: { messageId: string; callId: string } | undefined;
  if (properties.tool !== undefined) {
    const rawTool = recordOf(properties.tool);
    const messageId = cleanIdentifier(rawTool?.messageID, 512);
    const callId = cleanIdentifier(rawTool?.callID, 512);
    if (!messageId || !callId) return undefined;
    tool = { messageId, callId };
  }

  return {
    type: 'question',
    request: {
      id,
      sessionId,
      questions: questions as {
        header: string;
        prompt: string;
        options: { label: string; description: string }[];
        multiple: boolean;
        allowCustomAnswer: boolean;
      }[],
      ...(tool ? { tool } : {}),
    },
  };
}

export function normalizeToolEvent(
  event: OpenCodeRawEvent,
  request: Pick<ProviderRequest, 'explicitReadRoot' | 'workingDirectory'>,
): ProviderEvent | undefined {
  if (event.type !== 'message.part.updated') return undefined;
  const part = recordOf(event.properties?.part);
  if (!part) return undefined;
  const partType = cleanIdentifier(part.type, 64)?.toLocaleLowerCase('en-US');
  if (partType !== 'tool' && partType !== 'tool_use') return undefined;
  const state = recordOf(part.state);
  const name = cleanIdentifier(part.tool ?? part.name, 256);
  if (!name) return undefined;
  const rawStatus = cleanIdentifier(state?.status ?? part.status, 64)?.toLocaleLowerCase('en-US');
  const transportStatus =
    rawStatus === 'completed'
      ? 'completed'
      : rawStatus === 'error' || rawStatus === 'failed'
        ? 'failed'
        : 'started';
  const status =
    transportStatus === 'completed' && (
      isFailedVibeSpaceContextOutput(name, state?.output) ||
      nativeShellFailure(name, state) ||
      isFailedOpenCodeToolOutput(state?.output)
    )
      ? 'failed'
      : transportStatus;
  const callId = cleanIdentifier(part.callID ?? part.callId ?? part.id);
  const rawFilePath = recordOf(state?.input);
  const filePathCandidate =
    rawFilePath?.path ?? rawFilePath?.filePath ?? rawFilePath?.file_path ?? rawFilePath?.filepath;
  const boundedFilePath = cleanIdentifier(filePathCandidate, 4096);
  const rawLeaf = boundedFilePath?.split(/[\\/]/u).filter(Boolean).at(-1);
  const redactedLeaf = rawLeaf ? applySecretPolicy(rawLeaf, 'redact').text : undefined;
  const fileLabel = cleanIdentifier(redactedLeaf, 256);
  const scope = classifyExplicitRootInventoryScope({ name, status, input: state?.input }, request);
  const checklist = sanitizeOpenCodeChecklistSnapshot(name, callId, state?.input);
  const nativeTask = projectNativeTaskActivity(name, state, status);
  return {
    type: 'tool',
    name,
    status,
    ...(callId ? { callId } : {}),
    ...(fileLabel ? { fileLabel } : {}),
    ...(scope ? { scope } : {}),
    ...(checklist ? { checklist } : {}),
    ...(nativeTask ? { nativeTask } : {}),
    details: openCodeToolDetails(name, state),
  };
}

export function normalizePersistentOpenCodeUsage(
  event: OpenCodeRawEvent,
): UsageSnapshot | undefined {
  if (event.type !== 'message.updated') return undefined;
  const info = recordOf(event.properties?.info ?? event.properties?.message);
  const tokens = recordOf(info?.tokens ?? info?.usage);
  if (!tokens && typeof info?.cost !== 'number') return undefined;
  const number = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const input = number(tokens?.input ?? tokens?.inputTokens ?? tokens?.input_tokens);
  const output = number(tokens?.output ?? tokens?.outputTokens ?? tokens?.output_tokens);
  const total = number(tokens?.total ?? tokens?.totalTokens ?? tokens?.total_tokens);
  const cache = recordOf(tokens?.cache);
  const cacheRead = number(cache?.read ?? tokens?.cacheRead ?? tokens?.cache_read);
  const cacheWrite = number(cache?.write ?? tokens?.cacheWrite ?? tokens?.cache_write);
  const reasoning = number(
    tokens?.reasoning ?? tokens?.reasoningTokens ?? tokens?.reasoning_tokens,
  );
  const cost = number(info?.cost ?? tokens?.cost);
  return {
    capturedAt: Date.now(),
    ...(total === undefined ? {} : { totalTokens: { value: total, provenance: 'provider-reported' as const } }),
    ...(input === undefined
      ? {}
      : { inputTokens: { value: input, provenance: 'provider-reported' as const } }),
    ...(output === undefined
      ? {}
      : { outputTokens: { value: output, provenance: 'provider-reported' as const } }),
    ...(cacheRead === undefined
      ? {}
      : { cacheReadTokens: { value: cacheRead, provenance: 'provider-reported' as const } }),
    ...(cacheWrite === undefined
      ? {}
      : { cacheWriteTokens: { value: cacheWrite, provenance: 'provider-reported' as const } }),
    ...(reasoning === undefined
      ? {}
      : { reasoningTokens: { value: reasoning, provenance: 'provider-reported' as const } }),
    ...(cost === undefined
      ? {}
      : { costUsd: { value: cost, provenance: 'provider-reported' as const } }),
  };
}

/** Aggregate only this turn's completed model steps, not just its final answer. */
export function completedOpenCodeTurnUsage(
  messages: readonly OpenCodeMessageRecord[],
): UsageSnapshot | undefined {
  const completed = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    const info = message.info;
    const id = canonicalOpenCodeMessageId(message);
    if (id && info?.role === 'assistant' && (recordOf(info.time)?.completed || info.finish)) {
      completed.set(id, info);
    }
  }
  if (completed.size === 0) return undefined;
  const snapshots = [...completed.values()].map(info =>
    normalizePersistentOpenCodeUsage({ type: 'message.updated', properties: { info } }),
  );
  const result: UsageSnapshot = { capturedAt: Date.now() };
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens',
    'cacheWriteTokens', 'reasoningTokens', 'costUsd'] as const) {
    const values = snapshots.map(snapshot => snapshot?.[key]?.value);
    result[key] = values.every((value): value is number => value !== undefined)
      ? { value: values.reduce((sum, value) => sum + value, 0), provenance: 'provider-reported' }
      : { provenance: 'unavailable', reason: 'One or more completed model steps omitted this metric.' };
  }
  return result;
}

export interface OpenCodeObservedIdentity {
  providerId?: string;
  modelId?: string;
  variant?: string;
  serviceTier?: string;
}

function identityFromInfo(
  info: Record<string, unknown> | undefined,
  part?: Record<string, unknown>,
): OpenCodeObservedIdentity {
  return {
    providerId: cleanIdentifier(
      info?.providerID ?? info?.providerId ?? part?.providerID ?? part?.providerId,
    ),
    modelId: cleanIdentifier(info?.modelID ?? info?.modelId ?? part?.modelID ?? part?.modelId),
    variant: cleanIdentifier(
      info?.variant ??
        info?.reasoningEffort ??
        info?.reasoning_effort ??
        part?.variant ??
        part?.reasoningEffort ??
        part?.reasoning_effort,
    ),
    serviceTier: cleanIdentifier(
      info?.serviceTier ?? info?.service_tier ?? part?.serviceTier ?? part?.service_tier,
    ),
  };
}

function observedIdentity(event: OpenCodeRawEvent): OpenCodeObservedIdentity {
  const properties = event.properties;
  const part = recordOf(properties?.part);
  const info = recordOf(properties?.info ?? properties?.message);
  return identityFromInfo(info, part);
}

function observedAssistantIdentity(
  messages: readonly OpenCodeMessageRecord[],
): OpenCodeObservedIdentity | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index];
    const role = cleanIdentifier(record.info?.role, 32)?.toLocaleLowerCase('en-US');
    if (role !== 'assistant') continue;
    const identity = identityFromInfo(record.info);
    if (identity.modelId) return identity;
  }
  return undefined;
}

export function assertAuthoritativeOpenCodeIdentity(input: {
  connectionId: string;
  providerId: string;
  modelId: string;
  variant?: string;
  serviceTier?: string;
  observed?: Readonly<OpenCodeObservedIdentity>;
}): string {
  if (!input.observed?.modelId) {
    throw new Error('OpenCode completed without authoritative observed model identity.');
  }
  const observedProviderId = input.observed.providerId ?? input.providerId;
  const alreadyQualified = input.observed.providerId
    ? input.observed.modelId.toLocaleLowerCase('en-US').startsWith(
        `${observedProviderId.toLocaleLowerCase('en-US')}/`,
      )
    : input.observed.modelId.includes('/');
  // OpenRouter can report a nested model such as `google/gemma...` while its
  // authoritative provider is `openrouter`. Preserve that provider prefix in
  // the comparison; a slash within the model is not itself provider authority.
  const observedModelId = alreadyQualified
    ? input.observed.modelId
    : `${observedProviderId}/${input.observed.modelId}`;
  assertObservedModelMatches({
    requested: {
      connectionId: input.connectionId,
      providerId: input.providerId,
      modelId: input.modelId,
      ...(input.variant ? { variant: input.variant } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    },
    observed: {
      connectionId: input.connectionId,
      providerId: input.observed.providerId ?? input.providerId,
      modelId: observedModelId,
      ...(input.observed.variant ? { variant: input.observed.variant } : {}),
      ...(input.observed.serviceTier ? { serviceTier: input.observed.serviceTier } : {}),
    },
  });
  return observedModelId;
}

const CATALOG_REVISION = /^sha256:[a-f0-9]{64}$/u;

function observedOpenCodeEffort(
  input: Readonly<{
    model: Readonly<OpenCodeLiveModel>;
    observed: Readonly<OpenCodeObservedIdentity>;
    controls: Readonly<OpenCodeRequestControls>;
  }>,
): NonNullable<OpenCodeRequestControls['effort']> | 'provider-default' {
  if (input.controls.effort) return input.controls.effort;
  const observedVariant = input.observed.variant?.trim().toLocaleLowerCase('en-US');
  if (!observedVariant) return 'provider-default';
  const variant = input.model.variants.find(
    (candidate) => candidate.id.trim().toLocaleLowerCase('en-US') === observedVariant,
  );
  return (variant && variantReasoningEffort(variant)) || 'provider-default';
}

export function buildObservedOpenCodeGatewayAuthority(
  input: Readonly<{
    connection: ProviderRequest['connection'];
    model: Readonly<OpenCodeLiveModel>;
    observed: Readonly<OpenCodeObservedIdentity>;
    controls: Readonly<OpenCodeRequestControls>;
    catalogRevision: string;
  }>,
): Readonly<{
  executionIdentity: Readonly<
    import('@/features/context/gateway/contextGatewayContracts').ExecutionIdentity
  >;
  performance: OpenCodeRequestControls['performance'];
}> {
  if (
    input.controls.connectionId !== input.connection.id ||
    input.controls.providerId !== input.model.providerId ||
    input.controls.modelId !== input.model.upstreamModelId ||
    !CATALOG_REVISION.test(input.catalogRevision)
  ) {
    throw new Error('OpenCode observed Gateway authority does not match the dispatched route.');
  }
  const observedModelId = assertAuthoritativeOpenCodeIdentity({
    connectionId: input.connection.id,
    providerId: input.model.providerId,
    modelId: input.model.id,
    ...(input.controls.variant ? { variant: input.controls.variant } : {}),
    ...(input.controls.serviceTier ? { serviceTier: input.controls.serviceTier } : {}),
    observed: input.observed,
  });
  const observedVariant = input.observed.variant?.trim().toLocaleLowerCase('en-US');
  const catalogVariant = observedVariant
    ? input.model.variants.find(
        (candidate) => candidate.id.trim().toLocaleLowerCase('en-US') === observedVariant,
      )
    : undefined;
  const observedFastVariant =
    catalogVariant && isFastVariant(catalogVariant) ? catalogVariant.id : undefined;
  const normalizedServiceTier = input.observed.serviceTier?.trim().toLocaleLowerCase('en-US');
  const observedFastTier = ['fast', 'priority'].includes(normalizedServiceTier ?? '')
    ? input.observed.serviceTier
    : undefined;
  const fastVariant =
    observedFastVariant ??
    observedFastTier ??
    (input.model.isFastRoute ? input.model.upstreamModelId : undefined) ??
    (input.controls.openCodeFastMode ? undefined : 'standard');
  if (!fastVariant) {
    throw new Error('OpenCode Fast execution completed without an exact observed route variant.');
  }
  return Object.freeze({
    executionIdentity: Object.freeze({
      transportConnectionId: input.connection.id,
      transportAdapterId: input.connection.adapterId,
      upstreamProviderId: input.model.providerId,
      upstreamModelId: input.model.upstreamModelId,
      providerQualifiedModelId: observedModelId,
      authBillingRoute: input.connection.authSource,
      effort: observedOpenCodeEffort(input),
      fastVariant,
      catalogRevision: input.catalogRevision,
      observedProviderIdentity: observedModelId,
    }),
    performance: input.controls.performance,
  });
}

export function assertAuthoritativeOpenCodeCompletion(input: {
  observedModelId?: string;
  streamedText: string;
  canonicalText: string;
}): void {
  if (!input.observedModelId) {
    throw new Error('OpenCode completed without authoritative observed model identity.');
  }
  if (!input.streamedText.trim() && !input.canonicalText.trim()) {
    throw new Error('OpenCode completed without canonical assistant text.');
  }
}

export function shouldReconcileOpenCodeSessionCompletion(input: {
  status?: string;
  statusLookupSucceeded: boolean;
  streamedText: string;
  hasPersistedAssistantIdentity: boolean;
  hasPersistedAssistantCompletion: boolean;
}): boolean {
  if (input.status === 'idle') return input.hasPersistedAssistantCompletion;
  return Boolean(
    input.statusLookupSucceeded &&
    input.status === undefined &&
    input.streamedText.trim() &&
    input.hasPersistedAssistantIdentity &&
    input.hasPersistedAssistantCompletion,
  );
}

export function shouldFailOpenCodeTurnWithoutEvidence(input: {
  status?: string;
  statusLookupSucceeded: boolean;
  elapsedMs: number;
  hasTurnEvidence: boolean;
}): boolean {
  if (input.hasTurnEvidence || !input.statusLookupSucceeded) return false;
  if (input.status === 'idle') return true;
  return input.status === undefined && input.elapsedMs >= TURN_NO_EVIDENCE_GRACE_MS;
}

function persistedAssistantTurnSettled(messages: readonly OpenCodeMessageRecord[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (cleanIdentifier(message.info?.role, 32)?.toLocaleLowerCase('en-US') !== 'assistant') {
      continue;
    }
    // A completed tool-call step is not completion of the user's turn.
    if (message.info?.finish === 'tool-calls') return false;
    const completed = recordOf(message.info?.time)?.completed;
    if (completed === undefined || completed === null) return false;
    return !(message.parts ?? []).some((part) => {
      if (String(part.type).toLocaleLowerCase('en-US') !== 'tool') return false;
      const status = cleanIdentifier(recordOf(part.state)?.status, 64)?.toLocaleLowerCase('en-US');
      return !status || status === 'pending' || status === 'running';
    });
  }
  return false;
}

function persistedAssistantStoppedAfterToolError(messages: readonly OpenCodeMessageRecord[]): boolean {
  const latest = [...messages].reverse().find((message) => message.info?.role === 'assistant');
  if (latest?.info?.finish !== 'tool-calls' || !recordOf(latest.info.time)?.completed) return false;
  const statuses = (latest.parts ?? [])
    .filter((part) => part.type === 'tool')
    .map((part) => recordOf(part.state)?.status);
  return statuses.some((status) => status === 'error' || status === 'failed') &&
    statuses.every((status) => status === 'completed' || status === 'error' || status === 'failed');
}

export function publicTextFromTurnMessages(messages: readonly OpenCodeMessageRecord[]): string {
  return messages
    .filter((record) => {
      const role = cleanIdentifier(record.info?.role, 32)?.toLocaleLowerCase('en-US');
      return role === 'assistant';
    })
    .flatMap((record) => record.parts ?? [])
    .filter((part) =>
      ['text', 'agent_message'].includes(String(part.type).toLocaleLowerCase('en-US')),
    )
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export function openCodeChecklistSnapshotsFromMessages(
  messages: readonly OpenCodeMessageRecord[],
): readonly import('../openCodeChecklist').OpenCodeChecklistSnapshot[] {
  const snapshots = new Map<string, import('../openCodeChecklist').OpenCodeChecklistSnapshot>();
  for (const message of messages) {
    const role = cleanIdentifier(message.info?.role, 32)?.toLocaleLowerCase('en-US');
    if (role !== 'assistant') continue;
    for (const part of message.parts ?? []) {
      const state = recordOf(part.state);
      const snapshot = sanitizeOpenCodeChecklistSnapshot(
        part.tool ?? part.name,
        part.callID ?? part.callId ?? part.id,
        state?.input,
      );
      if (snapshot) snapshots.set(snapshot.callId, snapshot);
    }
  }
  return Object.freeze([...snapshots.values()]);
}

/**
 * The ProviderEvent transport is append-only. A canonical completion can add a
 * strict suffix, but a divergent canonical message must be left for the final
 * authoritative response replacement instead of being appended as a second
 * answer.
 */
export function canonicalOpenCodeTextSuffix(streamed: string, canonical: string): string {
  if (canonical === streamed || !canonical.startsWith(streamed)) return '';
  return canonical.slice(streamed.length);
}

/**
 * Maps private OpenCode message/part identity to bounded request-local labels.
 * Native identifiers can contain session and file-adjacent data, so they must
 * never cross the provider adapter boundary verbatim.
 */
export function createOpenCodeTextStreamPartTracker(): (partKey: string) => string {
  const streamIds = new Map<string, string>();
  return (partKey: string) => {
    const existing = streamIds.get(partKey);
    if (existing) return existing;
    const streamPartId = `opencode-text-${streamIds.size + 1}`;
    streamIds.set(partKey, streamPartId);
    return streamPartId;
  };
}

/** Maps private OpenCode tool-call identity to one request-local lifecycle key. */
export function createOpenCodeToolCallTracker(): (callId: string) => string {
  const callIds = new Map<string, string>();
  return (callId: string) => {
    const clean = cleanIdentifier(callId);
    if (!clean) throw new Error('OpenCode tool identity was invalid.');
    const existing = callIds.get(clean);
    if (existing) return existing;
    if (callIds.size >= 4_096) throw new Error('OpenCode tool identity bound was exceeded.');
    const localCallId = `opencode-tool-${callIds.size + 1}`;
    callIds.set(clean, localCallId);
    return localCallId;
  };
}

export function createGenerationSafeAsyncCache<Key, Value>(
  ttlMs: number | ((value: Value) => number),
): Readonly<{
  get: (key: Key, loader: () => Promise<Value>, force?: boolean) => Promise<Value>;
  peek: (key: Key) => Value | undefined;
  invalidate: () => void;
}> {
  const cache = new Map<Key, { loadedAt: number; value: Value }>();
  const loads = new Map<Key, { generation: number; promise: Promise<Value> }>();
  let generation = 0;
  return Object.freeze({
    get(key, loader, force = false): Promise<Value> {
      const cached = cache.get(key);
      if (
        !force &&
        cached &&
        Date.now() - cached.loadedAt < (typeof ttlMs === 'function' ? ttlMs(cached.value) : ttlMs)
      )
        return Promise.resolve(cached.value);
      const active = loads.get(key);
      if (!force && active?.generation === generation) return active.promise;
      const loadGeneration = generation;
      let promise: Promise<Value>;
      promise = loader()
        .then((value) => {
          if (loadGeneration === generation && loads.get(key)?.promise === promise) {
            cache.set(key, { loadedAt: Date.now(), value });
          }
          return value;
        })
        .finally(() => {
          if (loads.get(key)?.promise === promise) loads.delete(key);
        });
      loads.set(key, { generation: loadGeneration, promise });
      return promise;
    },
    peek(key): Value | undefined {
      return cache.get(key)?.value;
    },
    invalidate(): void {
      generation += 1;
      cache.clear();
      loads.clear();
    },
  });
}

const modelCatalogs = createGenerationSafeAsyncCache<string, readonly OpenCodeLiveModel[]>(
  (models) => (models.length === 0 ? EMPTY_MODEL_CACHE_TTL_MS : MODEL_CACHE_TTL_MS),
);

async function liveModels(
  scope: HarnessScope,
  force = false,
): Promise<readonly OpenCodeLiveModel[]> {
  const scopeKey = openCodeScopeKey(scope);
  return modelCatalogs.get(
    scopeKey,
    async () => {
      const entry = await sessions.clientForScope(scope);
      const client = entry.client as PersistentOpenCodeClient;
      const [providerState, providers] = await Promise.all([
        client.http.providerState(),
        client.listProviders(),
      ]);
      const connectedProviderIds = parseConnectedOpenCodeProviderIds(providerState);
      return filterOpenCodeModelsToConnectedProviders(
        parseOpenCodeLiveModels(providers),
        connectedProviderIds,
      );
    },
    force,
  );
}

const authProbes = createGenerationSafeAsyncCache<string, AuthProbeResult>(AUTH_CACHE_TTL_MS);
async function cachedAuthProbe(
  connection: ProviderRequest['connection'],
): Promise<AuthProbeResult> {
  return authProbes.get(connection.id, async (): Promise<AuthProbeResult> => {
    const cached = authProbes.peek(connection.id);
    try {
      const entry = await sessions.clientForScope(catalogScope);
      const client = entry.client as PersistentOpenCodeClient;
      const result = managedOpenCodeAuthResult(await client.http.providerState());
      // A timeout/unknown probe is not an authoritative sign-out and must not
      // erase the last verified authenticated snapshot.
      if (result.status === 'unknown' && cached?.status === 'authenticated') {
        return {
          ...cached,
          detail: result.detail
            ? `${cached.detail ?? 'Last verified authentication retained.'} ${result.detail}`
            : cached.detail,
        };
      }
      return result;
    } catch (error) {
      if (cached) return cached;
      return {
        status: 'unknown' as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
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
    ...(request.workingDirectory?.trim()
      ? { workingDirectory: request.workingDirectory.trim() }
      : {}),
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
  // Runtime sends carry the exact claim captured before asynchronous context
  // preparation. Preserve `null` as an intentional fail-closed result; only
  // omitted claims use the legacy direct-adapter fallback.
  const claim = request.toolGatewayAuthority !== undefined
    ? request.toolGatewayAuthority
    : captureToolGatewayAuthorityClaim();
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
  return (
    request.runtimeSettings ?? {
      effort: 'auto',
      fastMode: 'auto',
      performance: 'quality',
      rlmEnabled: true,
    }
  );
}

export function assertAuthoritativeOpenCodeRuntimeControls(
  settings: Pick<ChatRuntimeSettings, 'effort' | 'fastMode'>,
  model: OpenCodeLiveModel,
  connectionId: string,
): void {
  const resolution = resolveRuntimeModelControls(
    { effort: settings.effort, fastMode: settings.fastMode },
    modelMetadata(model, connectionId),
  );
  if (!resolution.ok) throw new Error(resolution.message);
}

export function contextSystemAddendum(
  request: Readonly<ProviderRequest>,
  settings: Readonly<ChatRuntimeSettings>,
): string {
  if (request.explicitReadSynthesis) {
    return [
      'VibeSpace Context route: GROUNDED SYNTHESIS.',
      'Use only the filesystem evidence already collected in this exact session.',
      'Do not call tools, add new factual claims, or substitute unavailable evidence during synthesis.',
    ].join(' ');
  }
  if (request.explicitReadRoot) {
    return [
      'VibeSpace Context route: DIRECT FILESYSTEM EVIDENCE.',
      'Before drafting or making factual claims, use this bounded evidence sequence inside the approved working directory: inventory the root itself with list or read; use bounded glob or grep for immediate repository and configuration markers; then read several representative high-signal entries.',
      'Do not use Context, RLM, web, shell, or recursive retrieval for this explicit-root turn.',
      'Separate observed facts from inference, state unavailable categories plainly, and do not treat one child file as a complete audit of a directory.',
      'If the bounded read-only sequence cannot complete, report that evidence is unavailable instead of answering from memory or unrelated context.',
    ].join(' ');
  }
  const question = request.prompt.trim();
  const historical = /\b(previous|history|old|earlier|decision|archive|look up|find in)\b/iu.test(
    question,
  );
  const broad = /\b(entire|whole|everything|every file|every chat|across all|root cause)\b/iu.test(
    question,
  );
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
    'Before asserting historical or cross-source facts, use the high-level VibeSpace tool `vibespace_context` with an explicit operation such as `search`.',
    'Treat returned pointers/provenance as opaque and fail closed: never forge, combine, clamp, or retarget pointers.',
    'If the tool returns no evidence or is unavailable, report that boundary once and continue every independent, authorized part of the request.',
    'Do not claim facts that required the missing evidence, and never invent support.',
  ].join(' ');
}

export function combineSystemPrompt(
  base: string | undefined,
  addendum: string,
  addendumFirst = false,
): string {
  const clean = base?.trim();
  if (clean && addendumFirst) return `${addendum}\n\n${clean}`;
  return clean ? `${clean}\n\n${addendum}` : addendum;
}

async function openCodeInstructionFingerprint(systemPrompt: string | undefined): Promise<string> {
  const digest = await globalThis.crypto?.subtle?.digest(
    'SHA-256',
    new TextEncoder().encode(systemPrompt?.trim() ?? ''),
  );
  if (!digest) throw new Error('OpenCode instruction fingerprint hashing is unavailable.');
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

export function toolsForPolicy(input: {
  mode: InteractionMode;
  access: AccessLevel;
  rlmEnabled: boolean;
  explicitReadRoot?: boolean;
  explicitReadSynthesis?: boolean;
  requested?: Readonly<Record<string, boolean>>;
}): Readonly<Record<string, boolean>> {
  if (input.explicitReadSynthesis || input.explicitReadRoot) {
    const disabled = new Set<string>([
      ...OPENCODE_BUILTIN_TOOL_NAMES,
      ...TOOL_GATEWAY_CATALOG,
      ...Object.keys(input.requested ?? {}).slice(0, 512),
    ]);
    const tools = Object.fromEntries([...disabled].map((name) => [name, false]));
    if (input.explicitReadRoot && !input.explicitReadSynthesis) {
      tools.read = true;
      tools.glob = true;
      tools.grep = true;
      tools.list = true;
    }
    return Object.freeze(tools);
  }
  const canWrite =
    !input.explicitReadRoot && input.mode === 'agent' && input.access !== 'read-only';
  const canTerminal = !input.explicitReadRoot && input.mode === 'agent' && input.access === 'full';
  const canSubagents = !input.explicitReadRoot && input.mode === 'agent';
  const baseline: Record<string, boolean> = {
    read: true,
    glob: true,
    grep: true,
    list: true,
    // OpenCode's native Plan agent must retain its user-question tool.
    question: true,
    webfetch: !input.explicitReadRoot,
    websearch: !input.explicitReadRoot,
    edit: canWrite,
    write: canWrite,
    patch: canWrite,
    bash: canTerminal,
    shell: canTerminal,
    task: canSubagents,
    todo: true,
    todoread: true,
    todowrite: true,
    vibespace_context: !input.explicitReadRoot && input.rlmEnabled,
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
      name !== 'agent.run' && name !== 'agent.run_many' &&
      (!mutating || canWrite) &&
      (!terminalLike || canTerminal) &&
      (!subagentLike || canSubagents);
  }
  bounded.vibespace_context =
    !input.explicitReadRoot && input.rlmEnabled && input.requested.vibespace_context === true;
  return Object.freeze(bounded);
}

async function* sendPersistent(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
  const modelId = request.modelId?.trim();
  if (!modelId) {
    reportPersistentTurnFailure('request_identity');
    throw new Error('OpenCode requires an exact model selection.');
  }
  const scope = (() => {
    try {
      return requestScope(request);
    } catch (error) {
      reportPersistentTurnFailure('request_scope');
      throw error;
    }
  })();
  const gatewayAuthority = (() => {
    try {
      return captureRequestGatewayAuthority(request);
    } catch (error) {
      reportPersistentTurnFailure('gateway_authority');
      throw error;
    }
  })();
  // Preserve only the trusted caller identity for the exact active provider turn.
  // The fallback chatId below is for OpenCode session continuity and is not Relay authority.
  const gatewayTurn = request.chatId
    ? {
        requestId: request.requestId,
        chatId: request.chatId,
        nativeToolMessageIds: true as const,
        ...(request.protectedAttempt ? { protectedAttempt: request.protectedAttempt } : {}),
      }
    : undefined;
  const chatId = request.chatId?.trim() || request.sessionId?.trim() || request.requestId;
  if ([...activeRequests.values()].some((active) => active.chatId === chatId)) {
    reportPersistentTurnFailure('turn_binding');
    throw new Error(
      'OpenCode chat already has an active request. Cancel it before starting another.',
    );
  }
  const scopeKey = openCodeScopeKey(scope);
  const acceptedTurn = acceptedTurnRegistry.load(request.requestId);
  if (acceptedTurn) {
    if (acceptedTurn.chatId !== chatId || acceptedTurn.scopeKey !== scopeKey) {
      reportPersistentTurnFailure('turn_binding');
      throw new Error('OpenCode accepted-turn identity changed after renderer recovery.');
    }
    yield {
      type: 'error',
      message:
        'OpenCode response was interrupted by a renderer restart. Retry to continue the persisted session.',
    };
    return;
  }
  const turn = (() => {
    try {
      return turnGate.begin(chatId, request.requestId);
    } catch (error) {
      reportPersistentTurnFailure('turn_binding');
      throw error;
    }
  })();
  let releaseRequest!: () => void;
  let rejectRelease!: (error: unknown) => void;
  const released = new Promise<void>((resolve, reject) => { releaseRequest = resolve; rejectRelease = reject; });
  void released.catch(() => undefined);
  activeRequests.set(request.requestId, { scope, chatId, released });
  const abortEvents = new AbortController();
  let boundSessionId: string | undefined;
  let retireCommand: (() => Promise<unknown>) | undefined;
  let rateLimitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const boundChildSessions = new Set<string>();
  let cancellationTask: Promise<void> | undefined;
  const abort = () => {
    turnGate.cancel(chatId);
    abortEvents.abort();
    cancellationTask ??= sessions.cancelChat(scope, chatId);
    void cancellationTask.catch(() => undefined);
  };
  request.signal?.addEventListener('abort', abort, { once: true });
  let failureStage: PersistentTurnFailureStage = 'session_binding';
  const requireActiveRequest = () => {
    if (request.signal?.aborted) {
      throw new DOMException('The OpenCode turn was aborted.', 'AbortError');
    }
  };

  try {
    requireActiveRequest();
    const timing = { requestId: request.requestId, chatId, model: modelId };
    // Explicit protected follow-ups are pinned to their bound session. Ordinary
    // chat turns rotate on agent instruction changes while retaining visible
    // VibeSpace history for the new provider session's first prompt.
    const instructionFingerprint = request.expectedSessionId
      ? undefined
      : await openCodeInstructionFingerprint(request.systemPrompt);
    const sessionReady = appActivityLog.trace('model.prepare.session', timing,
      () => sessions.sessionForChat(scope, chatId, undefined, instructionFingerprint, request.requestId));
    const [sessionResult, baselineResult, catalogResult] = await awaitOpenCodePreparation(Promise.allSettled([
      sessionReady,
      sessionReady.then((session) => {
        requireActiveRequest();
        const createdEmpty = sessions.consumeEmptyBaseline(session, request.requestId);
        return appActivityLog.trace('model.prepare.history', {
          ...timing,
          sessionId: session.sessionId,
          runtimeGeneration: session.runtimeGeneration,
          sessionOrigin: session.origin,
          baselineSource: createdEmpty ? 'created-empty' : 'native-history',
          // Existing fixed-field persistence retains eventType, not arbitrary
          // extra trace fields. Keep the branch/origin available after restart.
          eventType: `history-baseline.${session.origin}.${createdEmpty ? 'created-empty' : 'native-history'}`,
        }, () => createdEmpty
          ? Promise.resolve([] as readonly OpenCodeMessageRecord[])
          : (session.client as PersistentOpenCodeClient).http.messages(session.sessionId));
      }),
      appActivityLog.trace('model.prepare.catalog', timing, () => liveModels(scope)),
    ]), request.signal);
    requireActiveRequest();
    if (sessionResult.status === 'rejected') throw sessionResult.reason;
    const session = sessionResult.value;
    const client = session.client as PersistentOpenCodeClient;
    if (baselineResult.status === 'rejected') {
      failureStage = 'session_binding';
      throw baselineResult.reason;
    }
    if (catalogResult.status === 'rejected') {
      failureStage = 'live_model_authority';
      throw catalogResult.reason;
    }
    const baselineMessages = baselineResult.value;
    const baselineMessageIds = captureOpenCodeMessageBaseline(baselineMessages);
    failureStage = 'live_model_authority';
    const authoritativeCatalog = catalogResult.value;
    const liveModel = requireAuthoritativeOpenCodeModel(authoritativeCatalog, modelId);
    const catalogRevision = gatewayAuthority
      ? await openCodeCatalogRevision(authoritativeCatalog)
      : undefined;
    const authoritativeModelId = liveModel.id;
    const providerId = upstreamProviderId(liveModel.id);
    const mode = request.interactionMode ?? 'agent';
    const access =
      request.accessLevel ??
      (mode === 'ask' ? 'read-only' : mode === 'plan' ? 'read-only' : 'full');
    const eventIterator = client.http.events(abortEvents.signal)[Symbol.asyncIterator]();
    let eventStreamFailure: Readonly<ReturnType<typeof providerErrorDetails>> | undefined;
    const nextEventOrEof = (): Promise<IteratorResult<OpenCodeRawEvent>> =>
      eventIterator.next().catch((error: unknown) => {
        // The native event bridge can reject after a process stop or a
        // bounded-queue failure. Keep its already-sanitized reason while
        // still allowing the authoritative HTTP recovery path to reconcile
        // a completed persisted answer.
        eventStreamFailure = providerErrorDetails(error, {
          message: 'OpenCode event stream failed.',
        });
        return { done: true, value: undefined };
      });
    let pendingEvent = nextEventOrEof();
    let rateLimitStartedAt: number | undefined;
    let latestRateLimitDetails: Readonly<ReturnType<typeof persistentOpenCodeSessionErrorDetails>> | undefined;
    let rateLimitNoticeEmitted = false;
    let rateLimitDeadline:
      | { promise: Promise<void>; timer: ReturnType<typeof setTimeout> }
      | undefined;
    const armRateLimitDeadline = (): void => {
      if (rateLimitDeadline) return;
      let resolveDeadline!: () => void;
      const promise = new Promise<void>((resolve) => {
        resolveDeadline = resolve;
      });
      const timer = setTimeout(resolveDeadline, OPENCODE_RATE_LIMIT_RETRY_WINDOW_MS);
      rateLimitDeadlineTimer = timer;
      rateLimitDeadline = {
        promise,
        timer,
      };
    };
    const observeRateLimit = (
      details: Readonly<ReturnType<typeof persistentOpenCodeSessionErrorDetails>>,
    ): boolean => {
      if (!isProviderRateLimitError(details) || details.retryable === false) return false;
      if (rateLimitStartedAt === undefined) {
        rateLimitStartedAt = Date.now();
        armRateLimitDeadline();
      }
      latestRateLimitDetails = details;
      return true;
    };
    const takeRateLimitNotice = (): boolean => {
      if (rateLimitNoticeEmitted) return false;
      rateLimitNoticeEmitted = true;
      return true;
    };
    const clearRateLimitRetry = (): void => {
      if (rateLimitDeadline) clearTimeout(rateLimitDeadline.timer);
      rateLimitDeadlineTimer = undefined;
      rateLimitDeadline = undefined;
      rateLimitStartedAt = undefined;
      latestRateLimitDetails = undefined;
      rateLimitNoticeEmitted = false;
    };
    const settings = defaultRuntimeSettings(request);
    failureStage = 'runtime_controls';
    assertAuthoritativeOpenCodeRuntimeControls(settings, liveModel, request.connection.id);
    const systemPrompt = combineSystemPrompt(
      request.systemPrompt,
      contextSystemAddendum(request, settings),
      request.explicitReadRoot === true,
    );
    requireActiveRequest();
    // The provider may execute tools before the prompt acknowledgement reaches
    // the renderer. Bind the prepared session first; finally releases it even
    // when dispatch fails or acknowledgement reconciliation times out.
    failureStage = 'session_authority';
    if (
      gatewayAuthority &&
      !bindToolGatewaySessionAuthority(
        session.sessionId,
        gatewayAuthority,
        request.signal,
        gatewayTurn,
      )
    ) {
      throw new Error('Tool Gateway session authority changed before dispatch.');
    }
    boundSessionId = session.sessionId;
    failureStage = 'prompt_dispatch';
    const receiptBinding = await toolReceiptBinding(request, session.runtimeGeneration).catch(() => ({}));
    const releaseToolReceipt = client.http.bindToolReceipt(session.sessionId, receiptBinding);
    const dispatch = await coordinator.dispatch({
      scope,
      chatId,
      instructionFingerprint,
      // A preflight failure can leave a bound session with no accepted prompt.
      // Restore the bounded local history once; established sessions already own it.
      text: baselineMessages.length === 0 ? selectOpenCodeDispatchPrompt(request) : request.prompt,
      ...(request.parts?.length ? { parts: request.parts } : {}),
      settings,
      selection: {
        connectionId: request.connection.id,
        providerId,
        modelId: liveModel.upstreamModelId,
        metadata: modelMetadata(liveModel, request.connection.id),
      },
      policy: {
        mode,
        access,
        agentApprovalMode: request.agentApprovalMode,
        approveAllForRun: request.approveAllForRun === true,
        projectRoot: scope.workingDirectory ?? request.workingDirectory ?? '.',
      },
      system: systemPrompt,
      nativeSkillRefs: request.nativeSkillRefs,
      tools: toolsForPolicy({
        mode,
        access,
        rlmEnabled: settings.rlmEnabled,
        explicitReadRoot: request.explicitReadRoot,
        explicitReadSynthesis: request.explicitReadSynthesis,
        requested: request.tools,
      }),
      expectedSessionId: request.expectedSessionId ?? session.sessionId,
      requireExactRuntimeControls: request.explicitReadRoot === true,
      signal: abortEvents.signal,
    }).finally(releaseToolReceipt);
    if (dispatch.kind === 'command')
      throw new Error('VibeSpace slash commands must be consumed before provider dispatch.');
    if (dispatch.kind === 'rejected') throw new Error(dispatch.message);
    if (dispatch.commandOutcome) {
      retireCommand = () => client.abort(dispatch.sessionId).catch(() => undefined);
    }
    if (request.signal?.aborted) {
      // The first abort may have reached the server before this prompt was accepted.
      // Retire the late acceptance before releasing the conversation for its next turn.
      await client.abort(dispatch.sessionId).catch(() => undefined);
      requireActiveRequest();
    }
    if (dispatch.sessionId !== session.sessionId) {
      await client.abort(dispatch.sessionId).catch(() => undefined);
      throw new Error('OpenCode session identity changed after the current-turn baseline.');
    }
    acceptedTurnRegistry.save({
      requestId: request.requestId,
      chatId,
      scopeKey,
      sessionId: dispatch.sessionId,
      runtimeGeneration: session.runtimeGeneration,
    });
    const requestedVariant = dispatch.controls.variant ?? dispatch.controls.effort;
    const observeAuthoritativeIdentity = (
      identity: Readonly<OpenCodeObservedIdentity>,
    ): string | undefined => {
      const observedModel = assertAuthoritativeOpenCodeIdentity({
        connectionId: request.connection.id,
        providerId,
        modelId: authoritativeModelId,
        observed: {
          ...(identity.providerId ? { providerId: identity.providerId } : {}),
          modelId: identity.modelId,
        },
      });
      if (requestedVariant && !identity.variant) return undefined;
      if (dispatch.controls.serviceTier && !identity.serviceTier) return undefined;
      assertAuthoritativeOpenCodeIdentity({
        connectionId: request.connection.id,
        providerId,
        modelId: authoritativeModelId,
        ...(requestedVariant ? { variant: requestedVariant } : {}),
        ...(dispatch.controls.serviceTier ? { serviceTier: dispatch.controls.serviceTier } : {}),
        observed: {
          ...(identity.providerId ? { providerId: identity.providerId } : {}),
          modelId: identity.modelId,
          ...(identity.variant ? { variant: identity.variant } : {}),
          ...(dispatch.controls.serviceTier && identity.serviceTier
            ? { serviceTier: identity.serviceTier }
            : {}),
        },
      });
      if (gatewayAuthority && catalogRevision) {
        const observedAuthority = buildObservedOpenCodeGatewayAuthority({
          connection: request.connection,
          model: liveModel,
          observed: identity,
          controls: dispatch.controls,
          catalogRevision,
        });
        if (
          !bindToolGatewayObservedExecutionAuthority(
            dispatch.sessionId,
            gatewayAuthority,
            observedAuthority,
          )
        ) {
          throw new Error('Observed OpenCode Tool Gateway identity changed during the session.');
        }
      }
      return observedModel;
    };
    boundSessionId = dispatch.sessionId;
    failureStage = 'session_authority';
    if (
      gatewayAuthority &&
      !bindToolGatewaySessionAuthority(
        dispatch.sessionId,
        gatewayAuthority,
        request.signal,
        gatewayTurn,
      )
    ) {
      await client.abort(dispatch.sessionId).catch(() => undefined);
      throw new Error('Tool Gateway session authority changed before dispatch.');
    }
    activeApprovalSessions.set(dispatch.sessionId, {
      requestId: request.requestId,
      http: client.http,
      approvals: new Map(),
      ...(gatewayAuthority ? { gatewayAuthority } : {}),
    });
    activeQuestionSessions.set(dispatch.sessionId, {
      requestId: request.requestId,
      http: client.http,
      pending: new Map(),
      settled: new Set(),
      authorities: new Map(),
    });
    await request.onSessionBound?.({ sessionId: dispatch.sessionId });
    yield { type: 'session', sessionId: dispatch.sessionId };

    const accumulator = new OpenCodeTextAccumulator();
    const streamPartIdFor = createOpenCodeTextStreamPartTracker();
    const toolCallIdFor = createOpenCodeToolCallTracker();
    const emittedToolStates = new Set<string>();
    const liveMessageRoles = new Map<string, string>();
    let latestLiveMessageRole: string | undefined;
    let latestTextStreamPartId: string | undefined;
    let emittedText = '';
    let observedModelId: string | undefined;
    let done = false;
    let finishReason = 'stop';
    const startedAt = Date.now();
    failureStage = 'event_stream';
    const toolStateKey = (tool: Extract<ProviderEvent, { type: 'tool' }>): string =>
      (tool.callId ?? tool.name) + ':' + tool.status;
    // Keep only the latest bounded display snapshot, not every output revision.
    const latestToolDetails = new Map<string, string>();
    const shouldEmitTool = (tool: Extract<ProviderEvent, { type: 'tool' }>): boolean => {
      const id = tool.callId ?? tool.name;
      if (tool.status === 'started' && (emittedToolStates.has(id + ':completed') || emittedToolStates.has(id + ':failed'))) return false;
      const key = toolStateKey(tool);
      const details = tool.details ? JSON.stringify(tool.details) : '';
      if (emittedToolStates.has(key) && (!details || latestToolDetails.get(id) === details)) return false;
      emittedToolStates.add(key);
      latestToolDetails.delete(id);
      latestToolDetails.set(id, details);
      if (latestToolDetails.size > 64) latestToolDetails.delete(latestToolDetails.keys().next().value!);
      return true;
    };
    const requestLocalTool = (
      tool: ProviderEvent | undefined,
    ): Extract<ProviderEvent, { type: 'tool' }> | undefined => {
      if (tool?.type !== 'tool' || !tool.callId) return undefined;
      const callId = toolCallIdFor(tool.callId);
      return {
        ...tool,
        callId,
        ...(tool.checklist ? { checklist: { ...tool.checklist, callId } } : {}),
      };
    };
    const reconcilePersistedEvents = (messages: readonly unknown[]): ProviderEvent[] => {
      const recovered: ProviderEvent[] = [];
      for (const rawMessage of messages) {
        const message = recordOf(rawMessage);
        const info = recordOf(message?.info);
        if (cleanIdentifier(info?.role, 64)?.toLocaleLowerCase('en-US') !== 'assistant') continue;
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        for (const rawPart of parts) {
          const part = recordOf(rawPart);
          if (!part) continue;
          const update = extractOpenCodeTextPartUpdate({
            type: 'message.part.updated',
            properties: { part },
          });
          if (update) {
            const emission = accumulator.ingest({ ...update, authoritativeSnapshot: true });
            if (
              emission.channel === 'text' &&
              (emission.kind === 'delta' || emission.kind === 'replace') &&
              emission.text
            ) {
              latestTextStreamPartId = streamPartIdFor(emission.partKey);
              recovered.push({
                type: 'text',
                delta: emission.text,
                ...(emission.kind === 'replace' ? { mode: 'replace' as const } : {}),
                streamPartId: latestTextStreamPartId,
              });
            }
          }
          const tool = requestLocalTool(
            normalizeToolEvent({ type: 'message.part.updated', properties: { part } }, request),
          );
          if (!tool) continue;
          if (tool.status !== 'started') {
            const started = { ...tool, status: 'started' as const };
            const startedKey = toolStateKey(started);
            if (!emittedToolStates.has(startedKey)) {
              emittedToolStates.add(startedKey);
              recovered.push(started);
            }
          }
          if (shouldEmitTool(tool)) {
            // Only the original current-turn tool state proves progress. A
            // synthetic started receipt for a persisted failed tool must not
            // clear the provider's active retry deadline.
            if (tool.status !== 'failed') clearRateLimitRetry();
            recovered.push(tool);
          }
        }
      }
      emittedText = accumulator.fullText('text');
      return recovered;
    };
    const registerQuestion = async (
      question: Extract<ProviderEvent, { type: 'question' }>,
    ): Promise<boolean> => {
      const active = activeQuestionSessions.get(question.request.sessionId);
      if (!active || active.requestId !== request.requestId) {
        await client.abort(dispatch.sessionId).catch(() => undefined);
        throw new Error('OpenCode question arrived outside the active request binding.');
      }
      // A successful reply may race a stale event or recovery snapshot.
      if (active.settled.has(`${question.request.sessionId}\u0000${question.request.id}`)) return false;
      const existing = active.pending.get(question.request.id);
      if (
        existing &&
        (existing.sessionId !== question.request.sessionId ||
          !sameQuestionTool(existing.tool, question.request.tool))
      ) {
        await client.abort(dispatch.sessionId).catch(() => undefined);
        throw new Error('OpenCode question authority changed while waiting.');
      }
      if (existing) return false;
      active.pending.set(question.request.id, question.request);
      return true;
    };
    const registerApproval = async (approval: Readonly<VibeSpaceApproval>): Promise<boolean> => {
      const active = activeApprovalSessions.get(approval.sessionId);
      if (!active || active.requestId !== request.requestId) {
        await client.abort(dispatch.sessionId).catch(() => undefined);
        throw new Error('OpenCode approval arrived outside the active request binding.');
      }
      // Recovery snapshots may predate a successful reply. Never project that
      // already-settled control again or keep the turn waiting on it.
      if (settledApprovalResponses.has(`${approval.sessionId}\u0000${approval.id}`)) return false;
      const existing = active.approvals.get(approval.id);
      if (existing) {
        if (
          existing.sessionId !== approval.sessionId ||
          existing.capability !== approval.capability ||
          existing.title !== approval.title ||
          JSON.stringify(existing.pattern) !== JSON.stringify(approval.pattern)
        ) {
          await client.abort(dispatch.sessionId).catch(() => undefined);
          throw new Error('OpenCode approval authority changed while waiting.');
        }
        return false;
      }
      const registered = Object.freeze({ ...approval });
      active.approvals.set(approval.id, registered);
      if (!request.onApprovalRequested) {
        await respondToPersistentOpenCodeApproval({
          sessionId: approval.sessionId,
          approvalId: approval.id,
          response: 'reject',
        }).catch(() => undefined);
        throw new Error('OpenCode requested approval without an active approval handler.');
      }
      await request.onApprovalRequested(registered);
      return true;
    };
    const controlSession = async (event: OpenCodeRawEvent): Promise<string | undefined> => {
      if (eventSessionId(event) === dispatch.sessionId) return dispatch.sessionId;
      if (done || abortEvents.signal.aborted ||
        (boundChildSessions.size >= 64 && !boundChildSessions.has(eventSessionId(event) ?? ''))) return;
      const child = await resolveOpenCodeChildControl(event, dispatch.sessionId, async id =>
        unwrapData(await requestJson(client.http.handle.generation, client.http.handle.scope,
          `/session/${encodeURIComponent(id)}`, { signal: abortEvents.signal }, 5_000)),
      );
      if (!child || done || abortEvents.signal.aborted) return;
      const approvals = activeApprovalSessions.get(dispatch.sessionId);
      const questions = activeQuestionSessions.get(dispatch.sessionId);
      if (approvals?.requestId !== request.requestId || questions?.requestId !== request.requestId) return;
      const existing = activeApprovalSessions.get(child);
      if (existing && existing.requestId !== request.requestId) return;
      if (
        gatewayAuthority &&
        !bindToolGatewaySessionAuthority(child, gatewayAuthority, request.signal, gatewayTurn)
      ) {
        return;
      }
      activeApprovalSessions.set(child, approvals);
      activeQuestionSessions.set(child, questions);
      boundChildSessions.add(child);
      return child;
    };
    const recoverPendingApprovals = async (register = true): Promise<VibeSpaceApproval[]> => {
      const propertiesList = await client.http.pendingPermissions().catch(() => []);
      const recovered: VibeSpaceApproval[] = [];
      if (done || abortEvents.signal.aborted) return recovered;
      for (const properties of propertiesList) {
        const sessionId = await controlSession({ type: 'permission.asked', properties });
        if (!sessionId) continue;
        for (const event of normalizeOpenCodeEvent(
          { type: 'permission.asked', properties }, sessionId,
        )) {
          if (event.type === 'approval.requested' && (!register || await registerApproval(event.approval))) recovered.push(event.approval);
        }
      }
      return recovered;
    };
    const recoverPendingQuestions = async (register = true): Promise<
      Extract<ProviderEvent, { type: 'question' }>[]
    > => {
      const propertiesList = await client.http.pendingQuestions().catch(() => []);
      if (done || abortEvents.signal.aborted) return [];
      const recovered: Extract<ProviderEvent, { type: 'question' }>[] = [];
      for (const properties of propertiesList) {
        const sessionId = await controlSession({ type: 'question.asked', properties });
        if (!sessionId) continue;
        const question = normalizeQuestionEvent(
          { type: 'question.asked', properties },
          sessionId,
        );
        if (question && (!register || await registerQuestion(question))) recovered.push(question);
      }
      return recovered;
    };

    // Recovery is concurrent with SSE: a slow HTTP read must never hold up
    // text, questions, approvals or tool lifecycle events already on the stream.
    let streamRevision = 0;
    const schedulePoll = (delay = TURN_IDLE_POLL_MS) => (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (done || abortEvents.signal.aborted) throw new DOMException("Recovery stopped", "AbortError");
      const revision = streamRevision;
      const [statusLookup, recoveredQuestions, recoveredApprovals, messages] = await Promise.all([
          client.http
            .status(dispatch.sessionId)
            .then((value) => ({ succeeded: true as const, value }))
            .catch((error: unknown) => {
              const reason = error instanceof Error ? error.message : error;
              // Native generation loss is terminal for this accepted turn. A
              // replacement runtime must never silently inherit its live state.
              if (reason === 'OpenCode managed server is unavailable.' ||
                  reason === 'OpenCode managed server generation is unavailable.') {
                throw new Error('OpenCode runtime disconnected. Retry to reconnect.');
              }
              return { succeeded: false as const, value: undefined };
            }),
          recoverPendingQuestions(false),
          recoverPendingApprovals(false),
          client.http.messages(dispatch.sessionId).catch(() => []),
        ]);
      return { kind: 'poll' as const, statusLookup, recoveredQuestions, recoveredApprovals, messages, revision };
    })().catch((error: unknown) => ({ kind: 'poll' as const, error }));
    let pendingPoll = schedulePoll();
    let pendingCommand = dispatch.commandOutcome?.then((outcome) => ({ kind: 'command' as const, outcome }));
    let lastPublicTimeline = '';
    let idleFailedTool: { signature: string; since: number } | undefined;

    while (!done) {
      if (!turnGate.isCurrent(turn))
        throw new DOMException('The OpenCode turn was superseded.', 'AbortError');
      if (request.signal?.aborted)
        throw new DOMException('The OpenCode turn was aborted.', 'AbortError');
      if (shouldStopOpenCodeRateLimitRetry(rateLimitStartedAt)) {
        await abortOpenCodeRateLimitSession(client, dispatch.sessionId);
        finishReason = 'error';
        yield openCodeRateLimitRetryTimeout(latestRateLimitDetails);
        return;
      }
      if (Date.now() - startedAt > TURN_MAX_WALL_MS) {
        await client.abort(dispatch.sessionId).catch(() => undefined);
        throw new Error('OpenCode turn exceeded the maximum wall time.');
      }

      const next = await Promise.race([
        pendingPoll,
        pendingEvent.then((value) => ({ kind: 'event' as const, value })),
        ...(pendingCommand ? [pendingCommand] : []),
        ...(rateLimitDeadline
          ? [rateLimitDeadline.promise.then(() => ({ kind: 'rate-limit-timeout' as const }))]
          : []),
      ]);
      if (next.kind === 'rate-limit-timeout') {
        await abortOpenCodeRateLimitSession(client, dispatch.sessionId);
        finishReason = 'error';
        yield openCodeRateLimitRetryTimeout(latestRateLimitDetails);
        return;
      }
      if (next.kind === 'command') {
        pendingCommand = undefined;
        if (!next.outcome.ok) {
          failureStage = 'prompt_dispatch';
          throw next.outcome.error;
        }
        // The HTTP response alone is not completion evidence. Reconcile the
        // authoritative messages/status through the existing poll/event path.
        pendingPoll = schedulePoll(0);
        continue;
      }
      if (next.kind === 'poll') {
        pendingPoll = schedulePoll();
        if ('error' in next) throw next.error;
        const { statusLookup, recoveredQuestions, recoveredApprovals, messages } = next;
        for (const approval of recoveredApprovals) await registerApproval(approval);
        for (const question of recoveredQuestions) {
          if (!await registerQuestion(question)) continue;
          yield* questionEventsWithActivity(question, toolCallIdFor, emittedToolStates,
            () => request.onActionDispatch?.({ observedAt: Date.now() }));
        }
        // An HTTP snapshot started before newer SSE parts cannot replace them.
        if (next.revision !== streamRevision) continue;
        const status = statusType(statusLookup.value);
        const currentTurnMessages = currentTurnOpenCodeMessages(messages, baselineMessageIds);
        for (const recovered of reconcilePersistedEvents(currentTurnMessages)) {
          if (recovered.type === 'text') {
            request.onResponseObservation?.({
              kind: 'bytes',
              byteLength: new TextEncoder().encode(recovered.delta).byteLength,
              observedAt: Date.now(),
            });
          }
          yield recovered;
        }
        const publicTimeline = projectOpenCodePublicTimeline(currentTurnMessages, { workingDirectory: scope.workingDirectory, toolCallIdFor });
        if (request.signal?.aborted)
          throw new DOMException('The OpenCode turn was aborted.', 'AbortError');
        const timelineIdentity = JSON.stringify(publicTimeline);
        if ((publicTimeline.finalText || publicTimeline.timeline.length > 0) &&
            timelineIdentity !== lastPublicTimeline) {
          lastPublicTimeline = timelineIdentity;
          yield { type: 'public_timeline', snapshot: publicTimeline };
        }
        const canonical = publicTextFromTurnMessages(currentTurnMessages);
        const messageIdentity = observedAssistantIdentity(currentTurnMessages);
        if (messageIdentity) {
          observedModelId = observeAuthoritativeIdentity(messageIdentity) ?? observedModelId;
        }
        let canonicalProgress = false;
        if (canonical && canonical !== emittedText) {
          const delta = canonicalOpenCodeTextSuffix(emittedText, canonical);
          if (delta) {
            request.onResponseObservation?.({
              kind: 'bytes',
              byteLength: new TextEncoder().encode(delta).byteLength,
              observedAt: Date.now(),
            });
            yield { type: 'text', delta, streamPartId: latestTextStreamPartId };
            emittedText = canonical;
            canonicalProgress = true;
          }
        }
        if (rateLimitStartedAt !== undefined && canonicalProgress) clearRateLimitRetry();
        if (status === 'error') {
          finishReason = 'error';
          const statusEvent: OpenCodeRawEvent = {
            type: 'session.status',
            properties: {
              sessionID: dispatch.sessionId,
              status: statusLookup.value,
            },
          };
          const statusDetails = persistentOpenCodeSessionErrorDetails(statusEvent, dispatch.sessionId);
          const statusHasProviderDetails = Boolean(
            statusDetails.code || statusDetails.providerId || statusDetails.modelId ||
            statusDetails.retryable !== undefined || statusDetails.retryAfterMs !== undefined ||
            statusDetails.resetAt !== undefined,
          );
          const errorDetails = eventStreamFailure && !statusHasProviderDetails &&
            isGenericPersistentOpenCodeSessionError(statusDetails.message)
            ? eventStreamFailure
            : statusDetails;
          if (observeRateLimit(errorDetails)) {
            if (takeRateLimitNotice()) {
              yield openCodeRateLimitRetryNotice(errorDetails, {
                providerId,
                modelId: liveModel.upstreamModelId,
              });
            }
            continue;
          }
          reportPersistentTurnFailure('provider_reported');
          yield {
            type: 'error',
            message: errorDetails.message,
            ...(errorDetails.code ? { code: errorDetails.code } : {}),
            ...(errorDetails.providerId ? { providerId: errorDetails.providerId } : {}),
            ...(errorDetails.modelId ? { modelId: errorDetails.modelId } : {}),
            ...(errorDetails.retryable === undefined ? {} : { retryable: errorDetails.retryable }),
            ...(errorDetails.retryAfterMs === undefined ? {} : { retryAfterMs: errorDetails.retryAfterMs }),
            ...(errorDetails.resetAt === undefined ? {} : { resetAt: errorDetails.resetAt }),
          };
          return;
        }
        const hasPendingQuestion =
          (activeQuestionSessions.get(dispatch.sessionId)?.pending.size ?? 0) > 0;
        const hasPendingApproval =
          (activeApprovalSessions.get(dispatch.sessionId)?.approvals.size ?? 0) > 0;
        // Some native versions stop after a rejected tool without emitting a
        // final assistant turn. Require repeated, unchanged authoritative idle
        // evidence so a transient idle between agent steps can still recover.
        if (statusLookup.succeeded && (status === 'idle' || status === undefined) &&
            !hasPendingQuestion && !hasPendingApproval &&
            persistedAssistantStoppedAfterToolError(currentTurnMessages)) {
          const signature = `${streamRevision}:${timelineIdentity}`;
          if (idleFailedTool?.signature !== signature) {
            idleFailedTool = { signature, since: Date.now() };
          } else if (Date.now() - idleFailedTool.since >= TURN_IDLE_FAILED_TOOL_GRACE_MS) {
            const usage = completedOpenCodeTurnUsage(currentTurnMessages);
            if (usage) yield { type: 'usage', usage };
            yield {
              type: 'error',
              code: 'opencode_stopped_after_tool_error',
              message: 'OpenCode stopped after a tool failed. Retry to continue this session.',
              retryable: true,
            };
            return;
          }
        } else {
          idleFailedTool = undefined;
        }
        const hasTurnEvidence = Boolean(
          currentTurnMessages.length > 0 ||
          emittedText.trim() ||
          emittedToolStates.size > 0 ||
          hasPendingQuestion ||
          hasPendingApproval,
        );
        if (
          shouldFailOpenCodeTurnWithoutEvidence({
            status,
            statusLookupSucceeded: statusLookup.succeeded,
            elapsedMs: Date.now() - startedAt,
            hasTurnEvidence,
          })
        ) {
          await client.abort(dispatch.sessionId).catch(() => undefined);
          if (eventStreamFailure) {
            const failure = new Error(eventStreamFailure.message);
            Object.assign(failure, eventStreamFailure);
            throw failure;
          }
          throw new Error('OpenCode turn ended before current-turn output became available.');
        }
        if (status === 'idle' || (statusLookup.succeeded && status === undefined)) {
          done =
            !hasPendingQuestion &&
            !hasPendingApproval &&
            shouldReconcileOpenCodeSessionCompletion({
              status,
              statusLookupSucceeded: statusLookup.succeeded,
              streamedText: emittedText,
              hasPersistedAssistantIdentity: Boolean(messageIdentity),
              hasPersistedAssistantCompletion: persistedAssistantTurnSettled(currentTurnMessages),
            });
        }
        continue;
      }
      if (next.value.done) {
        // OpenCode v2 feeds can close between flushes and omit question/idle
        // events. Disable this exhausted iterator and let the authoritative
        // status, message, and pending-question polls reconcile the turn.
        pendingEvent = new Promise<IteratorResult<OpenCodeRawEvent>>(() => undefined);
        continue;
      }
      const event = next.value.value;
      pendingEvent = nextEventOrEof();
      const eventScope = eventSessionId(event);
      reconcileNativeApprovalReply(client.http.handle.generation, event);
      if (eventScope && eventScope !== dispatch.sessionId) {
        const child = await controlSession(event);
        if (child) {
          for (const normalized of normalizeOpenCodeEvent(event, child)) {
            if (normalized.type === 'approval.requested') await registerApproval(normalized.approval);
          }
          const question = normalizeQuestionEvent(event, child);
          if (question && await registerQuestion(question)) {
            yield* questionEventsWithActivity(question, toolCallIdFor, emittedToolStates,
              () => request.onActionDispatch?.({ observedAt: Date.now() }));
          }
        }
        continue;
      }
      if (event.type.startsWith('message.')) streamRevision += 1;

      if (event.type === 'message.updated') {
        const info = recordOf(event.properties?.info ?? event.properties?.message);
        const role = cleanIdentifier(info?.role, 32)?.toLocaleLowerCase('en-US');
        const messageId = cleanIdentifier(info?.id ?? info?.messageID ?? info?.messageId, 512);
        if (role) {
          latestLiveMessageRole = role;
          if (messageId) liveMessageRoles.set(messageId, role);
        }
      }

      const normalizedEvents = normalizeOpenCodeEvent(event, dispatch.sessionId);
      for (const normalized of normalizedEvents) {
        if (normalized.type !== 'approval.requested') continue;
        await registerApproval(normalized.approval);
      }

      const identity = observedIdentity(event);
      if (identity.modelId) {
        const firstObservation = !observedModelId;
        observedModelId = observeAuthoritativeIdentity(identity) ?? observedModelId;
        if (firstObservation && observedModelId) {
          yield { type: 'model', modelId: observedModelId };
        }
      }

      const livePart =
        event.type === 'message.part.updated' ? recordOf(event.properties?.part) : undefined;
      const livePartMessageId = cleanIdentifier(livePart?.messageID ?? livePart?.messageId, 512);
      const livePartRole =
        (livePartMessageId ? liveMessageRoles.get(livePartMessageId) : undefined) ??
        latestLiveMessageRole;
      const update =
        livePartRole && livePartRole !== 'assistant'
          ? undefined
          : extractOpenCodeTextPartUpdate(event);
      if (update) {
        const emission = accumulator.ingest(update);
        if (emission.channel === 'text' && emission.kind !== 'noop' && emission.text) {
          clearRateLimitRetry();
        }
        if (emission.channel === 'reasoning' && emission.kind !== 'noop') {
          yield { type: 'reasoning', delta: emission.kind === 'replace'
            ? accumulator.fullText('reasoning') : emission.text,
            ...(emission.kind === 'replace' ? { mode: 'replace' as const } : {}) };
        }
        if (emission.kind === 'delta' && emission.channel === 'text' && emission.text) {
          latestTextStreamPartId = streamPartIdFor(emission.partKey);
          emittedText = accumulator.fullText('text');
          request.onResponseObservation?.({
            kind: 'bytes',
            byteLength: new TextEncoder().encode(emission.text).byteLength,
            observedAt: Date.now(),
          });
          yield { type: 'text', delta: emission.text, streamPartId: latestTextStreamPartId };
        } else if (emission.kind === 'replace' && emission.channel === 'text') {
          latestTextStreamPartId = streamPartIdFor(emission.partKey);
          emittedText = accumulator.fullText('text');
          request.onResponseObservation?.({
            kind: 'bytes',
            byteLength: new TextEncoder().encode(emission.text).byteLength,
            observedAt: Date.now(),
          });
          yield {
            type: 'text',
            delta: emission.text,
            mode: 'replace',
            streamPartId: latestTextStreamPartId,
          };
        }
      }
      const tool = requestLocalTool(normalizeToolEvent(event, request));
      if (tool) {
        const firstStart = tool.type === 'tool' && tool.status === 'started' && !emittedToolStates.has(toolStateKey(tool));
        const isNovelTool = tool.type === 'tool' && shouldEmitTool(tool);
        if (tool.type === 'tool' && !isNovelTool) continue;
        if (isNovelTool && tool.status !== 'failed') clearRateLimitRetry();
        if (firstStart) {
          request.onActionDispatch?.({ observedAt: Date.now() });
        }
        yield tool;
        if (tool.type === 'tool' && tool.name === 'question' && tool.status === 'started') {
          pendingPoll = schedulePoll(0);
        }
      }
      const question = normalizeQuestionEvent(event, dispatch.sessionId);
      if (question && (await registerQuestion(question))) {
        yield* questionEventsWithActivity(question, toolCallIdFor, emittedToolStates,
          () => request.onActionDispatch?.({ observedAt: Date.now() }));
      }
      const usage = normalizePersistentOpenCodeUsage(event);
      if (usage) yield { type: 'usage', usage };
      if (event.type === 'session.error') {
        const errorDetails = persistentOpenCodeSessionErrorDetails(event, dispatch.sessionId);
        if (observeRateLimit(errorDetails)) {
          if (takeRateLimitNotice()) {
            yield openCodeRateLimitRetryNotice(errorDetails, {
              providerId,
              modelId: liveModel.upstreamModelId,
            });
          }
          continue;
        }
        reportPersistentTurnFailure('provider_reported');
        yield {
          type: 'error',
          ...errorDetails,
        };
        return;
      }
      if (event.type === 'session.idle') pendingPoll = schedulePoll(0);
      if (event.type === 'session.status') {
        const status = statusType(event.properties?.status);
        if (status === 'idle') pendingPoll = schedulePoll(0);
        if (status === 'error') {
          finishReason = 'error';
          const errorDetails = persistentOpenCodeSessionErrorDetails(event, dispatch.sessionId);
          if (observeRateLimit(errorDetails)) {
            if (takeRateLimitNotice()) {
              yield openCodeRateLimitRetryNotice(errorDetails, {
                providerId,
                modelId: liveModel.upstreamModelId,
              });
            }
            continue;
          }
          reportPersistentTurnFailure('provider_reported');
          yield {
            type: 'error',
            ...errorDetails,
          };
          return;
        }
      }
    }

    failureStage = 'completion_authority';
    const messages = await client.http.messages(dispatch.sessionId).catch(() => []);
    const currentTurnMessages = currentTurnOpenCodeMessages(messages, baselineMessageIds);
    for (const recovered of reconcilePersistedEvents(currentTurnMessages)) {
      if (recovered.type === 'text') {
        request.onResponseObservation?.({
          kind: 'bytes',
          byteLength: new TextEncoder().encode(recovered.delta).byteLength,
          observedAt: Date.now(),
        });
      }
      yield recovered;
    }
    const publicTimeline = projectOpenCodePublicTimeline(currentTurnMessages, { workingDirectory: scope.workingDirectory, toolCallIdFor });
    if (publicTimeline.finalText || publicTimeline.timeline.length > 0) {
      const counts = publicTimeline.timeline.reduce(
        (current, part) => ({
          text: current.text + (part.kind === 'text' ? 1 : 0),
          calls: current.calls + (part.kind === 'tool_call' ? 1 : 0),
          results: current.results + (part.kind === 'tool_result' ? 1 : 0),
        }),
        { text: 0, calls: 0, results: 0 },
      );
      console.debug('OpenCode public timeline projected.', {
        checkpointTextParts: counts.text,
        toolCalls: counts.calls,
        toolResults: counts.results,
        hasFinalText: Boolean(publicTimeline.finalText),
      });
      yield { type: 'public_timeline', snapshot: publicTimeline };
    }
    // Failed tools remain failed in the public timeline. They do not invalidate
    // the provider's completed answer explaining that failure. Still require
    // canonical text and observed model identity below.
    const canonical = publicTextFromTurnMessages(currentTurnMessages);
    const messageIdentity = observedAssistantIdentity(currentTurnMessages);
    if (messageIdentity) {
      const firstObservation = !observedModelId;
      observedModelId = observeAuthoritativeIdentity(messageIdentity) ?? observedModelId;
      if (firstObservation && observedModelId) yield { type: 'model', modelId: observedModelId };
    }
    assertAuthoritativeOpenCodeCompletion({
      observedModelId,
      streamedText: emittedText,
      canonicalText: canonical,
    });
    if (canonical && canonical !== emittedText) {
      const delta = canonicalOpenCodeTextSuffix(emittedText, canonical);
      if (delta) yield { type: 'text', delta, streamPartId: latestTextStreamPartId };
    }
    if (dispatch.commandOutcome) {
      const outcome = await dispatch.commandOutcome;
      if (!outcome.ok) throw outcome.error;
      retireCommand = undefined;
    }
    const completedUsage = completedOpenCodeTurnUsage(currentTurnMessages);
    const unavailableMetric = { provenance: 'unavailable' as const };
    yield { type: 'usage', usage: {
      capturedAt: Date.now(),
      inputTokens: unavailableMetric, outputTokens: unavailableMetric, totalTokens: unavailableMetric,
      cacheReadTokens: unavailableMetric, cacheWriteTokens: unavailableMetric,
      reasoningTokens: unavailableMetric, costUsd: unavailableMetric,
      ...completedUsage,
    } };
    const reconciledChecklists = openCodeChecklistSnapshotsFromMessages(currentTurnMessages);
    for (const checklist of reconciledChecklists) {
      yield {
        type: 'tool',
        name: checklist.tool,
        status: 'completed',
        callId: checklist.callId,
        checklist,
      };
    }
    yield { type: 'done', finishReason };
  } catch (error) {
    if (shouldReportPersistentTurnFailure(error)) reportPersistentTurnFailure(failureStage);
    // A failed renderer turn must not leave the native agent editing in the
    // background. Commands and caller cancellation have their own abort path.
    if (boundSessionId && !retireCommand && !request.signal?.aborted) {
      await boundedOpenCodeFailureAbort(() => sessions.cancelChat(scope, chatId));
    }
    throw error;
  } finally {
    request.signal?.removeEventListener('abort', abort);
    abortEvents.abort();
    if (rateLimitDeadlineTimer) clearTimeout(rateLimitDeadlineTimer);
    rateLimitDeadlineTimer = undefined;
    if (retireCommand && !request.signal?.aborted) await retireCommand();
    for (const child of boundChildSessions) {
      if (activeApprovalSessions.get(child)?.requestId === request.requestId) activeApprovalSessions.delete(child);
      if (activeQuestionSessions.get(child)?.requestId === request.requestId) activeQuestionSessions.delete(child);
      releaseToolGatewaySessionAuthority(child);
    }
    if (boundSessionId) {
      const active = activeApprovalSessions.get(boundSessionId);
      if (active?.requestId === request.requestId) {
        activeApprovalSessions.delete(boundSessionId);
      }
      const activeQuestion = activeQuestionSessions.get(boundSessionId);
      if (activeQuestion?.requestId === request.requestId) {
        activeQuestionSessions.delete(boundSessionId);
      }
      releaseToolGatewaySessionAuthority(boundSessionId);
    }
    try {
      // Do not release this chat while the native agent may still be working.
      await cancellationTask;
      turnGate.finish(turn);
      activeRequests.delete(request.requestId);
      releaseRequest();
    } catch (error) {
      // Failed abort remains owned; a follow-up must not overlap an unknown turn.
      rejectRelease(error);
      throw error;
    }
  }
}

async function detectPersistent(): Promise<DetectionResult> {
  if (!isTauri)
    return { status: 'unavailable', detail: 'OpenCode is available in the VibeSpace desktop app.' };
  try {
    await harnessRuntimeManager.refresh();
    const connection = harnessRuntimeManager.getConnection();
    if (!connection) {
      return {
        status: 'requires_attention',
        detail: 'The managed OpenCode runtime is not ready.',
      };
    }
    return { status: 'available', version: connection.version };
  } catch (error) {
    return {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const catalogScope: HarnessScope = { accountId: 'local-desktop-account' };

/** Discover native skill metadata in the exact active project scope, without sending a turn. */
export async function listPersistentOpenCodeSkills(scope: Readonly<HarnessScope>) {
  if (!cleanIdentifier(scope.accountId, 512) || !cleanIdentifier(scope.workspaceId, 512) || !scope.workingDirectory?.trim()) {
    throw new Error('OpenCode skill discovery requires an exact account, workspace and project folder.');
  }
  const entry = await sessions.clientForScope(scope);
  const client = entry.client as PersistentOpenCodeClient;
  return client.listSkillsAsync();
}

export const openCodePersistentAdapter: ProviderAdapter = Object.freeze({
  id: 'opencode-cli',
  detect: detectPersistent,
  probeAuth: (connection: ProviderRequest['connection']) => cachedAuthProbe(connection),
  listModels: async () => {
    try {
      const models = await liveModels(catalogScope);
      if (models.length > 0) {
        return toOpenCodeDiscoveredModels(models);
      }
    } catch {
      // The managed authenticated server is the only executable catalog authority.
    }
    return [];
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
  modelCatalogs.invalidate();
}

export function invalidateOpenCodePersistentAuthCache(): void {
  authProbes.invalidate();
}

export function invalidateOpenCodePersistentCaches(): void {
  invalidateOpenCodePersistentAuthCache();
  invalidateOpenCodePersistentModelCache();
}

export async function disposeOpenCodePersistentRuntimes(): Promise<void> {
  activeRequests.clear();
  for (const sessionId of activeApprovalSessions.keys()) {
    releaseToolGatewaySessionAuthority(sessionId);
  }
  activeApprovalSessions.clear();
  approvalResponseFlights.clear();
  settledApprovalResponses.clear();
  turnGate.clear();
  await sessions.disposeAll();
}
