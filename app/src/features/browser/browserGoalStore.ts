import type { ReasoningMode } from '@/lib/ai/reasoningControls';

export type BrowserGoalChatState =
  | 'active'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'recovery_unavailable';

export type BrowserGoalChatSnapshot = Readonly<{
  schemaVersion: 1;
  chatId: string;
  goalId: string;
  accountId: string;
  projectId: string;
  runId: string;
  objective: string;
  state: BrowserGoalChatState;
  tokenMode: ReasoningMode;
  providerId: string;
  modelId: string;
  connectionId?: string;
  completedActions: number;
  totalActions: number;
  checkpointSequence: number;
  checkpointState: 'running' | 'blocked' | 'ready_for_completion';
  checkpointCreatedAt: number;
  cursorExpiresAt: number;
  currentOrigin?: string;
  nextAction?: Readonly<{ kind: string; summary: string }>;
  approval?: Readonly<{ reviewId: string; risk: 'safe' | 'confirm' | 'dangerous' }>;
  evidenceRefs: readonly string[];
  providerArtifactRefs: readonly string[];
  failureReason?: string;
}>;

export interface BrowserGoalStore {
  getSnapshot(chatId: string): BrowserGoalChatSnapshot | undefined;
  getAllSnapshots(): readonly BrowserGoalChatSnapshot[];
  subscribe(listener: () => void): () => void;
  publish(snapshot: BrowserGoalChatSnapshot): void;
  remove(chatId: string): void;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;
const EVIDENCE_REF = /^j(?:result|live)_[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const RESULT_REF = /^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/u;

function isOrigin(value: string): boolean {
  if (value.length > 2_048 || CONTROL_CHAR.test(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function immutable(snapshot: BrowserGoalChatSnapshot): BrowserGoalChatSnapshot {
  if (
    snapshot.schemaVersion !== 1 ||
    !SAFE_ID.test(snapshot.chatId) ||
    !SAFE_ID.test(snapshot.goalId) ||
    !SAFE_ID.test(snapshot.accountId) ||
    !SAFE_ID.test(snapshot.projectId) ||
    !SAFE_ID.test(snapshot.runId) ||
    !SAFE_ID.test(snapshot.providerId) ||
    !SAFE_ID.test(snapshot.modelId) ||
    ![
      'active',
      'awaiting_approval',
      'paused',
      'completed',
      'cancelled',
      'failed',
      'recovery_unavailable',
    ].includes(snapshot.state) ||
    !snapshot.objective ||
    snapshot.objective.length > 2_000 ||
    CONTROL_CHAR.test(snapshot.objective) ||
    (snapshot.connectionId !== undefined && !SAFE_ID.test(snapshot.connectionId)) ||
    !['token-saver', 'normal', 'token-final-boss'].includes(snapshot.tokenMode) ||
    !Number.isSafeInteger(snapshot.completedActions) ||
    !Number.isSafeInteger(snapshot.totalActions) ||
    snapshot.completedActions < 0 ||
    snapshot.totalActions < snapshot.completedActions ||
    !Number.isSafeInteger(snapshot.checkpointSequence) ||
    snapshot.checkpointSequence < 1 ||
    !['running', 'blocked', 'ready_for_completion'].includes(snapshot.checkpointState) ||
    !Number.isFinite(snapshot.checkpointCreatedAt) ||
    !Number.isFinite(snapshot.cursorExpiresAt) ||
    (snapshot.currentOrigin !== undefined && !isOrigin(snapshot.currentOrigin)) ||
    (snapshot.nextAction !== undefined &&
      (!snapshot.nextAction.kind ||
        snapshot.nextAction.kind.length > 160 ||
        !snapshot.nextAction.summary ||
        snapshot.nextAction.summary.length > 500 ||
        CONTROL_CHAR.test(`${snapshot.nextAction.kind}${snapshot.nextAction.summary}`))) ||
    (snapshot.approval !== undefined &&
      (!SAFE_ID.test(snapshot.approval.reviewId) ||
        !['safe', 'confirm', 'dangerous'].includes(snapshot.approval.risk))) ||
    (snapshot.failureReason !== undefined &&
      (!snapshot.failureReason ||
        snapshot.failureReason.length > 500 ||
        CONTROL_CHAR.test(snapshot.failureReason))) ||
    snapshot.evidenceRefs.length > 256 ||
    snapshot.evidenceRefs.some((reference) => !EVIDENCE_REF.test(reference)) ||
    snapshot.providerArtifactRefs.length > 128 ||
    snapshot.providerArtifactRefs.some((reference) => !RESULT_REF.test(reference))
  ) {
    throw new Error('Invalid browser goal chat snapshot.');
  }
  return Object.freeze({
    ...snapshot,
    ...(snapshot.nextAction
      ? { nextAction: Object.freeze({ ...snapshot.nextAction }) }
      : {}),
    ...(snapshot.approval ? { approval: Object.freeze({ ...snapshot.approval }) } : {}),
    evidenceRefs: Object.freeze([...snapshot.evidenceRefs]),
    providerArtifactRefs: Object.freeze([...snapshot.providerArtifactRefs]),
  });
}

export function createBrowserGoalStore(): BrowserGoalStore {
  const snapshots = new Map<string, BrowserGoalChatSnapshot>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // UI subscribers are observational.
      }
    }
  };
  return Object.freeze<BrowserGoalStore>({
    getSnapshot: (chatId) => snapshots.get(chatId),
    getAllSnapshots: () =>
      Object.freeze(
        [...snapshots.values()].sort((left, right) => left.chatId.localeCompare(right.chatId)),
      ),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(candidate) {
      const snapshot = immutable(candidate);
      const previous = snapshots.get(snapshot.chatId);
      if (
        previous &&
        (previous.accountId !== snapshot.accountId ||
          previous.projectId !== snapshot.projectId ||
          previous.runId !== snapshot.runId ||
          previous.goalId !== snapshot.goalId ||
          previous.providerId !== snapshot.providerId ||
          previous.modelId !== snapshot.modelId ||
          previous.connectionId !== snapshot.connectionId ||
          snapshot.checkpointSequence < previous.checkpointSequence ||
          (['completed', 'cancelled'].includes(previous.state) &&
            previous.state !== snapshot.state))
      ) {
        throw new Error('Browser goal chat identity cannot change.');
      }
      snapshots.set(snapshot.chatId, snapshot);
      emit();
    },
    remove(chatId) {
      if (snapshots.delete(chatId)) emit();
    },
  });
}

export const browserGoalStore = createBrowserGoalStore();
