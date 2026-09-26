import type { CaoTargetKind, CaoTargetSnapshot } from '../sentinel/types';
import type { CaoSentinelDecisionReceipt } from '../sentinel/sentinelRuntime';

export type CaoMissionStatus =
  | 'planning'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type CaoMissionWorker = Readonly<{
  targetId: string;
  kind: CaoTargetKind;
  backend?: 'codex' | 'opencode';
  /** Exact live connection selected for this worker, retained for reload/reconciliation. */
  connectionId?: string;
  modelId?: string;
  reasoningEffort?: string;
  assignment: string;
  ownedPaths: readonly string[];
  status: 'assigned' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  lastObservedRevision: number | null;
  /** Bounded, secret-free final Sentinel decisions for native mission evidence. */
  sentinelReceipts?: readonly CaoSentinelDecisionReceipt[];
  /** Exact authority proposal awaiting user approval, when status is waiting. */
  proposalId?: string;
  /** Durable single-consumer reservation while that proposal is being approved. */
  approvalClaimId?: string;
  /** Result of the last approval attempt when cancellation prevented a status transition. */
  approvalOutcome?: 'pending' | 'delivered' | 'failed';
  approvalClaimedAt?: number;
}>;

export type CaoMissionMilestone = Readonly<{
  id: string;
  label: string;
  status: 'pending' | 'active' | 'completed' | 'failed';
  evidenceIds: readonly string[];
}>;

export type CaoMission = Readonly<{
  id: string;
  schemaVersion: 1;
  accountId: string;
  workspaceId: string;
  projectId: string | null;
  objective: string;
  createdAt: number;
  updatedAt: number;
  status: CaoMissionStatus;
  contextMapId: string | null;
  workers: readonly CaoMissionWorker[];
  milestones: readonly CaoMissionMilestone[];
  latestPlanRevision: number;
  lastCaoWakeAt: number | null;
  /** Bounded, secret-redacted reason when automatic mission start failed. */
  failureReason?: string;
}>;

export type CaoMissionEvidence = Readonly<{
  id: string;
  missionId: string;
  targetId: string;
  targetRevision: number;
  kind: 'snapshot' | 'receipt' | 'verification' | 'wake';
  summary: string;
  observedAt: number;
}>;

export type CaoMissionScope = Readonly<{
  accountId: string;
  workspaceId: string;
  /** Null is reserved for missions that are intentionally projectless. */
  projectId: string | null;
}>;

export type CaoMissionLookup = CaoMissionScope &
  Readonly<{
    missionId: string;
  }>;

export type CaoMissionStore = Readonly<{
  save(mission: CaoMission): Promise<void>;
  /** Atomically replace one exact mission snapshot when it is still current. */
  compareAndSave(input: { expected: CaoMission; next: CaoMission }): Promise<boolean>;
  get(input: CaoMissionLookup): Promise<CaoMission | undefined>;
  list(input: {
    accountId: string;
    workspaceId: string;
    projectId?: string | null;
  }): Promise<readonly CaoMission[]>;
}>;

export type CaoMissionSnapshotReader = (worker: CaoMissionWorker) => Promise<CaoTargetSnapshot>;
