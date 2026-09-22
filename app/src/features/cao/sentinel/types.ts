import type { CaoExecutionIdentity } from '../executionProfile';

export type CaoTargetKind = 'chat' | 'terminal';
export type CaoRunStatus =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'exited';
export type CaoVerificationStatus = 'pending' | 'partial' | 'verified' | 'failed' | 'unknown';

export type CaoSnapshotCursor = Readonly<{
  targetRevision: number;
  contentHash: string;
  contextRevision: string | null;
  observedAt: number;
}>;

export type CaoTargetSnapshot = Readonly<{
  missionId: string;
  targetId: string;
  kind: CaoTargetKind;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  backend: CaoExecutionIdentity['backend'];
  providerId: string;
  modelId: string;
  reasoningEffort: CaoExecutionIdentity['reasoningEffort'];
  assignment: string;
  ownedPaths: readonly string[];
  targetRevision: number;
  runStatus: CaoRunStatus;
  lastActivityAt: number;
  pendingUserInput: boolean;
  pendingApproval: boolean;
  pendingTool: boolean;
  pendingRetry: boolean;
  receiptIds: readonly string[];
  verification: CaoVerificationStatus;
  recentDelta: string;
  errors: readonly string[];
  claims: readonly string[];
  contextRevision: string | null;
  milestone: string;
  cursor: CaoSnapshotCursor;
}>;

export type CaoTargetSnapshotInput = Omit<CaoTargetSnapshot, 'cursor'> & {
  cursor?: Partial<CaoSnapshotCursor>;
  hiddenReasoning?: unknown;
  apiKey?: unknown;
};

export type CaoSentinelHealth =
  | 'healthy_working'
  | 'waiting_for_user'
  | 'waiting_for_tool'
  | 'likely_stuck'
  | 'failed'
  | 'off_track'
  | 'done_unverified'
  | 'verified_done'
  | 'unclear';

export type CaoSentinelNextAction =
  | 'noop'
  | 'refresh_evidence'
  | 'verify'
  | 'use_candidate_message'
  | 'wake_main_cao'
  | 'ask_user';

export type CaoSentinelObservation = Readonly<{
  missionId: string;
  targetId: string;
  targetRevision: number;
  evidenceHash: string;
  observedAt: number;
  health: CaoSentinelHealth;
  nextAction: CaoSentinelNextAction;
  urgency: number;
  evidenceQuality: number;
  needsMainCaoProbability: number;
  offTrackProbability: number;
  doneWithoutProofProbability: number;
  selectedCandidateMessageId?: string;
  reasonCode: string;
  model?: string;
  usage?: Readonly<{ inputTokens: number | null; outputTokens: number | null }>;
}>;

export type CaoWakePacket = Readonly<{
  key: string;
  missionId: string;
  targetId: string;
  targetRevision: number;
  evidenceHash: string;
  reasonCode: string;
  observedAt: number;
  candidateMessageId?: string;
}>;

export type CaoCandidateMessage = Readonly<{
  id: string;
  targetId: string;
  kind: 'request_evidence' | 'verify' | 'recover';
  body: string;
}>;

export type CaoCandidateDispatchResult = Readonly<{
  status: 'sent' | 'awaiting_approval';
  proposalId?: string;
}>;

export type CaoSentinelTrigger =
  | 'event'
  | 'run-status'
  | 'tool-failure'
  | 'permission'
  | 'approval'
  | 'question'
  | 'terminal-exit'
  | 'output'
  | 'completion'
  | 'context'
  | 'sweep';

export type CaoSentinelDecision = Readonly<{
  action: 'noop' | 'wake_main_cao' | 'ask_user' | 'use_candidate_message';
  reasonCode: string;
  wakeKey?: string;
  candidateMessageId?: string;
}>;
