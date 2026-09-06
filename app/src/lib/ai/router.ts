/**
 * Canonical PR31 AI router.
 *
 * Ordinary production turns cross the immutable per-chat OpenCode or Codex
 * backend boundary. Exactly two bounded direct executors also exist: (1) the explicitly gated
 * Shared Intelligence Kernel smoke provider (debug-only native smoke
 * qualification), and (2) the Model Foundry local adapter executor, which is
 * desktop-only, credential-free, and fails closed on unverified adapters. Provider/model selection, VibeSpace scope, runtime controls,
 * permissions, cancellation, and protected-attempt evidence are preserved as
 * data across the OpenCode boundary rather than reimplemented by per-provider
 * executors in this router.
 */
import type { Agent, ProviderId } from '@/types';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import type { CompiledJarvisPrompt } from '@/lib/jarvis/contracts';
import type { VibeSpaceApproval } from '@/lib/harness/types';
import {
  DEFAULT_CHAT_RUNTIME_SETTINGS,
  type ChatRuntimeSettings,
} from '@/features/chat/runtime/chatRuntimeCommandController';
import type { AccessLevel, InteractionMode } from '@/lib/permissions/OpenCodePermissionProfile';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import type {
  AiPurpose,
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMResponseObservation,
  LLMStreamChunk,
} from './types';
import { llmContentToText } from './types';
import { agentUsesDefaultProvider } from './agentProviderOptions';
import { EMPTY_CHAT_MODEL_SELECTION } from './modelSelection';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConnection,
  ProviderEvent,
  ProviderRequest,
  UsageSnapshot,
} from './adapters/types';
import { CONNECTION_MODEL_OPTIONS, getProviderConnectionDescriptor } from './adapters/catalog';
import { openCodePersistentAdapter } from './adapters/opencodePersistent';
import { codexPersistentAdapter } from './adapters/codexPersistent';
import type { ChatBackend } from './backend/chatBackend';
import { kernelSmokeCliAdapter } from './adapters/cliBridge';
import { foundryProvider } from './providers/foundry';
import { isKernelSmokeEnabled } from '@/lib/jarvis/smoke/config';
import {
  isKernelSmokeBindingActive,
  kernelSmokeProvider,
  KERNEL_SMOKE_PROVIDER_ID,
  recordKernelSmokeRouterDispatch,
} from './providers/kernelSmoke';
import {
  UnsupportedPromptTransportError,
  buildProviderPromptTransport,
} from './providerPromptTransport';
import {
  JarvisProviderAttemptFailureError,
  createJarvisProviderAttemptEvidenceAuthority,
} from './providerAttemptEvidence';
import { providerActivityTracker } from '@/features/taskbar-usage/activityTracker';
import { recordConnectionUsage } from './connectionUsageLedger';
import {
  LocalCloudEscalationRequiredError,
  planLocalCloudEscalation,
  readLocalAgentPreferences,
  type LocalInferenceFailure,
} from './localAgentRuntime';
import {
  projectOpenCodeQuestionEvent,
  type OpenCodeQuestionProjection,
} from './openCodeQuestionProjection';

export class NoModelSelectedError extends Error {
  constructor() {
    super('No model selected. Choose a model before sending.');
    this.name = 'NoModelSelectedError';
  }
}

const KERNEL_SMOKE_ENABLED = isKernelSmokeEnabled({
  devBuild: import.meta.env.DEV,
  explicitFlag: import.meta.env.VITE_SIK_SMOKE,
});

async function sha256Hex(canonical: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const providerAttemptEvidenceAuthority = createJarvisProviderAttemptEvidenceAuthority({
  sha256: sha256Hex,
});

export const jarvisProviderAttemptEvidenceRevalidator = Object.freeze({
  revalidateFailure: providerAttemptEvidenceAuthority.revalidateFailure.bind(
    providerAttemptEvidenceAuthority,
  ),
});

type ProtectedAttemptBinding = Readonly<{
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  providerId: string;
  modelId: string;
}>;

type ProtectedAttemptHooks = Readonly<{
  onResponseObservation: (observation: LLMResponseObservation) => void;
  onActionDispatch: (input: { observedAt: number }) => void;
}>;

type OpenCodeDispatchDiagnosticCode =
  | 'router_connection'
  | 'router_request_controls'
  | 'router_request_assembly'
  | 'router_adapter_open'
  | 'router_adapter_send'
  | 'router_chunk_delivery'
  | 'router_usage_event'
  | 'router_done_event'
  | 'router_completion';

const READ_ONLY_FILESYSTEM_TOOL_NAMES = new Set(['read', 'glob', 'grep', 'list']);

function reportOpenCodeDispatchFailure(diagnosticCode: OpenCodeDispatchDiagnosticCode): void {
  // Never pass the caught value here. Native/provider errors can contain
  // request or credential material; the closed stage is sufficient for the
  // in-app DevConsole to locate the failing boundary.
  console.warn('Protected OpenCode dispatch failed.', { diagnosticCode });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}

async function runProtectedProviderAttempt<T>(
  binding: ProtectedAttemptBinding,
  dispatch: (hooks: ProtectedAttemptHooks) => Promise<T>,
): Promise<T> {
  const tracker = providerAttemptEvidenceAuthority.begin(binding);
  const hooks: ProtectedAttemptHooks = Object.freeze({
    onResponseObservation: (observation) => {
      providerAttemptEvidenceAuthority.noteResponseObservation(tracker, observation);
    },
    onActionDispatch: (input) => {
      providerAttemptEvidenceAuthority.noteActionDispatch(tracker, input);
    },
  });
  try {
    const result = await dispatch(hooks);
    providerAttemptEvidenceAuthority.complete(tracker);
    return result;
  } catch (error) {
    if (isAbortError(error)) {
      providerAttemptEvidenceAuthority.complete(tracker);
      throw error;
    }
    const classification = await providerAttemptEvidenceAuthority.classifyFailure(tracker, {
      failureCategory: 'provider_transport_failure',
      failedAt: Date.now(),
    });
    throw new JarvisProviderAttemptFailureError(classification);
  }
}

export interface ConnectionRequirements {
  images?: boolean;
  files?: boolean;
  tools?: boolean;
}

function assertConnectionCapabilities(
  connection: ProviderConnection,
  requirements: ConnectionRequirements = {},
): void {
  const checks: Array<[keyof ProviderCapabilities, boolean | undefined, string]> = [
    ['images', requirements.images, 'image attachments'],
    ['files', requirements.files, 'file attachments'],
    ['tools', requirements.tools, 'tools'],
  ];
  for (const [capability, required, label] of checks) {
    if (required && !connection.capabilities[capability]) {
      throw new Error(`${connection.displayName} does not support ${label}`);
    }
  }
}

function usageNumber(value: { value?: number } | undefined): number {
  return typeof value?.value === 'number' && Number.isFinite(value.value) ? value.value : 0;
}

function tokenProvenance(usage: UsageSnapshot | undefined): {
  provenance?: 'estimated' | 'unavailable';
} {
  const tokens = [usage?.inputTokens, usage?.outputTokens];
  if (
    tokens.some(
      (token) =>
        token?.provenance === 'unavailable' ||
        !Number.isSafeInteger(token?.value) ||
        (token?.value ?? -1) < 0,
    )
  ) {
    return { provenance: 'unavailable' };
  }
  return tokens.some((token) => token?.provenance === 'estimated')
    ? { provenance: 'estimated' }
    : {};
}

function reportedUsageDetails(
  usage: UsageSnapshot | undefined,
): Pick<import('./types').TokenUsage, 'total_tokens' | 'cache_read_tokens' | 'cache_write_tokens'> {
  const details: Pick<
    import('./types').TokenUsage,
    'total_tokens' | 'cache_read_tokens' | 'cache_write_tokens'
  > = {};
  for (const [key, metric] of [
    ['total_tokens', usage?.totalTokens],
    ['cache_read_tokens', usage?.cacheReadTokens],
    ['cache_write_tokens', usage?.cacheWriteTokens],
  ] as const) {
    if (
      metric?.provenance === 'provider-reported' &&
      Number.isSafeInteger(metric.value) &&
      metric.value! >= 0
    )
      details[key] = metric.value;
  }
  return details;
}

function mergeUsageSnapshots(
  current: UsageSnapshot | undefined,
  next: UsageSnapshot,
): UsageSnapshot {
  return {
    ...current,
    ...next,
    capturedAt: Math.max(current?.capturedAt ?? 0, next.capturedAt),
    inputTokens: next.inputTokens ?? current?.inputTokens,
    outputTokens: next.outputTokens ?? current?.outputTokens,
    totalTokens: next.totalTokens ?? current?.totalTokens,
    cacheReadTokens: next.cacheReadTokens ?? current?.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens ?? current?.cacheWriteTokens,
    reasoningTokens: next.reasoningTokens ?? current?.reasoningTokens,
    costUsd: next.costUsd ?? current?.costUsd,
    quota: next.quota ?? current?.quota,
    resetsAt: next.resetsAt ?? current?.resetsAt,
  };
}

export interface ProviderCompletionEvidence {
  observedAt: number;
  requestId: string;
  sessionId: string;
  providerId: string;
  connectionId: string;
  modelId: string;
  reasoningEffort: string | null;
  usage: UsageSnapshot;
  finishReason?: string;
}

function normalizedRuntimeProviderId(providerId: string): string {
  if (providerId === 'local') return 'ollama';
  if (providerId === 'bedrock') return 'amazon-bedrock';
  return providerId;
}

function configuredCloudEscalationTarget(
  auth: ReturnType<typeof useAuthStore.getState>,
): Readonly<{ providerId: ProviderId; modelId: string }> | null {
  const candidates = [auth.defaultProvider, ...(Object.keys(auth.apiKeys) as ProviderId[]).sort()];
  for (const providerId of new Set(candidates)) {
    if (providerId === 'local' || providerId === 'ollama' || providerId === 'mock') continue;
    const modelId = auth.selectedModels[providerId]?.trim();
    if (modelId && auth.apiKeys[providerId]?.trim()) {
      return Object.freeze({ providerId, modelId });
    }
  }
  return null;
}

function classifyLocalFailure(error: unknown): LocalInferenceFailure {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:unsupported|not supported|capability unavailable)\b/iu.test(message)
    ? 'capability_unavailable'
    : 'inference_failed';
}

function resolveOpenCodeVariant(
  options: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (!options) return undefined;
  const candidates = [options.reasoning_effort, options.thinking_level].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  if (candidates.length === 0) return undefined;
  const unique = [...new Set(candidates.map((value) => value.trim().toLocaleLowerCase('en-US')))];
  if (unique.length !== 1) throw new Error('OpenCode model variant is invalid or ambiguous.');
  const value = unique[0];
  if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new Error(`OpenCode reasoning effort is unsupported: ${value}`);
  }
  return value;
}

function runtimeEffortForVariant(
  variant: string | undefined,
): ChatRuntimeSettings['effort'] | undefined {
  if (!variant) return undefined;
  if (variant === 'none' || variant === 'minimal') return 'minimal';
  if (variant === 'xhigh') return 'ultra';
  if (variant === 'low' || variant === 'medium' || variant === 'high' || variant === 'max') {
    return variant;
  }
  return undefined;
}

export interface RunAgentRequest {
  /** Authoritative immutable Chat backend. Legacy callers remain OpenCode. */
  backend?: ChatBackend;
  agent: Agent;
  messages: LLMMessage[];
  purpose?: AiPurpose;
  signal?: AbortSignal;
  onChunk?: (chunk: LLMStreamChunk) => void;
  temperature?: number;
  max_output_tokens?: number;
  provider_options?: Record<string, unknown>;
  connectionId?: string;
  connectionRequirements?: ConnectionRequirements;
  workingDirectory?: string;
  explicitReadRoot?: boolean;
  explicitReadSynthesis?: boolean;
  expectedSessionId?: string;
  compiledPrompt?: Readonly<CompiledJarvisPrompt>;
  requestId?: string;
  chatId?: string;
  parentChatId?: string;
  accountId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  runtimeSettings?: ChatRuntimeSettings;
  interactionMode?: InteractionMode;
  accessLevel?: AccessLevel;
  approveAllForRun?: boolean;
  tools?: Readonly<Record<string, boolean>>;
  onApprovalRequested?: (approval: VibeSpaceApproval) => void | Promise<void>;
  onHarnessSessionBound?: (binding: {
    sessionId: string;
    parentSessionId?: string;
  }) => void | Promise<void>;
  onQuestionRequested?: (projection: Readonly<OpenCodeQuestionProjection>) => void | Promise<void>;
  /** Ordered, request-local, privacy-safe OpenCode tool lifecycle evidence for Chat UI receipts. */
  onToolActivity?: (
    activity: Readonly<{
      name: string;
      status: 'started' | 'completed' | 'failed';
      callId?: string;
      fileLabel?: string;
      nativeTask?: import('./openCodeNativeActivity').NativeTaskActivity;
    }>,
  ) => void | Promise<void>;
  /** Whole authoritative OpenCode public snapshot; replaces prior snapshot for this request. */
  onReasoning?: (delta: string, mode?: 'replace') => void;
  onPublicTimelineSnapshot?: (
    snapshot: Readonly<import('./openCodePublicTimeline').OpenCodePublicTimelineSnapshot>,
  ) => void | Promise<void>;
  onProviderCompletionEvidence?: (
    evidence: Readonly<ProviderCompletionEvidence>,
  ) => void | Promise<void>;
  protectedAttempt?: Readonly<{
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
  }>;
}

function codexQualifiedModel(req: Readonly<RunAgentRequest>): string {
  const model = req.agent.model.model.trim();
  if (!model) throw new NoModelSelectedError();
  if (req.agent.model.provider === 'openai') return model.replace(/^openai\//u, '');
  return model.includes('/') ? model : req.agent.model.provider + '/' + model;
}

function codexGatewayConnection(req: Readonly<RunAgentRequest>): ProviderConnection {
  if (req.connectionId !== 'openai-codex') {
    throw new Error('Codex-backed Chat requires the exact Codex connection.');
  }
  const descriptor = getProviderConnectionDescriptor(req.connectionId);
  if (!descriptor.enabled) throw new Error('Codex connection is disabled.');
  return Object.freeze({
    ...descriptor,
    adapterId: codexPersistentAdapter.id,
    providerId: req.agent.model.provider,
    authSource: 'codex-cli-session',
    promptTransport: 'native-system',
  });
}

async function executePersistentCodex(req: Readonly<RunAgentRequest>): Promise<LLMResponse> {
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  if (!codexPersistentAdapter.send) throw new Error('Persistent Codex transport is unavailable.');
  const requestId = req.requestId ?? globalThis.crypto?.randomUUID?.() ?? 'req-' + Date.now();
  const connection = codexGatewayConnection(req);
  const modelId = codexQualifiedModel(req);
  let text = '';
  const chronology: import('./openCodePublicTimeline').OpenCodePublicTimelinePart[] = [];
  const chronologyTextIds = new Map<string, number>();
  const chronologyToolIds = new Map<string, number>();
  const chronologyResultIds = new Map<string, number>();
  const snapshot = () => {
    let finalIndex = -1;
    for (let index = chronology.length - 1; index >= 0; index -= 1) {
      if (chronology[index]?.kind === 'text') { finalIndex = index; break; }
    }
    const final = chronology[finalIndex];
    return { timeline: chronology.filter((_, index) => index !== finalIndex),
      finalText: final?.kind === 'text' ? final.text : text };
  };
  const textParts: string[] = [];
  const textPartIndexes = new Map<string, number>();
  let first = true;
  let finishReason: string | undefined;
  let usage: UsageSnapshot | undefined;
  let sessionId: string | undefined;
  let terminalObserved = false;
  let anyToolObserved = false;
  let completedReadOnlyFilesystem = false;
  const providerRequest: ProviderRequest = {
    requestId,
    connection,
    chatId: req.chatId ?? req.parentChatId ?? requestId,
    accountId: req.accountId,
    workspaceId: req.workspaceId,
    projectId: req.projectId,
    worktreeId: req.worktreeId,
    prompt: promptForOpenCode(req.messages),
    modelId,
    reasoningEffort: resolveOpenCodeVariant(req.provider_options),
    systemPrompt: req.compiledPrompt?.systemText ?? req.agent.system_prompt,
    workingDirectory: req.workingDirectory,
    sessionId: req.expectedSessionId,
    runtimeSettings: req.runtimeSettings,
    interactionMode: req.interactionMode,
    accessLevel: req.accessLevel,
    approveAllForRun: req.approveAllForRun,
    tools: req.tools,
    signal: req.signal,
    onApprovalRequested: req.onApprovalRequested,
  };
  const iterator = codexPersistentAdapter.send(providerRequest)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const event = next.value;
      if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      if (event.type === 'text') {
        const key = event.streamPartId ?? 'default';
        const previous = chronologyTextIds.get(key);
        if (previous === undefined) {
          chronologyTextIds.set(key, chronology.length); chronology.push({ kind: 'text', text: event.delta });
        } else {
          const part = chronology[previous];
          chronology[previous] = { kind: 'text', text: event.mode === 'replace' ? event.delta :
            (part?.kind === 'text' ? part.text : '') + event.delta };
        }
        if (event.streamPartId) {
          const index = textPartIndexes.get(event.streamPartId);
          if (index === undefined) {
            textPartIndexes.set(event.streamPartId, textParts.length);
            textParts.push(event.delta);
          } else {
            textParts[index] =
              event.mode === 'replace' ? event.delta : (textParts[index] ?? '') + event.delta;
          }
          text = textParts.join('');
        } else {
          text += event.delta;
        }
        req.onChunk?.({
          delta: event.delta,
          first,
          ...(event.mode === 'replace' ? { mode: 'replace' as const } : {}),
          ...(event.streamPartId ? { streamPartId: event.streamPartId } : {}),
        });
        first = false;
      } else if (event.type === 'reasoning') {
        const previous = chronology.at(-1);
        if (previous?.kind === 'reasoning') chronology[chronology.length - 1] = { kind: 'reasoning', text: previous.text + event.delta };
        else chronology.push({ kind: 'reasoning', text: event.delta });
        req.onReasoning?.(event.delta, event.mode);
      } else if (event.type === 'usage') {
        usage = mergeUsageSnapshots(usage, event.usage);
      } else if (event.type === 'session') {
        if (
          (req.expectedSessionId && req.expectedSessionId !== event.sessionId) ||
          (sessionId && sessionId !== event.sessionId)
        ) {
          throw new Error('provider_completion_session_mismatch');
        }
        sessionId = event.sessionId;
        await req.onHarnessSessionBound?.({ sessionId: event.sessionId });
      } else if (event.type === 'question') {
        if (!sessionId || event.request.sessionId !== sessionId) {
          throw new Error('provider_question_session_mismatch');
        }
        const projection = projectOpenCodeQuestionEvent(event, sessionId);
        if (!projection || !req.onQuestionRequested) {
          throw new Error('provider_question_handler_missing');
        }
        await req.onQuestionRequested(projection);
      } else if (event.type === 'tool') {
        if (event.callId) {
          const call = { kind: 'tool_call' as const, tool: event.name, call_id: event.callId,
            args: { ...(event.fileLabel ? { path: event.fileLabel } : {}),
              ...(event.nativeTask ? { nativeTask: event.nativeTask } : {}) } };
          const index = chronologyToolIds.get(event.callId);
          if (index === undefined) { chronologyToolIds.set(event.callId, chronology.length); chronology.push(call); }
          else chronology[index] = call;
          if (event.status !== 'started') {
            const result = { kind: 'tool_result' as const, call_id: event.callId,
              ...(event.status === 'failed' ? { error: 'Tool failed' as const } : { result: { status: 'completed' as const } }) };
            const resultIndex = chronologyResultIds.get(event.callId);
            if (resultIndex === undefined) { chronologyResultIds.set(event.callId, chronology.length); chronology.push(result); }
            else chronology[resultIndex] = result;
          }
        }

        anyToolObserved = true;
        if (event.status === 'completed' && READ_ONLY_FILESYSTEM_TOOL_NAMES.has(event.name)) {
          completedReadOnlyFilesystem = true;
        }
        await req.onToolActivity?.({
          name: event.name,
          status: event.status,
          ...(event.callId ? { callId: event.callId } : {}),
          ...(event.fileLabel ? { fileLabel: event.fileLabel } : {}),
          ...(event.nativeTask ? { nativeTask: event.nativeTask } : {}),
        });
      } else if (event.type === 'error') {
        terminalObserved = true;
        throw new Error(event.message);
      } else if (event.type === 'done') {
        terminalObserved = true;
        finishReason = event.finishReason;
      }
    }
  } finally {
    await iterator.return?.();
  }
  if (!terminalObserved) throw new Error('provider_completion_terminal_missing');
  if (!sessionId) throw new Error('provider_completion_session_missing');
  req.onChunk?.({ delta: '', done: true });
  const publicSnapshot = snapshot();
  await req.onPublicTimelineSnapshot?.(publicSnapshot);
  const response: LLMResponse = {
    text: publicSnapshot.finalText,
    public_timeline: publicSnapshot.timeline,
    usage: {
      ...tokenProvenance(usage),
      ...reportedUsageDetails(usage),
      input_tokens: usageNumber(usage?.inputTokens),
      output_tokens: usageNumber(usage?.outputTokens),
      cost_usd: usageNumber(usage?.costUsd),
    },
    provider: req.agent.model.provider as ProviderId,
    model: req.agent.model.model,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    tool_evidence: Object.freeze({
      completedReadOnlyFilesystem,
      anyToolObserved,
      rootInventoryObserved: false,
      boundedSearchObserved: false,
      representativeReadCount: 0,
    }),
  };
  useAgentStore
    .getState()
    .addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );
  recordConnectionUsage({
    connectionId: connection.id,
    providerId: response.provider,
    modelId: response.model,
    timestamp: Date.now(),
    inputTokens: response.usage.input_tokens,
    cachedInputTokens: 0,
    outputTokens: response.usage.output_tokens,
    costUsd: response.usage.cost_usd,
  });
  return response;
}

type OpenCodeSelection = Readonly<{
  providerId: string;
  runtimeProviderId: string;
  modelId: string;
  connectionId?: string;
}>;

function resolveOpenCodeSelection(req: Readonly<RunAgentRequest>): OpenCodeSelection {
  const auth = useAuthStore.getState();
  if (req.connectionId) {
    const connection = getProviderConnectionDescriptor(req.connectionId);
    if (!connection.enabled)
      throw new Error(`Provider connection is disabled: ${req.connectionId}`);
    if (
      auth.offlineMode &&
      connection.mode !== 'local' &&
      connection.adapterId !== 'opencode-cli'
    ) {
      throw new NoModelSelectedError();
    }
    assertConnectionCapabilities(connection, req.connectionRequirements);
    if (connection.adapterId === 'opencode-cli') {
      const providerId = req.agent.model.provider === 'local' ? 'ollama' : req.agent.model.provider;
      return {
        providerId,
        runtimeProviderId: normalizedRuntimeProviderId(providerId),
        modelId: req.agent.model.model,
        connectionId: connection.id,
      };
    }
    const providerId = connection.mode === 'local' ? 'ollama' : connection.providerId;
    if (
      req.agent.model.provider !== providerId &&
      !(providerId === 'ollama' && req.agent.model.provider === 'local')
    ) {
      throw new Error(`Selected model does not match provider connection: ${req.connectionId}`);
    }
    const exactModels = CONNECTION_MODEL_OPTIONS[connection.id];
    if (exactModels && !exactModels.some((option) => option.id === req.agent.model.model)) {
      throw new Error(`${req.agent.model.model} is unavailable for ${connection.displayName}`);
    }
    return {
      providerId,
      runtimeProviderId: normalizedRuntimeProviderId(providerId),
      modelId: req.agent.model.model,
      connectionId: connection.id,
    };
  }

  if (auth.offlineMode) {
    const selection = auth.chatModelSelection ?? EMPTY_CHAT_MODEL_SELECTION;
    if (
      selection.mode !== 'single' ||
      (selection.providerId !== 'ollama' && selection.providerId !== 'local')
    ) {
      throw new NoModelSelectedError();
    }
    return {
      providerId: 'ollama',
      runtimeProviderId: 'ollama',
      modelId: selection.modelId,
    };
  }

  const usesDefault =
    agentUsesDefaultProvider(req.agent.model.provider, req.agent.model.model) ||
    (req.agent.builtin &&
      req.agent.model.provider === 'mock' &&
      req.agent.model.model === 'mock-default');
  if (usesDefault) {
    const selection = auth.chatModelSelection ?? EMPTY_CHAT_MODEL_SELECTION;
    if (selection.mode !== 'single') throw new NoModelSelectedError();
    return {
      providerId: selection.providerId,
      runtimeProviderId: normalizedRuntimeProviderId(selection.providerId),
      modelId: selection.modelId,
    };
  }

  const providerId = req.agent.model.provider === 'local' ? 'ollama' : req.agent.model.provider;
  return {
    providerId,
    runtimeProviderId: normalizedRuntimeProviderId(providerId),
    modelId: req.agent.model.model,
  };
}

function qualifyOpenCodeModel(selection: Readonly<OpenCodeSelection>): string {
  const model = selection.modelId.trim();
  if (!model) throw new NoModelSelectedError();
  return model.includes('/') ? model : `${selection.runtimeProviderId}/${model}`;
}

function openCodeGatewayConnection(selection: Readonly<OpenCodeSelection>): ProviderConnection {
  const gateway = getProviderConnectionDescriptor('opencode-cli');
  const id = selection.connectionId ?? gateway.id;
  return Object.freeze({
    ...gateway,
    id,
    adapterId: openCodePersistentAdapter.id,
    providerId: 'opencode',
    mode: 'external-cli',
    authSource: 'opencode-provider-session',
    enabled: true,
  });
}

function promptForOpenCode(messages: readonly LLMMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      const text = llmContentToText(message.content).trim();
      if (text) return text;
    }
  }
  const serialized = messages
    .map((message) => `${message.role}: ${llmContentToText(message.content)}`)
    .join('\n\n')
    .trim();
  if (!serialized) throw new Error('A non-empty chat message is required.');
  return serialized;
}

async function executePersistentOpenCode(
  req: Readonly<RunAgentRequest>,
  selection: Readonly<OpenCodeSelection>,
  hooks?: ProtectedAttemptHooks,
): Promise<LLMResponse> {
  let diagnosticCode: OpenCodeDispatchDiagnosticCode = 'router_connection';
  let providerReportedFailure = false;
  try {
    if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    const connection = openCodeGatewayConnection(selection);
    if (!openCodePersistentAdapter.send) {
      throw new Error('Persistent OpenCode transport is unavailable.');
    }
    // Do not CLI-probe version or await auth on the send path. Those probes add
    // seconds of delay and a flaky `unknown` result used to fail the Jarvis turn
    // before OpenCode was asked. Kick a background probe for UI state. Real
    // sign-out still fail-closes from the persistent session (401 / refresh).
    if (openCodePersistentAdapter.probeAuth) {
      void openCodePersistentAdapter.probeAuth(connection);
    }

    diagnosticCode = 'router_request_controls';
    const requestId = req.requestId ?? globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}`;
    const qualifiedModel = qualifyOpenCodeModel(selection);
    const variant = resolveOpenCodeVariant(req.provider_options);
    const runtimeSettings: ChatRuntimeSettings = req.runtimeSettings
      ? { ...req.runtimeSettings }
      : { ...DEFAULT_CHAT_RUNTIME_SETTINGS };
    const requestedEffort = runtimeEffortForVariant(variant);
    if (requestedEffort) {
      if (runtimeSettings.effort !== 'auto' && runtimeSettings.effort !== requestedEffort) {
        throw new Error('OpenCode reasoning effort conflicts with the active runtime setting.');
      }
      runtimeSettings.effort = requestedEffort;
    }

    let text = '';
    const textParts: string[] = [];
    const textPartIndexes = new Map<string, number>();
    let first = true;
    let publicTimelineSnapshot:
      Readonly<import('./openCodePublicTimeline').OpenCodePublicTimelineSnapshot> | undefined;
    let finishReason: string | undefined;
    let usage: Extract<ProviderEvent, { type: 'usage' }>['usage'] | undefined;
    let observedSessionId: string | undefined;
    const observedQuestionRequestIds = new Set<string>();
    let terminalDoneObserved = false;
    let completedReadOnlyFilesystem = false;
    let anyToolObserved = false;
    const checklistEvidence = new Map<
      string,
      import('./openCodeChecklist').OpenCodeChecklistSnapshot
    >();
    let rootInventoryObserved = false;
    let boundedSearchObserved = false;
    const representativeReads = new Set<string>();
    diagnosticCode = 'router_request_assembly';
    const providerRequest: ProviderRequest = {
      requestId,
      connection,
      chatId: req.chatId ?? req.parentChatId ?? requestId,
      accountId: req.accountId,
      workspaceId: req.workspaceId,
      projectId: req.projectId,
      worktreeId: req.worktreeId,
      prompt: promptForOpenCode(req.messages),
      modelId: qualifiedModel,
      reasoningEffort: variant,
      systemPrompt: req.compiledPrompt?.systemText ?? req.agent.system_prompt,
      workingDirectory: req.workingDirectory,
      explicitReadRoot: req.explicitReadRoot === true,
      explicitReadSynthesis: req.explicitReadSynthesis === true,
      expectedSessionId: req.expectedSessionId,
      runtimeSettings,
      interactionMode: req.interactionMode,
      accessLevel: req.accessLevel,
      approveAllForRun: req.approveAllForRun,
      tools: req.tools,
      signal: req.signal,
      onApprovalRequested: req.onApprovalRequested,
      onSessionBound: async (binding) => {
        if (
          (req.expectedSessionId && req.expectedSessionId !== binding.sessionId) ||
          (observedSessionId && observedSessionId !== binding.sessionId)
        ) {
          throw new Error('provider_completion_session_mismatch');
        }
        observedSessionId = binding.sessionId;
        await req.onHarnessSessionBound?.(binding);
      },
      onResponseObservation: hooks?.onResponseObservation,
      onActionDispatch: hooks?.onActionDispatch,
    };
    diagnosticCode = 'router_adapter_open';
    const providerEvents = openCodePersistentAdapter.send(providerRequest);
    const iterator = providerEvents[Symbol.asyncIterator]();
    try {
      while (true) {
        diagnosticCode = 'router_adapter_send';
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
        if (event.type === 'text') {
          diagnosticCode = 'router_chunk_delivery';
          if (event.streamPartId) {
            const existingIndex = textPartIndexes.get(event.streamPartId);
            if (existingIndex === undefined) {
              textPartIndexes.set(event.streamPartId, textParts.length);
              textParts.push(event.delta);
            } else {
              textParts[existingIndex] =
                event.mode === 'replace'
                  ? event.delta
                  : `${textParts[existingIndex] ?? ''}${event.delta}`;
            }
            text = textParts.join('');
          } else {
            text += event.delta;
          }
          req.onChunk?.({
            delta: event.delta,
            first,
            ...(event.mode === 'replace' ? { mode: 'replace' as const } : {}),
            ...(event.streamPartId ? { streamPartId: event.streamPartId } : {}),
          });
          first = false;
        } else if (event.type === 'reasoning') {
          req.onReasoning?.(event.delta, event.mode);
        } else if (event.type === 'public_timeline') {
          publicTimelineSnapshot = event.snapshot;
          await req.onPublicTimelineSnapshot?.(event.snapshot);
        } else if (event.type === 'usage') {
          diagnosticCode = 'router_usage_event';
          usage = mergeUsageSnapshots(usage, event.usage);
        } else if (event.type === 'session') {
          if (
            (req.expectedSessionId && req.expectedSessionId !== event.sessionId) ||
            (observedSessionId && observedSessionId !== event.sessionId)
          ) {
            throw new Error('provider_completion_session_mismatch');
          }
          observedSessionId = event.sessionId;
        } else if (event.type === 'question') {
          const exactSessionId = observedSessionId ?? req.expectedSessionId;
          if (!exactSessionId) throw new Error('provider_question_session_missing');
          if (event.request.sessionId !== exactSessionId) {
            throw new Error('provider_question_session_mismatch');
          }
          const projection = projectOpenCodeQuestionEvent(event, exactSessionId);
          if (!projection) throw new Error('provider_question_invalid');
          if (observedQuestionRequestIds.has(projection.route.requestId)) {
            throw new Error('provider_question_duplicate');
          }
          if (!req.onQuestionRequested) throw new Error('provider_question_handler_missing');
          observedQuestionRequestIds.add(projection.route.requestId);
          await req.onQuestionRequested(projection);
        } else if (event.type === 'tool') {
          anyToolObserved = true;
          if (event.checklist) checklistEvidence.set(event.checklist.callId, event.checklist);
          if (req.explicitReadSynthesis) {
            throw new Error('kernel_explicit_root_synthesis_tool_observed');
          }
          if (req.explicitReadRoot && !READ_ONLY_FILESYSTEM_TOOL_NAMES.has(event.name)) {
            throw new Error('kernel_explicit_root_unapproved_tool_observed');
          }
          if (event.status === 'completed' && READ_ONLY_FILESYSTEM_TOOL_NAMES.has(event.name)) {
            completedReadOnlyFilesystem = true;
            if (
              event.name === 'list' ||
              event.name === 'glob' ||
              (event.name === 'read' && event.scope === 'explicit_root_inventory')
            ) {
              rootInventoryObserved = true;
            }
            if (event.name === 'glob' || event.name === 'grep') boundedSearchObserved = true;
            if (event.name === 'read' && event.callId) representativeReads.add(event.callId);
          }
          await req.onToolActivity?.({
            name: event.name,
            status: event.status,
            ...(event.callId ? { callId: event.callId } : {}),
            ...(event.fileLabel ? { fileLabel: event.fileLabel } : {}),
            ...(event.nativeTask ? { nativeTask: event.nativeTask } : {}),
          });
        } else if (event.type === 'error') {
          providerReportedFailure = true;
          throw new Error(event.message);
        } else if (event.type === 'done') {
          diagnosticCode = 'router_done_event';
          terminalDoneObserved = true;
          finishReason = event.finishReason;
        }
      }
    } finally {
      await iterator.return?.();
    }
    if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    diagnosticCode = 'router_completion';
    if (req.onProviderCompletionEvidence) {
      if (!terminalDoneObserved) throw new Error('provider_completion_terminal_missing');
      if (!observedSessionId) throw new Error('provider_completion_session_missing');
      await req.onProviderCompletionEvidence({
        observedAt: Date.now(),
        requestId,
        sessionId: observedSessionId,
        providerId: selection.providerId,
        connectionId: connection.id,
        modelId: selection.modelId,
        reasoningEffort: variant ?? null,
        usage: usage ?? { capturedAt: Date.now() },
        ...(finishReason ? { finishReason } : {}),
      });
    }
    req.onChunk?.({ delta: '', done: true });
    const finalText = publicTimelineSnapshot?.finalText || text;
    if (publicTimelineSnapshot) {
      console.debug('OpenCode public timeline selected.', {
        checkpointParts: publicTimelineSnapshot.timeline.length,
        hasFinalText: Boolean(publicTimelineSnapshot.finalText),
        streamedTextParts: textParts.length,
      });
    }
    return {
      text: finalText,
      usage: {
        ...tokenProvenance(usage),
        ...reportedUsageDetails(usage),
        input_tokens: usageNumber(usage?.inputTokens),
        output_tokens: usageNumber(usage?.outputTokens),
        cost_usd: usageNumber(usage?.costUsd),
      },
      provider: (selection.providerId === 'local' ? 'ollama' : selection.providerId) as ProviderId,
      model: selection.modelId,
      ...(finishReason ? { finish_reason: finishReason } : {}),
      ...(publicTimelineSnapshot
        ? { public_timeline: Object.freeze([...publicTimelineSnapshot.timeline]) }
        : {}),
      tool_evidence: Object.freeze({
        completedReadOnlyFilesystem,
        anyToolObserved,
        rootInventoryObserved,
        boundedSearchObserved,
        representativeReadCount: representativeReads.size,
      }),
      ...(checklistEvidence.size > 0
        ? { checklist_evidence: Object.freeze([...checklistEvidence.values()]) }
        : {}),
    };
  } catch (error) {
    if (!isAbortError(error) && !providerReportedFailure) {
      reportOpenCodeDispatchFailure(diagnosticCode);
    }
    throw error;
  }
}

async function dispatchThroughOpenCode(req: RunAgentRequest): Promise<LLMResponse> {
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const protectedDispatch = req.compiledPrompt !== undefined;
  if (protectedDispatch) {
    if (!req.connectionId || !req.requestId || !req.protectedAttempt) {
      throw new Error('Protected provider dispatch requires exact connection and attempt binding.');
    }
    if (req.requestId !== req.protectedAttempt.requestId) {
      throw new Error('Protected provider request IDs do not match.');
    }
  }

  const selection = resolveOpenCodeSelection(req);
  const dispatch = (hooks?: ProtectedAttemptHooks) =>
    executePersistentOpenCode(req, selection, hooks);
  let response: LLMResponse;
  try {
    response = protectedDispatch
      ? await runProtectedProviderAttempt(
          {
            ...req.protectedAttempt!,
            providerId: selection.runtimeProviderId,
            modelId: selection.modelId,
          },
          dispatch,
        )
      : await dispatch();
  } catch (error) {
    if (
      !protectedDispatch &&
      (selection.providerId === 'ollama' || selection.providerId === 'local') &&
      !isAbortError(error)
    ) {
      const auth = useAuthStore.getState();
      const preferences = readLocalAgentPreferences();
      const target = configuredCloudEscalationTarget(auth);
      if (target) {
        const messageChars = req.messages.reduce(
          (total, message) => total + llmContentToText(message.content).length,
          0,
        );
        const proposal = planLocalCloudEscalation({
          offlineMode: auth.offlineMode,
          enabled: preferences.cloudEscalationEnabled,
          failure: classifyLocalFailure(error),
          providerId: target.providerId,
          modelId: target.modelId,
          data: { messageChars, contextChars: 0, categories: ['prompt'] },
        });
        if (proposal.status === 'approval_required') {
          throw new LocalCloudEscalationRequiredError(proposal);
        }
      }
    }
    throw error;
  }

  useAgentStore
    .getState()
    .addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );
  recordConnectionUsage({
    connectionId: selection.connectionId ?? 'opencode-cli',
    providerId: response.provider,
    modelId: response.model,
    timestamp: Date.now(),
    inputTokens: response.usage.input_tokens,
    cachedInputTokens: 0,
    outputTokens: response.usage.output_tokens,
    costUsd: response.usage.cost_usd,
  });
  return response;
}

type KernelSmokeCliConnectionArgs = {
  connection: ProviderConnection;
  adapter: ProviderAdapter;
  requestId: string;
  prompt: string;
  modelId?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  signal?: AbortSignal;
  requirements?: ConnectionRequirements;
  onChunk?: (chunk: LLMStreamChunk) => void;
  onResponseObservation?: (observation: LLMResponseObservation) => void;
  onActionDispatch?: (input: { observedAt: number }) => void;
};

async function runKernelSmokeCliConnection(
  args: KernelSmokeCliConnectionArgs,
): Promise<LLMResponse> {
  const { connection, adapter } = args;
  if (
    !KERNEL_SMOKE_ENABLED ||
    connection.providerId !== KERNEL_SMOKE_PROVIDER_ID ||
    adapter !== kernelSmokeCliAdapter ||
    connection.adapterId !== kernelSmokeCliAdapter.id ||
    connection.authSource !== 'debug-native-attestation' ||
    !isKernelSmokeBindingActive()
  ) {
    throw new Error('The debug-only kernel smoke CLI transport is unavailable.');
  }
  if (args.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  if (connection.promptTransport === 'unsupported') {
    throw new UnsupportedPromptTransportError(connection.id);
  }
  if (!connection.enabled || connection.mode !== 'external-cli') {
    throw new Error('The debug-only kernel smoke connection is unavailable.');
  }
  assertConnectionCapabilities(connection, args.requirements);
  if (!adapter.send) throw new Error('Kernel smoke adapter cannot send requests.');
  const detection = adapter.detect ? await adapter.detect() : { status: 'unavailable' as const };
  if (detection.status !== 'available') throw new Error('Kernel smoke adapter is unavailable.');
  const auth = adapter.probeAuth
    ? await adapter.probeAuth(connection)
    : { status: 'unknown' as const };
  if (auth.status === 'unauthenticated') throw new Error('Kernel smoke adapter is signed out.');
  if (auth.status !== 'authenticated' && !isKernelSmokeBindingActive()) {
    throw new Error('Kernel smoke authentication could not be verified.');
  }

  let text = '';
  const textParts: string[] = [];
  const textPartIndexes = new Map<string, number>();
  let first = true;
  let finishReason: string | undefined;
  let usage: Extract<ProviderEvent, { type: 'usage' }>['usage'] | undefined;
  for await (const event of adapter.send({
    requestId: args.requestId,
    connection,
    prompt: args.prompt,
    modelId: args.modelId,
    systemPrompt: args.systemPrompt,
    workingDirectory: args.workingDirectory,
    signal: args.signal,
    onResponseObservation: args.onResponseObservation,
    onActionDispatch: args.onActionDispatch,
  })) {
    if (args.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    if (event.type === 'text') {
      if (event.streamPartId) {
        const existingIndex = textPartIndexes.get(event.streamPartId);
        if (existingIndex === undefined) {
          textPartIndexes.set(event.streamPartId, textParts.length);
          textParts.push(event.delta);
        } else {
          textParts[existingIndex] =
            event.mode === 'replace'
              ? event.delta
              : `${textParts[existingIndex] ?? ''}${event.delta}`;
        }
        text = textParts.join('');
      } else {
        text += event.delta;
      }
      args.onChunk?.({
        delta: event.delta,
        first,
        ...(event.mode === 'replace' ? { mode: 'replace' as const } : {}),
        ...(event.streamPartId ? { streamPartId: event.streamPartId } : {}),
      });
      first = false;
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else if (event.type === 'done') {
      finishReason = event.finishReason;
    }
  }
  args.onChunk?.({ delta: '', done: true });
  return {
    text,
    usage: {
      ...tokenProvenance(usage),
      ...reportedUsageDetails(usage),
      input_tokens: usageNumber(usage?.inputTokens),
      output_tokens: usageNumber(usage?.outputTokens),
      cost_usd: usageNumber(usage?.costUsd),
    },
    provider: connection.providerId as ProviderId,
    model: args.modelId ?? connection.modelId ?? connection.displayName,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
}

function resolveKernelSmokeProviderAndModel(
  connection: ProviderConnection,
  agent: Agent,
): { provider: LLMProvider; model: string } {
  if (
    !KERNEL_SMOKE_ENABLED ||
    agent.model.provider !== KERNEL_SMOKE_PROVIDER_ID ||
    connection.providerId !== KERNEL_SMOKE_PROVIDER_ID ||
    !kernelSmokeProvider.isAvailable()
  ) {
    throw new NoModelSelectedError();
  }
  return { provider: kernelSmokeProvider, model: agent.model.model };
}

async function runKernelSmokeDispatch(req: RunAgentRequest): Promise<LLMResponse> {
  if (!KERNEL_SMOKE_ENABLED || req.agent.model.provider !== KERNEL_SMOKE_PROVIDER_ID) {
    throw new Error('The debug-only kernel smoke dispatch is unavailable.');
  }
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const protectedDispatch = req.compiledPrompt !== undefined;
  if (protectedDispatch) {
    if (!req.connectionId || !req.requestId || !req.protectedAttempt) {
      throw new Error('Protected provider dispatch requires exact connection and attempt binding.');
    }
    if (req.requestId !== req.protectedAttempt.requestId) {
      throw new Error('Protected provider request IDs do not match.');
    }
  }

  if (!req.connectionId)
    throw new Error('Kernel smoke dispatch requires its exact debug connection.');
  const connection = getProviderConnectionDescriptor(req.connectionId);
  if (connection.providerId !== KERNEL_SMOKE_PROVIDER_ID) {
    throw new Error('Kernel smoke provider connection is invalid.');
  }
  recordKernelSmokeRouterDispatch(protectedDispatch ? 'protected' : 'unprotected');
  if (connection.mode === 'external-cli') {
    const transport = protectedDispatch
      ? buildProviderPromptTransport({
          compiled: req.compiledPrompt!,
          connection,
          messages: req.messages,
        })
      : undefined;
    const prompt =
      transport?.strategy === 'prefixed-preamble'
        ? transport.prompt
        : promptForOpenCode(req.messages);
    const dispatch = (hooks?: ProtectedAttemptHooks) =>
      runKernelSmokeCliConnection({
        connection,
        adapter: kernelSmokeCliAdapter,
        requestId: req.requestId ?? `kernel-smoke-${Date.now()}`,
        prompt,
        modelId: req.agent.model.model,
        systemPrompt: protectedDispatch ? undefined : req.agent.system_prompt,
        workingDirectory: req.workingDirectory,
        signal: req.signal,
        requirements: req.connectionRequirements,
        onChunk: req.onChunk,
        onResponseObservation: hooks?.onResponseObservation,
        onActionDispatch: hooks?.onActionDispatch,
      });
    const response = protectedDispatch
      ? await runProtectedProviderAttempt(
          {
            ...req.protectedAttempt!,
            providerId: connection.providerId,
            modelId: req.agent.model.model,
          },
          dispatch,
        )
      : await dispatch();
    useAgentStore
      .getState()
      .addTokens(
        req.agent.id,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cost_usd,
      );
    return response;
  }

  const resolved = resolveKernelSmokeProviderAndModel(connection, req.agent);
  const transport = protectedDispatch
    ? buildProviderPromptTransport({
        compiled: req.compiledPrompt!,
        connection,
        messages: req.messages,
      })
    : undefined;
  if (protectedDispatch && transport?.strategy !== 'native-system') {
    throw new Error('Protected kernel smoke transport is invalid.');
  }
  const llmReq: LLMRequest = {
    purpose: req.purpose ?? 'chat',
    agent: req.agent,
    messages: transport?.strategy === 'native-system' ? [...transport.messages] : req.messages,
    ...(transport?.strategy === 'native-system' ? { systemPrompt: transport.systemPrompt } : {}),
    signal: req.signal,
    onChunk: req.onChunk,
    temperature: req.temperature,
    max_output_tokens: req.max_output_tokens,
    provider_options: req.provider_options,
    ...(protectedDispatch ? { protectedAttempt: req.protectedAttempt } : {}),
  };
  const response = protectedDispatch
    ? await runProtectedProviderAttempt(
        {
          ...req.protectedAttempt!,
          providerId: connection.providerId,
          modelId: resolved.model,
        },
        (hooks) =>
          resolved.provider.run({
            ...llmReq,
            onResponseObservation: hooks.onResponseObservation,
            onActionDispatch: hooks.onActionDispatch,
          }),
      )
    : await resolved.provider.run(llmReq);
  useAgentStore
    .getState()
    .addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );
  return response;
}

/// Bounded direct executor for locally promoted Model Foundry adapters.
/// Foundry inference never crosses a cloud boundary: the provider fails
/// closed unless the desktop native runtime is present, the adapter id is a
/// verified project/job pair, and the adapter has passed its current local
/// evaluation. No credentials, connections, or OpenCode transport involved.
async function runFoundryDispatch(req: RunAgentRequest): Promise<LLMResponse> {
  if (!foundryProvider.isAvailable()) {
    throw new Error('Model Foundry adapters are available only in the desktop app.');
  }
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const llmReq: LLMRequest = {
    purpose: req.purpose ?? 'chat',
    agent: req.agent,
    messages: req.messages,
    signal: req.signal,
    onChunk: req.onChunk,
    temperature: req.temperature,
    max_output_tokens: req.max_output_tokens,
    provider_options: req.provider_options,
  };
  const response = await foundryProvider.run(llmReq);
  useAgentStore
    .getState()
    .addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );
  return response;
}

async function runAgentDispatch(req: RunAgentRequest): Promise<LLMResponse> {
  if (KERNEL_SMOKE_ENABLED && req.agent.model.provider === KERNEL_SMOKE_PROVIDER_ID) {
    return runKernelSmokeDispatch(req);
  }
  if (req.agent.model.provider === 'foundry') {
    return runFoundryDispatch(req);
  }
  if (req.backend === 'codex') {
    return executePersistentCodex(req);
  }
  return dispatchThroughOpenCode(req);
}

export async function runAgent(req: RunAgentRequest): Promise<LLMResponse> {
  const activityId = req.connectionId ?? req.agent.model.provider;
  const completeActivity = providerActivityTracker.begin(activityId);
  try {
    const identity = {
      requestId: req.requestId,
      chatId: req.chatId,
      purpose: req.purpose,
      provider: req.agent.model.provider,
      model: req.agent.model.model,
      connectionId: req.connectionId,
    };
    return await appActivityLog.trace('model', { ...identity, messages: req.messages }, () =>
      runAgentDispatch({
        ...req,
        onChunk: (chunk) => {
          appActivityLog.record('model.stream', 'observed', { ...identity, chunk });
          req.onChunk?.(chunk);
        },
        onToolActivity: (activity) => {
          appActivityLog.record('model.tool', activity.status, { ...identity, activity });
          return req.onToolActivity?.(activity);
        },
        onQuestionRequested: req.onQuestionRequested
          ? (question) => {
              appActivityLog.record('model.question', 'waiting', { ...identity, question });
              return req.onQuestionRequested?.(question);
            }
          : undefined,
        onReasoning: req.onReasoning ? (delta, mode) => {
          appActivityLog.record('model.reasoning', 'observed', { ...identity, delta, mode });
          req.onReasoning?.(delta, mode);
        } : undefined,
        onApprovalRequested: req.onApprovalRequested,
        onProviderCompletionEvidence: req.onProviderCompletionEvidence
          ? (evidence) => {
              appActivityLog.record('model.receipt', 'observed', { ...identity, evidence });
              return req.onProviderCompletionEvidence?.(evidence);
            }
          : undefined,
        onHarnessSessionBound: req.onHarnessSessionBound
          ? (binding) => {
              appActivityLog.record('model.session', 'bound', { ...identity, binding });
              return req.onHarnessSessionBound?.(binding);
            }
          : undefined,
        onPublicTimelineSnapshot: req.onPublicTimelineSnapshot
          ? (snapshot) => {
              appActivityLog.record('model.timeline', 'observed', { ...identity, snapshot });
              return req.onPublicTimelineSnapshot?.(snapshot);
            }
          : undefined,
      }),
    );
  } finally {
    completeActivity();
  }
}
