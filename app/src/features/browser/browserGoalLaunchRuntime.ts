import type { ActionResult, RegisteredActionExecutionContext } from '@/lib/actions/types';
import type {
  JarvisIssuedActionExecution,
  JarvisRegisteredActionDispatchOutcome,
} from '@/lib/jarvis/approvalEngine';
import type { JarvisRegisteredActionDefinition } from '@/lib/jarvis/actions/catalog';
import type { JarvisRun } from '@/lib/jarvis/contracts';
import { createBrowserGoalRuntime } from '@/lib/jarvis/browserGoalRuntime';
import { createGoalManifest, type GoalCheckpointState } from '@/lib/jarvis/goalCheckpoint';
import {
  type GoalCheckpointRepository,
  type GoalCheckpointStoredRecordV1,
} from '@/lib/jarvis/goalCheckpointRepository';
import { getLiveGoalCheckpointRepository } from '@/lib/jarvis/goalCheckpointRuntime';
import { hashJarvisText } from '@/lib/jarvis/identity';
import type { NativeCapabilityBroker, NativeCapabilityOutcome } from '@/lib/jarvis/nativeCapabilityBroker';
import { createProviderGoalAdapter } from '@/lib/jarvis/providerGoalAdapter';
import type { CanonicalCriterionEvidenceV1 } from '@/lib/jarvis/truthfulCompletion';
import {
  browserGoalChatRuntime,
  type BrowserGoalChatRuntime,
} from './browserGoalChatRuntime';
import {
  browserNativeHandoffRuntime,
  type BrowserNativeHandoffEnvelope,
  type BrowserNativeHandoffRequest,
  type BrowserNativeHandoffReturn,
  type BrowserNativeHandoffReceipt,
  type BrowserNativeHandoffRuntime,
} from './browserNativeHandoff';
import { browserGoalStore, type BrowserGoalChatSnapshot, type BrowserGoalStore } from './browserGoalStore';

const OPERATIONS = new Set([
  'browser.readPage',
  'browser.navigate',
  'browser.click',
  'browser.type',
]);
const CRITERION_ID = 'canonical_browser_action_observed';
const AUTHORITY_TTL_MS = 15 * 60_000;
const SAFE_BLOCKED = 'Browser goal recovery requires a fresh reviewed action.';
const SAFE_FAILED = 'Browser goal checkpoint settlement failed after canonical action execution.';

export type CanonicalBrowserActionInput = Readonly<{
  registration: Readonly<JarvisRegisteredActionDefinition>;
  params: Readonly<Record<string, unknown>>;
  context: RegisteredActionExecutionContext;
  execution: JarvisIssuedActionExecution;
  run: Readonly<JarvisRun> | undefined;
}>;

type Session = {
  chatId: string;
  record: GoalCheckpointStoredRecordV1;
  repository: GoalCheckpointRepository;
  actionCount: number;
  execution: JarvisIssuedActionExecution;
};

type Prepared = Readonly<{
  session: Session;
  actionKey: string;
  mutationStartedAt: number;
  alreadySettled: boolean;
  uncertainRecovery: boolean;
  snapshot: BrowserGoalChatSnapshot;
}>;

export interface BrowserGoalLaunchRuntime {
  executeRegisteredAction(
    input: CanonicalBrowserActionInput,
    dispatch: () => Promise<JarvisRegisteredActionDispatchOutcome | null>,
  ): Promise<JarvisRegisteredActionDispatchOutcome | null>;
  issueNativeHandoff(
    action: CanonicalBrowserActionInput,
    request: BrowserNativeHandoffRequest,
  ): Promise<BrowserNativeHandoffEnvelope>;
  acceptNativeHandoff(
    action: CanonicalBrowserActionInput,
    envelope: BrowserNativeHandoffEnvelope,
    returned: BrowserNativeHandoffReturn,
    observedAt: number,
  ): Promise<BrowserNativeHandoffReceipt>;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableText(value: unknown, maximum = 2_000): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function exactRun(input: CanonicalBrowserActionInput): asserts input is CanonicalBrowserActionInput & {
  run: Readonly<JarvisRun> & { projectId: string; chatId: string };
} {
  if (
    !input.run ||
    !stableText(input.run.projectId) ||
    !stableText(input.run.chatId) ||
    input.run.accountId !== input.context.accountId ||
    input.run.id !== input.context.runId ||
    (input.context.chatId !== undefined && input.run.chatId !== input.context.chatId) ||
    input.execution.approval.runId !== input.context.runId ||
    input.execution.approval.requestId !== input.context.requestId ||
    input.execution.approval.attemptNumber !== input.context.attemptNumber
  ) {
    throw new Error('Canonical browser goal run scope is unavailable.');
  }
}

function reviewedScope(input: CanonicalBrowserActionInput): Readonly<{
  origin: string;
  tabId: string;
  reviewId: string;
  expectedEffect: string;
}> {
  const params = recordOf(input.params);
  if (
    !params ||
    !stableText(params.origin) ||
    !stableText(params.tabId) ||
    !stableText(params.reviewId) ||
    !stableText(params.expectedEffect, 500)
  ) {
    throw new Error('Canonical browser goal review scope is unavailable.');
  }
  let origin: string;
  try {
    origin = new URL(params.origin).origin;
  } catch {
    throw new Error('Canonical browser goal origin is invalid.');
  }
  if (origin !== params.origin) {
    throw new Error('Canonical browser goal origin is invalid.');
  }
  return Object.freeze({
    origin,
    tabId: params.tabId,
    reviewId: params.reviewId,
    expectedEffect: params.expectedEffect,
  });
}

function outcomeEvidence(
  result: ActionResult,
  operation: string,
): Readonly<{
  outcome: NativeCapabilityOutcome;
  currentUrl: string;
}> | null {
  if (!result.ok) return null;
  const data = recordOf(result.data);
  const outcome = recordOf(data?.outcome);
  const observation = recordOf(data?.observation);
  if (
    !outcome ||
    outcome.kind !== 'browser' ||
    outcome.operation !== operation ||
    !stableText(outcome.resultRef) ||
    !/^jresult_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(outcome.resultRef) ||
    !stableText(outcome.evidenceRef) ||
    !/^jlive_[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(outcome.evidenceRef) ||
    !observation ||
    !stableText(observation.url)
  ) {
    return null;
  }
  return Object.freeze({
    outcome: outcome as unknown as NativeCapabilityOutcome,
    currentUrl: observation.url,
  });
}

const evidenceOnlyBroker: NativeCapabilityBroker = Object.freeze({
  register() {
    throw new Error('Browser goal launch runtime cannot register native capabilities.');
  },
  inspect() {
    throw new Error('Browser goal launch runtime cannot inspect native capabilities.');
  },
  async execute() {
    throw new Error('Browser goal launch runtime cannot execute browser effects.');
  },
});

function actionIdempotencyKey(input: CanonicalBrowserActionInput, phase: 'prepare' | 'settled') {
  return `browser-goal:${input.context.approvalId}:${input.registration.id}:${phase}`;
}

function controlIdempotencyKey(record: GoalCheckpointStoredRecordV1, control: string): string {
  return `browser-goal:${record.manifest.runId}:${control}:${record.revision + 1}`;
}

async function appendState(input: {
  session: Session;
  state: GoalCheckpointState;
  idempotencyKey: string;
  now: number;
  completedCriteriaIds?: readonly string[];
  evidenceRefs?: readonly string[];
  finalMutationAt?: number;
}): Promise<GoalCheckpointStoredRecordV1> {
  const { session } = input;
  const issuedAt = Math.max(input.now, session.record.createdAt);
  if (issuedAt >= session.record.manifest.expiresAt) {
    throw new Error('Browser goal checkpoint authority expired.');
  }
  const appended = await session.repository.append({
    manifest: session.record.manifest,
    previous: session.record,
    expectedRevision: session.record.revision,
    idempotencyKey: input.idempotencyKey,
    state: input.state,
    completedCriteriaIds:
      input.completedCriteriaIds ?? session.record.checkpoint.completedCriteriaIds,
    evidenceRefs: input.evidenceRefs ?? session.record.checkpoint.evidenceRefs,
    finalMutationAt:
      input.finalMutationAt ?? session.record.checkpoint.finalMutationAt,
    createdAt: issuedAt,
    cursorIssuedAt: issuedAt,
    cursorExpiresAt: session.record.manifest.expiresAt,
  });
  if (appended.kind === 'conflict') {
    throw new Error('Browser goal checkpoint revision conflict.');
  }
  session.record = appended.record;
  return appended.record;
}

function safeFailure(error: string): JarvisRegisteredActionDispatchOutcome {
  return Object.freeze({
    kind: 'executor_returned' as const,
    result: Object.freeze({ ok: false as const, error }),
  });
}

export function createBrowserGoalLaunchRuntime(input: {
  repository?: GoalCheckpointRepository;
  chatRuntime?: BrowserGoalChatRuntime;
  store?: BrowserGoalStore;
  now?: () => number;
  hash?: (text: string) => Promise<string>;
  handoffRuntime?: BrowserNativeHandoffRuntime;
} = {}): BrowserGoalLaunchRuntime {
  const repository = input.repository ?? getLiveGoalCheckpointRepository();
  const chatRuntime = input.chatRuntime ?? browserGoalChatRuntime;
  const store = input.store ?? browserGoalStore;
  const now = input.now ?? Date.now;
  const hash = input.hash ?? hashJarvisText;
  const handoffRuntime = input.handoffRuntime ?? browserNativeHandoffRuntime;
  const sessions = new Map<string, Session>();

  const prepare = async (action: CanonicalBrowserActionInput): Promise<Prepared> => {
    exactRun(action);
    const scope = reviewedScope(action);
    const sessionKey = `${action.run.accountId}\u0000${action.run.id}`;
    const actionKey = actionIdempotencyKey(action, 'settled');
    const prepareKey = actionIdempotencyKey(action, 'prepare');
    const authorityHash = await hash(
      JSON.stringify([
        action.run.accountId,
        action.run.projectId,
        action.run.id,
        action.run.chatId,
        action.run.model.providerId,
        action.run.model.modelId,
        action.run.model.connectionId ?? '',
        scope.origin,
        scope.tabId,
      ]),
    );
    let session = sessions.get(sessionKey);
    let records: readonly GoalCheckpointStoredRecordV1[] = [];
    let newlyPrepared = false;
    if (!session) {
      const loaded = await repository.loadScope(action.run.accountId, action.run.projectId);
      const expectedManifestId = `browser-goal-${action.run.id}`;
      const expectedRepoRoot = `vibe-browser:${scope.origin}:${scope.tabId}`;
      const expectedBranch =
        `browser-goal/${action.run.model.providerId}/${action.run.model.modelId}`;
      records = loaded.records.filter(
        (record) =>
          record.manifestId === expectedManifestId &&
          record.manifest.runId === action.run.id &&
          record.manifest.headSha === authorityHash &&
          record.manifest.repoRoot === expectedRepoRoot &&
          record.manifest.branch === expectedBranch &&
          record.manifest.authorityVersion === 1,
      );
      const latest = [...records].sort((left, right) => right.revision - left.revision)[0];
      let record = latest;
      const at = now();
      if (!record) {
        const manifest = createGoalManifest({
          id: expectedManifestId,
          accountId: action.run.accountId,
          projectId: action.run.projectId,
          runId: action.run.id,
          repoRoot: expectedRepoRoot,
          branch: expectedBranch,
          headSha: authorityHash,
          objective: `Complete the reviewed browser action: ${scope.expectedEffect}`,
          criteria: [
            {
              id: CRITERION_ID,
              description: 'A canonical post-action browser observation was recorded.',
              mandatory: true,
            },
          ],
          ownership: {
            ownedPaths: [`vibe-browser:${scope.origin}:${scope.tabId}`],
            exclusions: ['raw-cdp', 'unreviewed-browser-mutation'],
          },
          authorityVersion: 1,
          issuedAt: at,
          expiresAt: at + AUTHORITY_TTL_MS,
        });
        const initial = await repository.append({
          manifest,
          previous: null,
          expectedRevision: 0,
          idempotencyKey: prepareKey,
          state: 'running',
          completedCriteriaIds: [],
          evidenceRefs: [],
          finalMutationAt: at,
          createdAt: at,
          cursorIssuedAt: at,
          cursorExpiresAt: manifest.expiresAt,
        });
        if (initial.kind === 'conflict') {
          throw new Error('Browser goal initial checkpoint conflicted.');
        }
        record = initial.record;
        records = [record];
        newlyPrepared = true;
      }
      session = {
        chatId: action.run.chatId,
        record,
        repository,
        actionCount: records.filter(({ idempotencyKey }) =>
          idempotencyKey.endsWith(':settled'),
        ).length,
        execution: action.execution,
      };
      sessions.set(sessionKey, session);
      const provider = createProviderGoalAdapter({
        providerId: action.run.model.providerId,
        modelId: action.run.model.modelId,
        ...(action.run.model.connectionId === undefined
          ? {}
          : { connectionId: action.run.model.connectionId }),
        requestId: action.context.requestId,
        startedAt: record.createdAt,
      });
      const goalRuntime = createBrowserGoalRuntime({
        repository,
        broker: evidenceOnlyBroker,
        provider,
      });
      const controls = {
        pause: async () =>
          appendState({
            session: session!,
            state: 'blocked',
            idempotencyKey: controlIdempotencyKey(session!.record, 'pause'),
            now: now(),
          }),
        cancel: async () => {
          await session!.execution.requestCancellation();
          return appendState({
            session: session!,
            state: 'blocked',
            idempotencyKey: controlIdempotencyKey(session!.record, 'cancel'),
            now: now(),
          });
        },
        resume: async () =>
          appendState({
            session: session!,
            state: 'running',
            idempotencyKey: controlIdempotencyKey(session!.record, 'resume'),
            now: now(),
          }),
      };
      const cancelled = record.idempotencyKey.includes(':cancel:');
      const failed = record.idempotencyKey.endsWith(':failed');
      const binding = {
        chatId: action.run.chatId,
        record,
        repository,
        goalRuntime,
        provider,
        currentAuthority: () => ({
          accountId: session!.record.accountId,
          projectId: session!.record.projectId,
          repoRoot: session!.record.manifest.repoRoot,
          branch: session!.record.manifest.branch,
          headSha: session!.record.manifest.headSha,
          authorityVersion: session!.record.manifest.authorityVersion,
          latestCheckpointSequence: session!.record.revision,
          now: now(),
        }),
        controls,
        handoffApproval: {
          approvalId: action.context.approvalId,
          reviewId: scope.reviewId,
        },
        completedActions: session.actionCount,
        totalActions: session.actionCount + 1,
        currentOrigin: scope.origin,
        nextAction: { kind: action.registration.id, summary: scope.expectedEffect },
        ...(cancelled
          ? { initialState: 'cancelled' as const }
          : failed
            ? { initialState: 'failed' as const }
            : {}),
      };
      const activated = chatRuntime.activate(binding);
      if (
        activated.state !== 'recovery_unavailable' &&
        record.checkpoint.state === 'ready_for_completion' &&
        record.idempotencyKey.endsWith(':settled') &&
        record.createdAt > record.checkpoint.finalMutationAt
      ) {
        const evidenceRef = record.checkpoint.evidenceRefs.find((reference) =>
          reference.startsWith('jlive_'),
        );
        if (evidenceRef) {
          chatRuntime.updateCheckpoint({
            chatId: action.run.chatId,
            record,
            evidence: [
              Object.freeze({
                schemaVersion: 1,
                criterionId: CRITERION_ID,
                status: 'satisfied',
                source: 'canonical',
                evidenceRef,
                observedAt: record.createdAt,
              }),
            ],
            completedActions: session.actionCount,
            totalActions: session.actionCount,
            currentOrigin: scope.origin,
            clearNextAction: true,
          });
        }
      }
    } else {
      if (session.record.manifest.headSha !== authorityHash) {
        throw new Error('Browser goal provider/model or browser scope changed.');
      }
      session.execution = action.execution;
      records = (await repository.loadScope(action.run.accountId, action.run.projectId)).records.filter(
        (record) => record.manifestId === session!.record.manifestId,
      );
    }
    const settled = records.some(({ idempotencyKey }) => idempotencyKey === actionKey);
    const existingPrepare = records.some(
      ({ idempotencyKey }) => idempotencyKey === prepareKey,
    );
    const snapshot = store.getSnapshot(action.run.chatId);
    if (!snapshot) throw new Error('Browser goal chat activation failed.');
    let mutationStartedAt = now();
    if (
      !settled &&
      !existingPrepare &&
      !newlyPrepared &&
      !['paused', 'cancelled', 'recovery_unavailable', 'failed'].includes(snapshot.state)
    ) {
      mutationStartedAt = Math.max(mutationStartedAt, session.record.createdAt);
      await appendState({
        session,
        state: 'running',
        idempotencyKey: prepareKey,
        now: mutationStartedAt,
        completedCriteriaIds: [],
        evidenceRefs: [],
        finalMutationAt: mutationStartedAt,
      });
      newlyPrepared = true;
    } else if (newlyPrepared) {
      mutationStartedAt = session.record.checkpoint.finalMutationAt;
    }
    const uncertain = !newlyPrepared && !settled && existingPrepare;
    return Object.freeze({
      session,
      actionKey,
      mutationStartedAt,
      alreadySettled: settled,
      uncertainRecovery: uncertain,
      snapshot,
    });
  };

  return Object.freeze<BrowserGoalLaunchRuntime>({
    async executeRegisteredAction(action, dispatch) {
      if (!OPERATIONS.has(action.registration.id)) return dispatch();
      let prepared: Prepared;
      try {
        prepared = await prepare(action);
      } catch {
        return safeFailure(SAFE_BLOCKED);
      }
      if (prepared.alreadySettled) {
        return Object.freeze({
          kind: 'executor_returned' as const,
          result: Object.freeze({
            ok: true as const,
            summary: 'Canonical browser action was already durably settled; no mutation repeated.',
            data: Object.freeze({
              recovered: true,
              evidenceRefs: prepared.session.record.checkpoint.evidenceRefs,
            }),
          }),
        });
      }
      if (
        prepared.uncertainRecovery ||
        ['paused', 'cancelled', 'recovery_unavailable', 'failed'].includes(
          prepared.snapshot.state,
        )
      ) {
        if (prepared.uncertainRecovery && prepared.snapshot.state === 'active') {
          chatRuntime.fail({
            chatId: prepared.session.chatId,
            record: prepared.session.record,
            reason: SAFE_BLOCKED,
          });
        }
        return safeFailure(SAFE_BLOCKED);
      }

      let outcome: JarvisRegisteredActionDispatchOutcome | null;
      try {
        outcome = await dispatch();
      } catch (error) {
        try {
          const failedRecord = await appendState({
            session: prepared.session,
            state: 'blocked',
            idempotencyKey: `${prepared.actionKey}:failed`,
            now: Math.max(now(), prepared.mutationStartedAt + 1),
          });
          chatRuntime.fail({
            chatId: prepared.session.chatId,
            record: failedRecord,
            reason: SAFE_FAILED,
          });
        } catch {
          // Preserve the action dispatcher's canonical failure.
        }
        throw error;
      }
      if (!outcome || outcome.kind !== 'executor_returned') return outcome;
      const observedAt = Math.max(now(), prepared.mutationStartedAt + 1);
      const evidence = outcomeEvidence(outcome.result, action.registration.id);
      if (!evidence) {
        try {
          const failedRecord = await appendState({
            session: prepared.session,
            state: 'blocked',
            idempotencyKey: `${prepared.actionKey}:failed`,
            now: observedAt,
          });
          chatRuntime.fail({
            chatId: prepared.session.chatId,
            record: failedRecord,
            reason: SAFE_FAILED,
          });
        } catch {
          // The canonical action outcome remains authoritative even if status settlement fails.
        }
        return outcome;
      }
      try {
        const record = await appendState({
          session: prepared.session,
          state: 'ready_for_completion',
          idempotencyKey: prepared.actionKey,
          now: observedAt,
          completedCriteriaIds: [CRITERION_ID],
          evidenceRefs: [evidence.outcome.resultRef, evidence.outcome.evidenceRef],
          finalMutationAt: prepared.mutationStartedAt,
        });
        prepared.session.actionCount += 1;
        const completionEvidence: CanonicalCriterionEvidenceV1[] = [
          Object.freeze({
            schemaVersion: 1,
            criterionId: CRITERION_ID,
            status: 'satisfied',
            source: 'canonical',
            evidenceRef: evidence.outcome.evidenceRef,
            observedAt,
          }),
        ];
        chatRuntime.updateCheckpoint({
          chatId: prepared.session.chatId,
          record,
          evidence: completionEvidence,
          completedActions: prepared.session.actionCount,
          totalActions: prepared.session.actionCount,
          currentOrigin: evidence.currentUrl,
          clearNextAction: true,
        });
      } catch {
        try {
          chatRuntime.fail({
            chatId: prepared.session.chatId,
            record: prepared.session.record,
            reason: SAFE_FAILED,
          });
        } catch {
          // Preserve the canonical action outcome and fail closed on future recovery.
        }
      }
      return outcome;
    },
    async issueNativeHandoff(action, request) {
      exactRun(action);
      const scope = reviewedScope(action);
      const session = sessions.get(`${action.run.accountId}\u0000${action.run.id}`);
      if (
        !session ||
        request.accountId !== action.run.accountId ||
        request.projectId !== action.run.projectId ||
        request.runId !== action.run.id ||
        request.chatId !== action.run.chatId ||
        request.providerId !== action.run.model.providerId ||
        request.modelId !== action.run.model.modelId ||
        request.connectionId !== action.run.model.connectionId ||
        request.browserOrigin !== scope.origin ||
        request.browserTabId !== scope.tabId ||
        request.approvalId !== action.context.approvalId ||
        request.reviewId !== scope.reviewId ||
        request.checkpointSequence !== session.record.checkpoint.sequence
      ) {
        throw new Error('Browser-native handoff scope does not match the reviewed launch.');
      }
      return handoffRuntime.issue(request);
    },
    async acceptNativeHandoff(action, envelope, returned, observedAt) {
      exactRun(action);
      const scope = reviewedScope(action);
      const session = sessions.get(`${action.run.accountId}\u0000${action.run.id}`);
      if (
        !session ||
        envelope.accountId !== action.run.accountId ||
        envelope.projectId !== action.run.projectId ||
        envelope.runId !== action.run.id ||
        envelope.chatId !== action.run.chatId ||
        envelope.providerId !== action.run.model.providerId ||
        envelope.modelId !== action.run.model.modelId ||
        envelope.connectionId !== action.run.model.connectionId ||
        envelope.browserOrigin !== scope.origin ||
        envelope.browserTabId !== scope.tabId ||
        envelope.approvalId !== action.context.approvalId ||
        envelope.reviewId !== scope.reviewId ||
        envelope.checkpointSequence !== session.record.checkpoint.sequence
      ) {
        throw new Error('Browser-native handoff scope drifted from the reviewed launch.');
      }
      return handoffRuntime.accept(envelope, returned, observedAt);
    },
  });
}

export const browserGoalLaunchRuntime = createBrowserGoalLaunchRuntime();
