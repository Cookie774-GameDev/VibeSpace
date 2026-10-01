export type HarnessRuntimeState =
  | { kind: 'checking' }
  | { kind: 'missing' }
  | { kind: 'download_required' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'verifying' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'ready'; source: 'system' | 'managed'; version: string }
  | { kind: 'incompatible'; reason: string }
  | { kind: 'failed'; recoverable: boolean; message: string };

export type HarnessErrorCode =
  | 'HARNESS_MISSING'
  | 'HARNESS_DOWNLOAD_FAILED'
  | 'HARNESS_HASH_MISMATCH'
  | 'HARNESS_INCOMPATIBLE'
  | 'HARNESS_START_FAILED'
  | 'HARNESS_HEALTH_FAILED'
  | 'HARNESS_CRASHED'
  | 'HARNESS_AUTH_FAILED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'MODEL_NOT_AVAILABLE'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'LOCAL_MODEL_NOT_INSTALLED'
  | 'OLLAMA_UNAVAILABLE'
  | 'LOCAL_MODEL_TOOL_UNRELIABLE'
  | 'PERMISSION_DENIED'
  | 'SESSION_NOT_FOUND'
  | 'REQUEST_CANCELLED'
  | 'REQUEST_TIMEOUT';

export interface HarnessErrorPayload {
  code: HarnessErrorCode;
  message: string;
  repair: string;
  recoverable: boolean;
  diagnostic?: string;
}

export interface HarnessModel {
  id: string;
  name: string;
  contextWindowTokens?: number;
  supportsImages?: boolean;
  supportsTools?: boolean;
  variants?: readonly string[];
  pricing?: Readonly<HarnessModelPricing>;
}

export interface HarnessModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HarnessProvider {
  id: string;
  name: string;
  models: readonly HarnessModel[];
  connected?: boolean;
}

export interface HarnessModelSelection {
  providerId: string;
  modelId: string;
  connectionId?: string;
  runtimeProviderId?: string;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  providerId?: string;
  modelId?: string;
}

export interface VibeSpaceApproval {
  id: string;
  sessionId: string;
  title: string;
  capability: string;
  pattern?: string | readonly string[];
}

export type HarnessEvent =
  | { type: 'assistant.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'file.read'; path: string }
  | { type: 'file.changed'; path: string; operation: string }
  | { type: 'search.started'; query?: string }
  | { type: 'search.completed'; query?: string }
  | { type: 'shell.started'; id: string; command?: string }
  | { type: 'shell.output'; id: string; text: string }
  | { type: 'shell.completed'; id: string; exitCode?: number }
  | { type: 'tool.started'; name: string; callId?: string }
  | { type: 'tool.completed'; name: string; callId?: string }
  | { type: 'tool.failed'; name: string; message: string }
  | { type: 'approval.requested'; approval: VibeSpaceApproval }
  | { type: 'subagent.started'; id: string; parentId?: string }
  | { type: 'subagent.updated'; id: string; status: string }
  | { type: 'subagent.completed'; id: string }
  | { type: 'usage.updated'; usage: NormalizedUsage }
  | { type: 'context.compacted'; before?: number; after?: number }
  | { type: 'session.updated'; sessionId: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string; code?: string };

export interface HarnessReady {
  source: 'system' | 'managed';
  version: string;
}

export interface CreateHarnessSession {
  chatId: string;
  title?: string;
  parentSessionId?: string;
  workingDirectory?: string;
}

export interface HarnessSession {
  id: string;
  chatId: string;
  parentSessionId?: string;
}

export interface HarnessSendRequest {
  sessionId: string;
  selection: HarnessModelSelection;
  agent?: string;
  variant?: string;
  system?: string;
  parts: readonly unknown[];
  signal?: AbortSignal;
  workingDirectory?: string;
  tools?: Readonly<Record<string, boolean>>;
}

export interface HarnessApprovalResponse {
  sessionId: string;
  approvalId: string;
  response: 'once' | 'always' | 'reject';
}

export interface VibeSpaceHarness {
  ensureReady(): Promise<HarnessReady>;
  createSession(input: CreateHarnessSession): Promise<HarnessSession>;
  deleteSession?(sessionId: string, workingDirectory?: string): Promise<void>;
  send(input: HarnessSendRequest): AsyncIterable<HarnessEvent>;
  cancel(sessionId: string, turnId?: string): Promise<void>;
  listProviders(): Promise<readonly HarnessProvider[]>;
  listModels(providerId?: string): Promise<readonly HarnessModel[]>;
  respondToApproval(input: HarnessApprovalResponse): Promise<void>;
  dispose(): Promise<void>;
}
