import type { BrowserGoalRuntime } from '@/lib/jarvis/browserGoalRuntime';
import type {
  GoalCheckpointRepository,
  GoalCheckpointStoredRecordV1,
} from '@/lib/jarvis/goalCheckpointRepository';
import type { GoalResumeCurrentAuthority } from '@/lib/jarvis/goalCheckpoint';
import type { ProviderGoalAdapter, ProviderGoalPayload } from '@/lib/jarvis/providerGoalAdapter';
import type { CanonicalCriterionEvidenceV1 } from '@/lib/jarvis/truthfulCompletion';
import { readChatReasoningPreference } from '@/features/chat/reasoningSlashStore';
import {
  browserGoalStore,
  type BrowserGoalChatSnapshot,
  type BrowserGoalStore,
} from './browserGoalStore';
import {
  browserNativeHandoffRuntime,
  type BrowserNativeHandoffEnvelope,
  type BrowserNativeHandoffRequest,
  type BrowserNativeHandoffReturn,
  type BrowserNativeHandoffReceipt,
  type BrowserNativeHandoffRuntime,
} from './browserNativeHandoff';

const SAFE_FAILURE = 'Browser goal recovery authority is unavailable.';

export type BrowserGoalChatControls = Readonly<{
  pause(record: GoalCheckpointStoredRecordV1): Promise<GoalCheckpointStoredRecordV1>;
  cancel(record: GoalCheckpointStoredRecordV1): Promise<GoalCheckpointStoredRecordV1>;
  resume(record: GoalCheckpointStoredRecordV1): Promise<GoalCheckpointStoredRecordV1>;
}>;

export type BrowserGoalChatBinding = Readonly<{
  chatId: string;
  record: GoalCheckpointStoredRecordV1;
  repository: GoalCheckpointRepository;
  goalRuntime: BrowserGoalRuntime;
  provider: ProviderGoalAdapter;
  currentAuthority(): GoalResumeCurrentAuthority;
  controls: BrowserGoalChatControls;
  completedActions?: number;
  totalActions?: number;
  currentOrigin?: string;
  nextAction?: Readonly<{ kind: string; summary: string }>;
  approval?: Readonly<{ reviewId: string; risk: 'safe' | 'confirm' | 'dangerous' }>;
  handoffApproval?: Readonly<{ approvalId: string; reviewId: string }>;
  initialState?: Extract<BrowserGoalChatSnapshot['state'], 'cancelled' | 'failed'>;
}>;

export interface BrowserGoalChatRuntime {
  activate(binding: BrowserGoalChatBinding): BrowserGoalChatSnapshot;
  acceptProviderEvent(
    chatId: string,
    payload: ProviderGoalPayload,
    observedAt: number,
  ): Promise<BrowserGoalChatSnapshot>;
  updateCheckpoint(input: {
    chatId: string;
    record: GoalCheckpointStoredRecordV1;
    evidence?: readonly CanonicalCriterionEvidenceV1[];
    completedActions?: number;
    totalActions?: number;
    currentOrigin?: string;
    nextAction?: Readonly<{ kind: string; summary: string }>;
    approval?: BrowserGoalChatBinding['approval'];
    clearNextAction?: boolean;
  }): BrowserGoalChatSnapshot;
  fail(input: {
    chatId: string;
    record: GoalCheckpointStoredRecordV1;
    reason: string;
  }): BrowserGoalChatSnapshot;
  pause(chatId: string): Promise<BrowserGoalChatSnapshot>;
  cancel(chatId: string): Promise<BrowserGoalChatSnapshot>;
  resume(chatId: string): Promise<BrowserGoalChatSnapshot>;
  recover(binding: BrowserGoalChatBinding): Promise<BrowserGoalChatSnapshot>;
  issueNativeHandoff(
    chatId: string,
    request: BrowserNativeHandoffRequest,
  ): Promise<BrowserNativeHandoffEnvelope>;
  acceptNativeHandoff(
    chatId: string,
    envelope: BrowserNativeHandoffEnvelope,
    returned: BrowserNativeHandoffReturn,
    observedAt: number,
  ): Promise<Readonly<{
    snapshot: BrowserGoalChatSnapshot;
    receipt: BrowserNativeHandoffReceipt;
  }>>;
}

type Managed = {
  binding: BrowserGoalChatBinding;
  record: GoalCheckpointStoredRecordV1;
  providerArtifactRefs: string[];
  state: BrowserGoalChatSnapshot['state'];
  failureReason?: string;
  busy: boolean;
};

function safeOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.origin === value ? value : url.origin;
  } catch {
    throw new Error('Invalid browser goal origin.');
  }
}

function boundedNextAction(
  value: BrowserGoalChatBinding['nextAction'],
): BrowserGoalChatBinding['nextAction'] {
  if (!value) return undefined;
  if (
    !value.kind ||
    value.kind.length > 160 ||
    !value.summary ||
    value.summary.length > 500 ||
    /[\u0000-\u001f\u007f]/u.test(`${value.kind}${value.summary}`)
  ) {
    throw new Error('Invalid browser goal next action.');
  }
  return Object.freeze({ ...value });
}

function checkpointState(
  record: GoalCheckpointStoredRecordV1,
  approval: BrowserGoalChatBinding['approval'],
): BrowserGoalChatSnapshot['state'] {
  if (approval) return 'awaiting_approval';
  if (record.checkpoint.state === 'blocked') return 'paused';
  return 'active';
}

function exactRecord(
  binding: BrowserGoalChatBinding,
  record: GoalCheckpointStoredRecordV1,
): void {
  if (
    record.accountId !== binding.record.accountId ||
    record.projectId !== binding.record.projectId ||
    record.manifestId !== binding.record.manifestId ||
    record.manifest.runId !== binding.record.manifest.runId ||
    record.manifest.repoRoot !== binding.record.manifest.repoRoot ||
    record.manifest.branch !== binding.record.manifest.branch ||
    record.manifest.headSha !== binding.record.manifest.headSha ||
    record.manifest.authorityVersion !== binding.record.manifest.authorityVersion
  ) {
    throw new Error('Browser goal checkpoint scope changed.');
  }
}

export function createBrowserGoalChatRuntime(input: {
  store?: BrowserGoalStore;
  readMode?: (chatId: string) => ReturnType<typeof readChatReasoningPreference>;
  handoffRuntime?: BrowserNativeHandoffRuntime;
} = {}): BrowserGoalChatRuntime {
  const store = input.store ?? browserGoalStore;
  const readMode = input.readMode ?? ((chatId) => readChatReasoningPreference(chatId));
  const handoffRuntime = input.handoffRuntime ?? browserNativeHandoffRuntime;
  const managed = new Map<string, Managed>();

  const publish = (
    current: Managed,
    patch: Partial<BrowserGoalChatSnapshot> = {},
  ): BrowserGoalChatSnapshot => {
    const { binding, record } = current;
    if (patch.state !== undefined) current.state = patch.state;
    if (patch.failureReason !== undefined) current.failureReason = patch.failureReason;
    const identity = binding.provider.identity;
    const completedActions =
      patch.completedActions ??
      binding.completedActions ??
      record.checkpoint.completedCriteriaIds.length;
    const totalActions =
      patch.totalActions ?? binding.totalActions ?? record.manifest.criteria.length;
    const snapshot: BrowserGoalChatSnapshot = {
      schemaVersion: 1,
      chatId: binding.chatId,
      goalId: record.manifestId,
      accountId: record.accountId,
      projectId: record.projectId,
      runId: record.manifest.runId,
      objective: record.manifest.objective,
      state: current.state,
      tokenMode: readMode(binding.chatId).mode,
      providerId: identity.providerId,
      modelId: identity.modelId,
      ...(identity.connectionId === undefined ? {} : { connectionId: identity.connectionId }),
      completedActions,
      totalActions,
      checkpointSequence: record.checkpoint.sequence,
      checkpointState: record.checkpoint.state,
      checkpointCreatedAt: record.checkpoint.createdAt,
      cursorExpiresAt: record.cursor.expiresAt,
      ...(binding.currentOrigin === undefined
        ? {}
        : { currentOrigin: safeOrigin(binding.currentOrigin) }),
      ...(binding.nextAction === undefined
        ? {}
        : { nextAction: boundedNextAction(binding.nextAction) }),
      ...(binding.approval === undefined ? {} : { approval: binding.approval }),
      evidenceRefs: record.checkpoint.evidenceRefs,
      providerArtifactRefs: current.providerArtifactRefs,
      ...(current.failureReason === undefined ? {} : { failureReason: current.failureReason }),
      ...patch,
    };
    store.publish(snapshot);
    return store.getSnapshot(binding.chatId)!;
  };

  const required = (chatId: string): Managed => {
    const current = managed.get(chatId);
    if (!current) throw new Error('Browser goal chat binding is unavailable.');
    return current;
  };

  const replaceRecord = (current: Managed, record: GoalCheckpointStoredRecordV1) => {
    exactRecord(current.binding, record);
    if (record.revision < current.record.revision) {
      throw new Error('Browser goal checkpoint cannot move backward.');
    }
    current.record = record;
    current.binding = Object.freeze({ ...current.binding, record });
  };

  const control = async (
    chatId: string,
    operation: 'pause' | 'cancel' | 'resume',
  ): Promise<BrowserGoalChatSnapshot> => {
    const current = required(chatId);
    if (current.busy) throw new Error('Browser goal control is already pending.');
    if (
      (operation === 'pause' && !['active', 'awaiting_approval'].includes(current.state)) ||
      (operation === 'resume' && !['paused', 'recovery_unavailable'].includes(current.state)) ||
      (operation === 'cancel' &&
        ['completed', 'cancelled', 'failed'].includes(current.state))
    ) {
      throw new Error('Browser goal control is unavailable in the current state.');
    }
    current.busy = true;
    try {
      if (operation === 'resume') {
        const validation = current.binding.repository.validateResume(
          current.record,
          current.binding.currentAuthority(),
        );
        if (!validation.ok) {
          return publish(current, {
            state: 'recovery_unavailable',
            failureReason: SAFE_FAILURE,
          });
        }
      }
      if (operation === 'cancel') {
        const record = await current.binding.controls.cancel(current.record);
        replaceRecord(current, record);
        current.failureReason = undefined;
        return publish(current, { state: 'cancelled' });
      }
      const record = await current.binding.controls[operation](current.record);
      replaceRecord(current, record);
      current.failureReason = undefined;
      return publish(current, { state: operation === 'pause' ? 'paused' : 'active' });
    } catch {
      return publish(current, {
        state: operation === 'resume' ? 'recovery_unavailable' : 'failed',
        failureReason:
          operation === 'resume'
            ? SAFE_FAILURE
            : 'Browser goal control failed before verified settlement.',
      });
    } finally {
      current.busy = false;
    }
  };

  const activate = (binding: BrowserGoalChatBinding): BrowserGoalChatSnapshot => {
    const existing = managed.get(binding.chatId);
    if (existing) {
      if (
        existing.record.manifestId === binding.record.manifestId &&
        existing.record.manifest.runId === binding.record.manifest.runId
      ) {
        return store.getSnapshot(binding.chatId)!;
      }
      if (!['completed', 'cancelled', 'failed'].includes(existing.state)) {
        throw new Error('Browser goal chat is already active.');
      }
      managed.delete(binding.chatId);
      store.remove(binding.chatId);
    }
    exactRecord(binding, binding.record);
    const validation = binding.repository.validateResume(
      binding.record,
      binding.currentAuthority(),
    );
    const current: Managed = {
      binding: Object.freeze({
        ...binding,
        currentOrigin: safeOrigin(binding.currentOrigin),
        nextAction: boundedNextAction(binding.nextAction),
      }),
      record: binding.record,
      providerArtifactRefs: [],
      state: validation.ok
        ? (binding.initialState ?? checkpointState(binding.record, binding.approval))
        : 'recovery_unavailable',
      ...(validation.ok ? {} : { failureReason: SAFE_FAILURE }),
      busy: false,
    };
    managed.set(binding.chatId, current);
    return validation.ok
      ? publish(current)
      : publish(current, { state: 'recovery_unavailable', failureReason: SAFE_FAILURE });
  };

  return Object.freeze<BrowserGoalChatRuntime>({
    activate,
    async acceptProviderEvent(chatId, payload, observedAt) {
      const current = required(chatId);
      const result = await current.binding.goalRuntime.acceptProviderEvent(payload, observedAt);
      if (result.event.payload.kind === 'structured_output') {
        current.providerArtifactRefs = [
          ...new Set([
            ...current.providerArtifactRefs,
            result.event.payload.resultRef,
          ]),
        ].slice(-128);
      }
      // Provider/browser text is deliberately not copied into authoritative status fields.
      return publish(current);
    },
    updateCheckpoint(update) {
      const current = required(update.chatId);
      replaceRecord(current, update.record);
      current.binding = Object.freeze({
        ...current.binding,
        record: update.record,
        ...(update.completedActions === undefined
          ? {}
          : { completedActions: update.completedActions }),
        ...(update.totalActions === undefined ? {} : { totalActions: update.totalActions }),
        ...(update.currentOrigin === undefined
          ? {}
          : { currentOrigin: safeOrigin(update.currentOrigin) }),
        ...(update.nextAction === undefined
          ? update.clearNextAction
            ? { nextAction: undefined }
            : {}
          : { nextAction: boundedNextAction(update.nextAction) }),
        approval: update.approval,
      });
      const completion =
        update.evidence === undefined
          ? undefined
          : current.binding.goalRuntime.verifyCompletion({
              record: update.record,
              evidence: update.evidence,
            });
      const nextState = completion?.ok
        ? 'completed'
        : checkpointState(update.record, update.approval);
      current.failureReason = undefined;
      return publish(current, { state: nextState });
    },
    fail(update) {
      const current = required(update.chatId);
      replaceRecord(current, update.record);
      if (
        !update.reason ||
        update.reason.length > 500 ||
        /[\u0000-\u001f\u007f]/u.test(update.reason)
      ) {
        throw new Error('Invalid browser goal failure reason.');
      }
      current.failureReason = update.reason;
      return publish(current, { state: 'failed', failureReason: update.reason });
    },
    pause: (chatId) => control(chatId, 'pause'),
    cancel: (chatId) => control(chatId, 'cancel'),
    resume: (chatId) => control(chatId, 'resume'),
    async recover(binding) {
      const loaded = await binding.repository.loadScope(
        binding.record.accountId,
        binding.record.projectId,
      );
      const latest = loaded.records
        .filter(
          (record) =>
            record.manifestId === binding.record.manifestId &&
            record.manifest.runId === binding.record.manifest.runId,
        )
        .sort((left, right) => right.revision - left.revision)[0];
      const recovered = latest ? Object.freeze({ ...binding, record: latest }) : binding;
      return activate(recovered);
    },
    async issueNativeHandoff(chatId, request) {
      const current = required(chatId);
      const identity = current.binding.provider.identity;
      if (
        request.accountId !== current.record.accountId ||
        request.projectId !== current.record.projectId ||
        request.runId !== current.record.manifest.runId ||
        request.chatId !== chatId ||
        request.providerId !== identity.providerId ||
        request.modelId !== identity.modelId ||
        request.connectionId !== identity.connectionId ||
        request.browserOrigin !== current.binding.currentOrigin ||
        request.checkpointSequence !== current.record.checkpoint.sequence ||
        request.approvalId !== current.binding.handoffApproval?.approvalId ||
        request.reviewId !== current.binding.handoffApproval?.reviewId ||
        (current.binding.approval !== undefined &&
          request.reviewId !== current.binding.approval.reviewId)
      ) {
        throw new Error('Browser-native handoff scope does not match this chat checkpoint.');
      }
      return handoffRuntime.issue(request);
    },
    async acceptNativeHandoff(chatId, envelope, returned, observedAt) {
      const current = required(chatId);
      const identity = current.binding.provider.identity;
      if (
        envelope.accountId !== current.record.accountId ||
        envelope.projectId !== current.record.projectId ||
        envelope.runId !== current.record.manifest.runId ||
        envelope.chatId !== chatId ||
        envelope.providerId !== identity.providerId ||
        envelope.modelId !== identity.modelId ||
        envelope.connectionId !== identity.connectionId ||
        envelope.browserOrigin !== current.binding.currentOrigin ||
        envelope.checkpointSequence !== current.record.checkpoint.sequence
        || envelope.approvalId !== current.binding.handoffApproval?.approvalId
        || envelope.reviewId !== current.binding.handoffApproval?.reviewId
      ) {
        throw new Error('Browser-native handoff scope drifted from this chat checkpoint.');
      }
      const receipt = await handoffRuntime.accept(envelope, returned, observedAt);
      current.providerArtifactRefs = [
        ...new Set([...current.providerArtifactRefs, receipt.artifactRef]),
      ].slice(-128);
      return Object.freeze({ snapshot: publish(current), receipt });
    },
  });
}

export const browserGoalChatRuntime = createBrowserGoalChatRuntime();
