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
  /** Exact optional native tool-call binding; never contains tool input or output. */
  tool?: Readonly<{ messageId: string; callId: string }>;
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
  | { type: 'reasoning'; delta: string }
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
      /** Sanitized request-local scope classification; never carries a path or reusable authority. */
      scope?: 'explicit_root_inventory';
      /** Bounded OpenCode todo evidence. Never carries generic tool input or output. */
      checklist?: import('../openCodeChecklist').OpenCodeChecklistSnapshot;
    }
  | { type: 'question'; request: ProviderQuestionRequest }
  | { type: 'model'; modelId: string }
  | { type: 'usage'; usage: UsageSnapshot }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
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
  /** Exact live upstream pricing, only when every supported field was observed. */
  pricing?: Readonly<import('@/lib/harness/types').HarnessModelPricing>;
}

export interface ProviderRequest {
  requestId: string;
  connection: ProviderConnection;
  /** Stable VibeSpace identity/scope binding used by persistent transports. */
  chatId?: string;
  accountId?: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  prompt: string;
  modelId?: string;
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
  /** Exact per-turn VibeSpace controls; adapters must reject unsupported values. */
  runtimeSettings?: import('@/features/chat/runtime/chatRuntimeCommandController').ChatRuntimeSettings;
  interactionMode?: import('@/lib/permissions/OpenCodePermissionProfile').InteractionMode;
  accessLevel?: import('@/lib/permissions/OpenCodePermissionProfile').AccessLevel;
  approveAllForRun?: boolean;
  /** Approval events remain user-visible even when the persistent adapter enforces policy. */
  onApprovalRequested?: (
    approval: import('@/lib/harness/types').VibeSpaceApproval,
  ) => void | Promise<void>;
  onSessionBound?: (binding: {
    sessionId: string;
    parentSessionId?: string;
  }) => void | Promise<void>;
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
