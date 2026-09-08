import type { JarvisApprovalV1, JarvisExecutionJournal } from '@/lib/jarvis/contracts/execution';
import type { JarvisApprovalRepository, JarvisEventRepository } from '@/lib/db/jarvisRepositories';
import {
  CAO_TARGET_LEASE_MAX_MS,
  createCaoTargetAuthority,
  type CaoTargetRegistry,
} from '../../lib/jarvis/executionJournal/caoTargetAuthority';
import {
  CAO_CONTROL_ACTIONS,
  type CaoControlAction,
  type CaoResolvedControlTarget,
} from './controlCommand';
import {
  createCaoControlRuntime,
  type CaoControlRecord,
  type CaoControlRuntimeDeps,
} from './controlRuntime';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTIONS = new Set<CaoControlAction>(CAO_CONTROL_ACTIONS);

export type CaoControlJournalRecordAdapter = CaoControlRuntimeDeps['store'];

export type CaoControlActionAdapter = Readonly<{
  execute(input: {
    record: CaoControlRecord;
    signal: AbortSignal;
  }): Promise<{ status: 'completed'; receiptId: string } | { status: 'failed' | 'cancelled' }>;
}>;

export type ProductionCaoControlRuntimeDependencies = Readonly<{
  /** Canonical Jarvis-journal projection with compare-and-save semantics. */
  records: CaoControlJournalRecordAdapter;
  journal: Pick<JarvisExecutionJournal, 'getRun' | 'appendEvent'>;
  events: Pick<JarvisEventRepository, 'listByRun'>;
  approvals: Pick<JarvisApprovalRepository, 'getById'>;
  requestApproval(record: CaoControlRecord, action: CaoControlAction): Promise<string>;
  registry: CaoTargetRegistry;
  actions: Partial<Record<CaoControlAction, CaoControlActionAdapter>>;
  cancelRun(runId: string): Promise<void>;
  verifyCompletedAction?: CaoControlRuntimeDeps['action']['verifyCompletion'];
  now(): number;
  newRunId(): string;
  newLeaseId(): string;
  leaseMs: number;
}>;

function compositionUnavailable(dependencies: ProductionCaoControlRuntimeDependencies): boolean {
  return (
    !dependencies ||
    typeof dependencies.records?.load !== 'function' ||
    typeof dependencies.records?.save !== 'function' ||
    typeof dependencies.journal?.getRun !== 'function' ||
    typeof dependencies.journal?.appendEvent !== 'function' ||
    typeof dependencies.events?.listByRun !== 'function' ||
    typeof dependencies.approvals?.getById !== 'function' ||
    typeof dependencies.requestApproval !== 'function' ||
    typeof dependencies.registry?.claimExact !== 'function' ||
    typeof dependencies.registry?.readExact !== 'function' ||
    typeof dependencies.registry?.releaseExact !== 'function' ||
    !dependencies.actions ||
    typeof dependencies.cancelRun !== 'function' ||
    typeof dependencies.now !== 'function' ||
    typeof dependencies.newRunId !== 'function' ||
    typeof dependencies.newLeaseId !== 'function' ||
    !Number.isSafeInteger(dependencies.leaseMs) ||
    dependencies.leaseMs <= 0 ||
    dependencies.leaseMs > CAO_TARGET_LEASE_MAX_MS
  );
}

function assertTargets(record: {
  command: { action: CaoControlAction; selectors: readonly { kind: string }[] };
  targets: readonly CaoResolvedControlTarget[];
}): void {
  if (!ACTIONS.has(record.command.action)) throw new Error('cao_control_action_invalid');
  if (
    record.targets.length === 0 ||
    record.targets.length > 32 ||
    record.command.selectors.length !== record.targets.length
  ) {
    throw new Error('cao_control_target_set_invalid');
  }
  const identities = new Set<string>();
  for (let index = 0; index < record.targets.length; index += 1) {
    const target = record.targets[index];
    const selector = record.command.selectors[index];
    if (
      !target ||
      !selector ||
      selector.kind !== target.kind ||
      (target.kind !== 'chat' && target.kind !== 'terminal') ||
      !SAFE_ID.test(target.targetId) ||
      !Number.isSafeInteger(target.revision) ||
      target.revision < 0
    ) {
      throw new Error('cao_control_target_set_invalid');
    }
    const identity = `${target.kind}\0${target.targetId}`;
    if (identities.has(identity)) throw new Error('cao_control_target_set_invalid');
    identities.add(identity);
  }
}

function assertLeaseTargets(
  observed: readonly CaoResolvedControlTarget[],
  expected: readonly CaoResolvedControlTarget[],
): void {
  if (
    observed.length !== expected.length ||
    observed.some((target, index) => {
      const wanted = expected[index];
      return (
        !wanted ||
        target.kind !== wanted.kind ||
        target.targetId !== wanted.targetId ||
        target.revision !== wanted.revision
      );
    })
  ) {
    throw new Error('cao_control_target_revision_stale');
  }
}

function approvalState(
  approval: JarvisApprovalV1 | undefined,
  record: CaoControlRecord,
  action: CaoControlAction,
) {
  if (
    !approval ||
    approval.runId !== record.runId ||
    approval.requestId !== record.requestId ||
    approval.actionId !== `cao.control.${action}` ||
    approval.actionVersion !== 1
  ) {
    throw new Error('cao_control_approval_invalid');
  }
  const state =
    approval.status === 'pending' ||
    approval.status === 'approved' ||
    approval.status === 'denied' ||
    approval.status === 'expired'
      ? approval.status
      : 'expired';
  return Object.freeze({ state, approvalId: approval.id });
}

export function createProductionCaoControlRuntime(
  dependencies: ProductionCaoControlRuntimeDependencies,
) {
  if (compositionUnavailable(dependencies)) throw new Error('cao_control_composition_unavailable');

  const targetAuthority = createCaoTargetAuthority({
    runs: dependencies.journal,
    journal: dependencies.journal,
    events: dependencies.events,
    registry: dependencies.registry,
    now: dependencies.now,
    newLeaseId: dependencies.newLeaseId,
  });
  const approvalRecords = new Map<string, CaoControlRecord>();

  const authority: NonNullable<CaoControlRuntimeDeps['authority']> = {
    async acquire(input) {
      const lease = await targetAuthority.acquire({
        accountId: input.scope.accountId,
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        runId: input.runId,
        selection: {
          mode: input.targets.length === 1 ? 'explicit_single' : 'explicit_set',
          targets: input.targets.map(({ kind, targetId }) => ({ kind, targetId })),
        },
        leaseMs: dependencies.leaseMs,
      });
      try {
        assertLeaseTargets(lease.targets, input.targets);
      } catch (error) {
        await targetAuthority
          .release({
            accountId: input.scope.accountId,
            workspaceId: input.scope.workspaceId,
            projectId: input.scope.projectId,
            runId: input.runId,
            leaseId: lease.leaseId,
          })
          .catch(() => undefined);
        throw error;
      }
      return { leaseId: lease.leaseId };
    },
    async verify(input) {
      const lease = await targetAuthority.verify({
        accountId: input.scope.accountId,
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        runId: input.runId,
        leaseId: input.leaseId,
      });
      assertLeaseTargets(lease.targets, input.targets);
    },
    release(input) {
      return targetAuthority.release({
        accountId: input.scope.accountId,
        workspaceId: input.scope.workspaceId,
        projectId: input.scope.projectId,
        runId: input.runId,
        leaseId: input.leaseId,
      });
    },
  };

  const runtime = createCaoControlRuntime({
    store: dependencies.records,
    approval: {
      async request({ record, action }) {
        const approvalId = await dependencies.requestApproval(structuredClone(record), action);
        if (!SAFE_ID.test(approvalId)) throw new Error('cao_control_approval_invalid');
        approvalRecords.set(approvalId, structuredClone(record));
        return approvalState(
          await dependencies.approvals.getById(record.accountId, approvalId),
          record,
          action,
        );
      },
      async read(approvalId) {
        const record = approvalRecords.get(approvalId);
        if (!record) throw new Error('cao_control_approval_invalid');
        return approvalState(
          await dependencies.approvals.getById(record.accountId, approvalId),
          record,
          record.command.action,
        );
      },
    },
    authority,
    action: {
      async execute(input) {
        const adapter = dependencies.actions[input.record.command.action];
        if (!adapter || typeof adapter.execute !== 'function') {
          throw new Error('cao_control_action_adapter_unavailable');
        }
        return adapter.execute({ record: structuredClone(input.record), signal: input.signal });
      },
      cancel: dependencies.cancelRun,
      verifyCompletion: dependencies.verifyCompletedAction,
    },
    now: dependencies.now,
    newRunId: dependencies.newRunId,
  });

  return Object.freeze({
    async run(input: Parameters<typeof runtime.run>[0]) {
      assertTargets(input);
      const adapter = dependencies.actions[input.command.action];
      if (!adapter || typeof adapter.execute !== 'function') {
        throw new Error('cao_control_action_adapter_unavailable');
      }
      const existing = await dependencies.records.load(input.requestId);
      if (existing?.approvalId) approvalRecords.set(existing.approvalId, structuredClone(existing));
      return runtime.run(input);
    },
    cancel: runtime.cancel,
  });
}
