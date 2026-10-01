/**
 * Canonical PR31 AI router.
 *
 * All ordinary production turns cross the persistent OpenCode boundary.
 * Exactly two bounded direct executors exist: (1) the explicitly gated
 * Shared Intelligence Kernel smoke provider (debug-only native smoke
 * qualification), and (2) the Model Foundry local adapter executor, which is
 * desktop-only, credential-free, and fails closed on unverified adapters. Provider/model selection, VibeSpace scope, runtime controls,
 * permissions, cancellation, and protected-attempt evidence are preserved as
 * data across the OpenCode boundary rather than reimplemented by per-provider
 * executors in this router.
 */
import type { Agent, ProviderId } from '@/types';
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
} from './adapters/types';
import { CONNECTION_MODEL_OPTIONS, getProviderConnectionDescriptor } from './adapters/catalog';
import { openCodePersistentAdapter } from './adapters/opencodePersistent';
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

const providerAttemptEvidenceAuthority = createJarvisProviderAttemptEvidenceAuthority({ sha256: sha256Hex });

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
  onHarnessSessionBound?: (binding: { sessionId: string; parentSessionId?: string }) =>
    | void
    | Promise<void>;
  protectedAttempt?: Readonly<{
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
  }>;
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
    if (!connection.enabled) throw new Error(`Provider connection is disabled: ${req.connectionId}`);
    if (auth.offlineMode && connection.mode !== 'local' && connection.adapterId !== 'opencode-cli') {
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
    (req.agent.builtin && req.agent.model.provider === 'mock' && req.agent.model.model === 'mock-default');
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
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  const connection = openCodeGatewayConnection(selection);
  if (!openCodePersistentAdapter.send) throw new Error('Persistent OpenCode transport is unavailable.');
  const detection = openCodePersistentAdapter.detect
    ? await openCodePersistentAdapter.detect()
    : { status: 'unavailable' as const };
  if (detection.status !== 'available') throw new Error('Persistent OpenCode is unavailable.');
  const auth = openCodePersistentAdapter.probeAuth
    ? await openCodePersistentAdapter.probeAuth(connection)
    : { status: 'unknown' as const };
  if (auth.status === 'unauthenticated') throw new Error('OpenCode is signed out.');
  if (auth.status !== 'authenticated') {
    throw new Error('OpenCode authentication could not be verified.');
  }

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
  let first = true;
  let finishReason: string | undefined;
  let usage: Extract<ProviderEvent, { type: 'usage' }>['usage'] | undefined;
  for await (const event of openCodePersistentAdapter.send({
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
    runtimeSettings,
    interactionMode: req.interactionMode,
    accessLevel: req.accessLevel,
    approveAllForRun: req.approveAllForRun,
    tools: req.tools,
    signal: req.signal,
    onApprovalRequested: req.onApprovalRequested,
    onSessionBound: req.onHarnessSessionBound,
    onResponseObservation: hooks?.onResponseObservation,
    onActionDispatch: hooks?.onActionDispatch,
  })) {
    if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
    if (event.type === 'text') {
      text += event.delta;
      req.onChunk?.({ delta: event.delta, first });
      first = false;
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else if (event.type === 'done') {
      finishReason = event.finishReason;
    }
  }
  if (req.signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
  req.onChunk?.({ delta: '', done: true });
  return {
    text,
    usage: {
      input_tokens: usageNumber(usage?.inputTokens),
      output_tokens: usageNumber(usage?.outputTokens),
      cost_usd: usageNumber(usage?.costUsd),
    },
    provider: (selection.providerId === 'local' ? 'ollama' : selection.providerId) as ProviderId,
    model: selection.modelId,
    ...(finishReason ? { finish_reason: finishReason } : {}),
  };
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
  const dispatch = (hooks?: ProtectedAttemptHooks) => executePersistentOpenCode(req, selection, hooks);
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
  const auth = adapter.probeAuth ? await adapter.probeAuth(connection) : { status: 'unknown' as const };
  if (auth.status === 'unauthenticated') throw new Error('Kernel smoke adapter is signed out.');
  if (auth.status !== 'authenticated' && !isKernelSmokeBindingActive()) {
    throw new Error('Kernel smoke authentication could not be verified.');
  }

  let text = '';
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
      text += event.delta;
      args.onChunk?.({ delta: event.delta, first });
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

  if (!req.connectionId) throw new Error('Kernel smoke dispatch requires its exact debug connection.');
  const connection = getProviderConnectionDescriptor(req.connectionId);
  if (connection.providerId !== KERNEL_SMOKE_PROVIDER_ID) {
    throw new Error('Kernel smoke provider connection is invalid.');
  }
  recordKernelSmokeRouterDispatch(protectedDispatch ? 'protected' : 'unprotected');
  if (connection.mode === 'external-cli') {
    const transport = protectedDispatch
      ? buildProviderPromptTransport({ compiled: req.compiledPrompt!, connection, messages: req.messages })
      : undefined;
    const prompt = transport?.strategy === 'prefixed-preamble'
      ? transport.prompt
      : promptForOpenCode(req.messages);
    const dispatch = (hooks?: ProtectedAttemptHooks) => runKernelSmokeCliConnection({
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
    useAgentStore.getState().addTokens(
      req.agent.id,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cost_usd,
    );
    return response;
  }

  const resolved = resolveKernelSmokeProviderAndModel(connection, req.agent);
  const transport = protectedDispatch
    ? buildProviderPromptTransport({ compiled: req.compiledPrompt!, connection, messages: req.messages })
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
        (hooks) => resolved.provider.run({
          ...llmReq,
          onResponseObservation: hooks.onResponseObservation,
          onActionDispatch: hooks.onActionDispatch,
        }),
      )
    : await resolved.provider.run(llmReq);
  useAgentStore.getState().addTokens(
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
  useAgentStore.getState().addTokens(
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
  return dispatchThroughOpenCode(req);
}

export async function runAgent(req: RunAgentRequest): Promise<LLMResponse> {
  const activityId = req.connectionId ?? req.agent.model.provider;
  const completeActivity = providerActivityTracker.begin(activityId);
  try {
    return await runAgentDispatch(req);
  } finally {
    completeActivity();
  }
}
