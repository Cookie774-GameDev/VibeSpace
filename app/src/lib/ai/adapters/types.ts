import type { ToolGatewayAuthorityClaim } from '@/lib/harness/toolGatewayAuthority';

export type ConnectionMode = 'external-cli' | 'native-api' | 'local';

export type JarvisPromptTransportStrategy = 'native-system' | 'prefixed-preamble' | 'unsupported';
export type ProviderToolName = 'vibespace_context';

export interface ProviderCapabilities {
  text: boolean;
  images: boolean;
  files: boolean;
  tools: boolean;
  modelSelection: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  cancellation: boolean;
  resumeSession: boolean;
  systemPrompt: boolean;
  workingDirectory: boolean;
  usage: boolean;
  subscriptionQuota: boolean;
  localOnly: boolean;
}

export interface ProviderConnection {
  id: string;
  adapterId: string;
  providerId: string;
  displayName: string;
  mode: ConnectionMode;
  authSource: string;
  modelId?: string;
  capabilities: ProviderCapabilities;
  toolAllowlist?: readonly ProviderToolName[];
  promptTransport: JarvisPromptTransportStrategy;
  enabled: boolean;
}

export type UsageProvenance =
  'provider-reported' | 'locally-observed' | 'estimated' | 'unavailable';

export interface UsageValue<T> {
  value?: T;
  provenance: UsageProvenance;
  reason?: string;
}

export interface UsageSnapshot {
  capturedAt: number;
  inputTokens?: UsageValue<number>;
  outputTokens?: UsageValue<number>;
  totalTokens?: UsageValue<number>;
  cacheReadTokens?: UsageValue<number>;
  cacheWriteTokens?: UsageValue<number>;
  reasoningTokens?: UsageValue<number>;
  costUsd?: UsageValue<number>;
  quota?: UsageValue<number>;
  resetsAt?: UsageValue<string>;
}

export interface ProviderQuestionOption {
  label: string;
  description: string;
}

export interface ProviderQuestionPrompt {
  header: string;
  prompt: string;
  options: readonly ProviderQuestionOption[];
  multiple: boolean;
  /** OpenCode defaults omitted `custom` metadata to enabled. */
  allowCustomAnswer: boolean;
}

export interface ProviderQuestionRequest {
  /** Exact native OpenCode question identity used by the future reply/reject bridge. */
  id: string;
  /** Exact OpenCode session that owns this blocking question request. */
  sessionId: string;
  questions: readonly ProviderQuestionPrompt[];
  /** Original Codex JSON-RPC response identity, retained for native receipts. */
  nativeRequestId?: string | number;
  /** Native receive-time deadline; absent when the server supplies no timeout. */
  deadlineAt?: number;
  /** Exact optional native tool-call binding; never contains tool input or output. */
  tool?: Readonly<{ messageId: string; callId: string }>;
}

export type PublicJson = null | boolean | number | string | readonly PublicJson[] | { readonly [key: string]: PublicJson };

export interface PublicToolOutput {
  text: string;
  mode: 'append' | 'replace';
  complete: boolean;
  omittedBytes: number;
  redacted?: boolean;
}

export interface PublicToolFileChange {
  /** Display only: opening this path still requires the trusted project resolver. */
  path: string;
  kind: 'add' | 'update' | 'delete' | 'move' | 'unknown';
  destinationPath?: string;
  diff?: string;
  /** Bounded file text for write tools when the provider did not expose a before-state diff. */
  writtenContent?: string;
  complete: boolean;
}

export interface PublicToolDetails {
  arguments?: PublicJson;
  command?: string;
  cwd?: string;
  output?: Readonly<PublicToolOutput>;
  result?: PublicJson;
  error?: PublicJson;
  exitCode?: number;
  durationMs?: number;
  changes?: readonly Readonly<PublicToolFileChange>[];
  omittedChanges?: number;
  redacted?: boolean;
  truncated?: boolean;
}

export type ProviderEvent =
  | {
      type: 'text';
      delta: string;
      /** Replace the matching native text part instead of appending to it. */
      mode?: 'append' | 'replace';
      /** Request-local opaque identity for one native provider text part. */
      streamPartId?: string;
    }
  | {
      /** Complete authoritative replacement snapshot from persisted OpenCode messages. */
      type: 'public_timeline';
      snapshot: import('../openCodePublicTimeline').OpenCodePublicTimelineSnapshot;
    }
  | { type: 'reasoning'; delta: string; mode?: 'replace' }
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool';
      name: string;
      status: 'started' | 'completed' | 'failed';
      callId?: string;
      /** Privacy-safe leaf filename only; never a directory or raw provider argument. */
      fileLabel?: string;
      nativeTask?: import('../openCodeNativeActivity').NativeTaskActivity;
      result?: unknown;
      /** Validated, bounded public display data; never executable authority. */
      details?: Readonly<PublicToolDetails>;
      /** Sanitized request-local scope classification; never carries a path or reusable authority. */
      scope?: 'explicit_root_inventory';
      /** Bounded OpenCode todo evidence. Never carries generic tool input or output. */
      checklist?: import('../openCodeChecklist').OpenCodeChecklistSnapshot;
    }
  | { type: 'tool_output'; callId: string; output: Readonly<PublicToolOutput> }
  | { type: 'question'; request: ProviderQuestionRequest }
  | { type: 'question-resolved'; requestId: string; sessionId: string }
  | { type: 'model'; modelId: string }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'warning'; message: string }
  | {
      type: 'error';
      /** Sanitized provider detail; never contains credentials or raw bodies. */
      message: string;
      code?: string;
      providerId?: string;
      modelId?: string;
      connectionId?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      resetAt?: number;
      requestId?: string;
      runId?: string;
    }
  | { type: 'done'; finishReason?: string };

export interface DetectionResult {
  status: 'available' | 'unavailable' | 'requires_attention';
  version?: string;
  executablePath?: string;
  detail?: string;
}

export interface AuthProbeResult {
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  accountLabel?: string;
  detail?: string;
}

export interface ProviderDiscoveredModel {
  id: string;
  label: string;
  /** Exact live upstream variant ids, when exposed by this connection. */
  variants?: readonly string[];
  /** Exact native provider default effort, only when it is advertised in variants. */
  defaultReasoningEffort?: string;
  /** Exact live upstream pricing, only when every supported field was observed. */
  pricing?: Readonly<import('@/lib/harness/types').HarnessModelPricing>;
}

export type CodexResolvedProviderRoute =
  | Readonly<{
      kind: 'official-codex';
      connectionId: 'openai-codex';
      providerId: 'openai';
      modelId: string;
    }>
  | Readonly<{
      kind: 'direct-responses' | 'opencodex-translation';
      accountId: string;
      connectionId: string;
      providerId: string;
      modelId: string;
      upstreamModelId: string;
      routeHandle: string;
      configurationGeneration: string;
      adapter?: 'openai-chat' | 'openai-responses' | 'anthropic' | 'google' | 'azure-openai';
    }>;

export interface ProviderRequest {
  requestId: string;
  connection: ProviderConnection;
  /** Stable VibeSpace identity/scope binding used by persistent transports. */
  chatId?: string;
  accountId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  /**
   * Exact authority claim captured when the chat send was accepted. `undefined`
   * keeps legacy direct-adapter callers on the current-scope fallback; `null`
   * records that early capture failed and must remain fail-closed.
   */
  toolGatewayAuthority?: ToolGatewayAuthorityClaim | null;
  prompt: string;
  /** Supplied conversation context for a newly created persistent thread only. */
  historyPrompt?: string;
  modelId?: string;
  /** Native-revalidated Codex route authority for Codex-backed turns only. */
  codexRoute?: CodexResolvedProviderRoute;
  /** Exact enabled native Codex skills from this cwd's skills/list response. */
  codexSkills?: readonly import('./codexAppServerProtocol').CodexDiscoveredSkill[];
  /** Exact selected references revalidated against the active OpenCode skill catalog. */
  nativeSkillRefs?: readonly import('@/lib/harness/OpenCodeTurnCoordinator').OpenCodeNativeSkillReference[];
  /** Native skills/changed refresh for the active Codex working directory. */
  onCodexSkillsChanged?: (entry: import('./codexAppServerProtocol').CodexSkillsListEntry) => void | Promise<void>;
  /** Immutable request/run identity used to retain exact failure correlation. */
  protectedAttempt?: Readonly<{
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
  }>;
  reasoningEffort?: string;
  systemPrompt?: string;
  workingDirectory?: string;
  /** Trusted caller classification: the user supplied the working directory as this turn's read scope. */
  explicitReadRoot?: boolean;
  /** Trusted caller classification: synthesize only from evidence already collected in this session. */
  explicitReadSynthesis?: boolean;
  /** Existing persistent session required before a protected follow-up may be sent. */
  expectedSessionId?: string;
  sessionId?: string;
  /** Exact acknowledged native submission; never synthesize a fresh turn for it. */
  nativeQueuedSubmission?: Readonly<{
    submissionId: string;
    clientUserMessageId: string;
    threadId: string;
    addedDuringTurnId: string;
    previousTurnCompleted: boolean;
  }>;
  /** Exact per-turn VibeSpace controls; adapters must reject unsupported values. */
  runtimeSettings?: import('@/features/chat/runtime/chatRuntimeCommandController').ChatRuntimeSettings;
  interactionMode?: import('@/lib/permissions/OpenCodePermissionProfile').InteractionMode;
  accessLevel?: import('@/lib/permissions/OpenCodePermissionProfile').AccessLevel;
  agentApprovalMode?: import('@/lib/permissions/OpenCodePermissionProfile').AgentApprovalMode;
  approveAllForRun?: boolean;
  /** Approval events remain user-visible even when the persistent adapter enforces policy. */
  onApprovalRequested?: (
    approval: import('@/lib/harness/types').VibeSpaceApproval,
  ) => void | Promise<void>;
  onSessionBound?: (binding: {
    sessionId: string;
    parentSessionId?: string;
  }) => void | Promise<void>;
  /** Provider-native controls available only while this exact persistent turn is active. */
  onLiveTurnControl?: (control: ProviderLiveTurnControl | null) => void;
  /** Explicit connection-qualified tool availability for the turn. */
  tools?: Readonly<Record<string, boolean>>;
  signal?: AbortSignal;
  onResponseObservation?: (
    observation:
      | { kind: 'bytes'; byteLength: number; observedAt: number }
      | { kind: 'sdk_chunk'; observedAt: number },
  ) => void;
  onActionDispatch?: (input: { observedAt: number }) => void;
}

export interface ProviderLiveTurnControl {
  steer(input: { clientUserMessageId: string; text: string; skills?: readonly import('./codexAppServerProtocol').CodexDiscoveredSkill[] }): Promise<void>;
  enqueue(input: { clientUserMessageId: string; text: string; skills?: readonly import('./codexAppServerProtocol').CodexDiscoveredSkill[] }): Promise<{
    submissionId: string;
    threadId: string;
    turnId: string;
  }>;
}

/**
 * Shared adapter surface. Optional operations let capability descriptors stay
 * truthful: an adapter does not need to implement behavior it cannot support.
 */
export interface ProviderAdapter {
  id: string;
  detect?: () => Promise<DetectionResult>;
  probeAuth?: (connection: ProviderConnection) => Promise<AuthProbeResult>;
  listModels?: () => Promise<readonly Readonly<ProviderDiscoveredModel>[]>;
  send?: (request: ProviderRequest) => AsyncIterable<ProviderEvent>;
  cancel?: (requestId: string) => Promise<void>;
  getUsage?: (connection: ProviderConnection) => Promise<UsageSnapshot>;
}
