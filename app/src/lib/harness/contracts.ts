export interface HarnessScope {
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  worktreeId?: string;
  workingDirectory?: string;
}

export interface HarnessReady {
  runtimeId: string;
  runtimeVersion: string;
  serverGeneration: string;
  healthy: boolean;
}

export interface HarnessModelSelection {
  connectionId: string;
  providerId: string;
  modelId: string;
  variant?: string;
}

export interface HarnessSession {
  id: string;
  parentId?: string;
  scope: HarnessScope;
  serverGeneration: string;
}

export interface HarnessSendRequest {
  sessionId: string;
  message: string;
  selection: HarnessModelSelection;
  mode: 'ask' | 'plan' | 'agent';
  access: 'read-only' | 'write' | 'full';
  rlmEnabled: boolean;
  performanceProfile: 'responsive' | 'balanced' | 'quality';
}

export type HarnessEvent =
  | { type: 'connected'; runtimeVersion: string }
  | { type: 'model_observed'; selection: HarnessModelSelection }
  | { type: 'reasoning_delta'; text: string; partKey?: string }
  | { type: 'reasoning_snapshot'; text: string; partKey: string }
  | { type: 'text_delta'; text: string; partKey?: string }
  | { type: 'text_snapshot'; text: string; partKey: string }
  | { type: 'tool_proposed'; callId: string; name: string }
  | { type: 'tool_started'; callId: string; name: string }
  | { type: 'tool_progress'; callId: string; summary: string }
  | { type: 'tool_completed'; callId: string; result: unknown }
  | { type: 'permission_requested'; requestId: string; summary: string }
  | { type: 'child_started'; childId: string }
  | { type: 'child_progress'; childId: string; summary: string }
  | { type: 'child_completed'; childId: string }
  | { type: 'rlm_route'; route: 'direct' | 'retrieval' | 'rlm'; runId?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'warning'; code: string; message: string }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'done'; finishReason?: string };

export interface VibeSpaceHarness {
  ensureReady(scope: HarnessScope): Promise<HarnessReady>;
  listConnections(scope: HarnessScope): Promise<unknown[]>;
  listModels(scope: HarnessScope, connectionId?: string): Promise<unknown[]>;
  refreshModels(scope: HarnessScope, connectionId?: string): Promise<unknown[]>;
  createSession(scope: HarnessScope, parentId?: string): Promise<HarnessSession>;
  getSession(scope: HarnessScope, sessionId: string): Promise<HarnessSession | null>;
  listChildSessions(scope: HarnessScope, sessionId: string): Promise<HarnessSession[]>;
  send(scope: HarnessScope, request: HarnessSendRequest): AsyncIterable<HarnessEvent>;
  cancel(scope: HarnessScope, sessionId: string, turnId?: string): Promise<void>;
  respondToPermission(scope: HarnessScope, requestId: string, response: 'allow' | 'deny'): Promise<void>;
  disposeScope(scope: HarnessScope): Promise<void>;
}

/** Production invariant: every warm send shares an owned server generation. */
export function assertPersistentServerGeneration(
  ready: HarnessReady,
  session: HarnessSession,
): void {
  if (!ready.healthy || ready.serverGeneration !== session.serverGeneration) {
    throw new Error('HARNESS_SERVER_GENERATION_MISMATCH');
  }
}

export function assertObservedSelection(
  requested: HarnessModelSelection,
  observed: HarnessModelSelection,
): void {
  if (
    requested.connectionId !== observed.connectionId
    || requested.providerId !== observed.providerId
    || requested.modelId !== observed.modelId
    || requested.variant !== observed.variant
  ) {
    throw new Error('MODEL_OBSERVED_MISMATCH');
  }
}
