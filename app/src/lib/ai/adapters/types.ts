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
  | 'provider-reported'
  | 'locally-observed'
  | 'estimated'
  | 'unavailable';

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
  costUsd?: UsageValue<number>;
  quota?: UsageValue<number>;
  resetsAt?: UsageValue<string>;
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'session'; sessionId: string }
  | {
      type: 'tool';
      name: string;
      status: 'started' | 'completed' | 'failed';
      callId?: string;
      result?: unknown;
    }
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
