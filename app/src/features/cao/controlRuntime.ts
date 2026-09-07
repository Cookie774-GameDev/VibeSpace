import type {
  CaoControlAction,
  CaoControlCommand,
  CaoControlScope,
  CaoResolvedControlTarget,
} from './controlCommand';

export type CaoControlStatus =
  'queued' | 'awaiting_approval' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CaoControlRecord = CaoControlScope &
  Readonly<{
    schemaVersion: 1;
    revision: number;
    requestId: string;
    runId: string;
    command: CaoControlCommand;
    targets: readonly CaoResolvedControlTarget[];
    status: CaoControlStatus;
    approvalId?: string;
    leaseId?: string;
    receiptId?: string;
    errorCode?: string;
    updatedAt: number;
  }>;
export type CaoControlPublicReceipt = Readonly<{
  identity: 'Jarvis CAO';
  action: CaoControlAction;
  status: Extract<CaoControlStatus, 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'>;
  runId: string;
  requestId: string;
  targetIds: readonly string[];
  approvalId?: string;
  receiptId?: string;
  errorCode?: string;
}>;

type ApprovalState = Readonly<{
  state: 'pending' | 'approved' | 'denied' | 'expired';
  approvalId: string;
}>;
export type CaoControlRuntimeDeps = Readonly<{
  store: Readonly<{
    load(requestId: string): Promise<CaoControlRecord | undefined>;
    save(expectedRevision: number, record: CaoControlRecord): Promise<boolean>;
  }>;
  approval: Readonly<{
    request(input: { record: CaoControlRecord; action: CaoControlAction }): Promise<ApprovalState>;
    read(approvalId: string): Promise<ApprovalState>;
  }>;
  authority?: Readonly<{
    acquire(input: {
      scope: CaoControlScope;
      runId: string;
      targets: readonly CaoResolvedControlTarget[];
    }): Promise<{ leaseId: string }>;
    verify(input: {
      scope: CaoControlScope;
      runId: string;
      leaseId: string;
      targets: readonly CaoResolvedControlTarget[];
    }): Promise<void>;
    release(input: { scope: CaoControlScope; runId: string; leaseId: string }): Promise<void>;
  }>;
  action: Readonly<{
    execute(input: {
      record: CaoControlRecord;
      signal: AbortSignal;
    }): Promise<{ status: 'completed'; receiptId: string } | { status: 'failed' | 'cancelled' }>;
    cancel(runId: string): Promise<void>;
  }>;
  now(): number;
  newRunId(): string;
}>;

const MUTATING = new Set<CaoControlAction>(['restart', 'force-check']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function sameEnvelope(record: CaoControlRecord, input: RunInput): boolean {
  return (
    record.accountId === input.accountId &&
    record.workspaceId === input.workspaceId &&
    record.projectId === input.projectId &&
    JSON.stringify(record.command) === JSON.stringify(input.command) &&
    JSON.stringify(record.targets) === JSON.stringify(input.targets)
  );
}

function receipt(record: CaoControlRecord): CaoControlPublicReceipt {
  const status =
    record.status === 'completed' ||
    record.status === 'cancelled' ||
    record.status === 'awaiting_approval'
      ? record.status
      : 'failed';
  return Object.freeze({
    identity: 'Jarvis CAO',
    action: record.command.action,
    status,
    runId: record.runId,
    requestId: record.requestId,
    targetIds: Object.freeze(record.targets.map((target) => `${target.kind}:${target.targetId}`)),
    ...(record.approvalId ? { approvalId: record.approvalId } : {}),
    ...(record.receiptId ? { receiptId: record.receiptId } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  });
}

type RunInput = CaoControlScope &
  Readonly<{
    requestId: string;
    command: CaoControlCommand;
    targets: readonly CaoResolvedControlTarget[];
  }>;

export function createCaoControlRuntime(deps: CaoControlRuntimeDeps) {
  const controllers = new Map<string, AbortController>();
  async function save(
    record: CaoControlRecord,
    patch: Partial<CaoControlRecord>,
  ): Promise<CaoControlRecord> {
    const next = Object.freeze({
      ...record,
      ...patch,
      revision: record.revision + 1,
      updatedAt: deps.now(),
    }) as CaoControlRecord;
    if (!(await deps.store.save(record.revision, next)))
      throw new Error('cao_control_persistence_conflict');
    return next;
  }

  async function execute(record: CaoControlRecord): Promise<CaoControlPublicReceipt> {
    if (!deps.authority) throw new Error('cao_control_authority_unavailable');
    let active = record;
    if (!active.leaseId) {
      const lease = await deps.authority.acquire({
        scope: active,
        runId: active.runId,
        targets: active.targets,
      });
      active = await save(active, { status: 'running', leaseId: lease.leaseId });
    }
    await deps.authority.verify({
      scope: active,
      runId: active.runId,
      leaseId: active.leaseId!,
      targets: active.targets,
    });
    let result: Awaited<ReturnType<CaoControlRuntimeDeps['action']['execute']>>;
    const controller = new AbortController();
    controllers.set(active.runId, controller);
    try {
      result = await deps.action.execute({
        record: structuredClone(active),
        signal: controller.signal,
      });
    } catch {
      const current = await deps.store.load(active.requestId);
      if (current?.status === 'cancelled') return receipt(current);
      await deps.authority.release({ scope: active, runId: active.runId, leaseId: active.leaseId! }).catch(() => undefined);
      active = await save(active, {
        status: 'failed',
        errorCode: 'cao_control_action_unavailable',
      });
      return receipt(active);
    } finally {
      controllers.delete(active.runId);
    }
    const settled = await deps.store.load(active.requestId);
    if (settled?.status === 'cancelled') return receipt(settled);
    if (result.status === 'completed') {
      await deps.authority.verify({
        scope: active,
        runId: active.runId,
        leaseId: active.leaseId!,
        targets: active.targets,
      });
    }
    await deps.authority
      .release({ scope: active, runId: active.runId, leaseId: active.leaseId! })
      .catch(() => undefined);
    active = await save(
      active,
      result.status === 'completed'
        ? { status: 'completed', receiptId: result.receiptId }
        : {
            status: result.status,
            errorCode: result.status === 'failed' ? 'cao_control_action_failed' : undefined,
          },
    );
    return receipt(active);
  }

  return Object.freeze({
    async run(input: RunInput): Promise<CaoControlPublicReceipt> {
      if (!deps.authority) throw new Error('cao_control_authority_unavailable');
      if (!SAFE_ID.test(input.requestId) || input.targets.length === 0 || input.targets.length > 32)
        throw new Error('cao_control_input_invalid');
      let record = await deps.store.load(input.requestId);
      if (record && !sameEnvelope(record, input)) throw new Error('cao_control_request_conflict');
      if (!record) {
        record = Object.freeze({
          schemaVersion: 1,
          revision: 1,
          ...structuredClone(input),
          runId: deps.newRunId(),
          status: 'queued',
          updatedAt: deps.now(),
        });
        if (!(await deps.store.save(0, record))) {
          const concurrent = await deps.store.load(input.requestId);
          if (!concurrent || !sameEnvelope(concurrent, input))
            throw new Error('cao_control_request_conflict');
          record = concurrent;
        }
      }
      if (
        record.status === 'completed' ||
        record.status === 'failed' ||
        record.status === 'cancelled'
      )
        return receipt(record);
      if (record.status === 'running' && MUTATING.has(record.command.action)) {
        record = await save(record, {
          status: 'failed',
          errorCode: 'cao_control_recovery_required',
        });
        return receipt(record);
      }
      if (MUTATING.has(record.command.action)) {
        const approval = record.approvalId
          ? await deps.approval.read(record.approvalId)
          : await deps.approval.request({ record, action: record.command.action });
        if (!record.approvalId)
          record = await save(record, {
            status: 'awaiting_approval',
            approvalId: approval.approvalId,
          });
        if (approval.state === 'pending') return receipt(record);
        if (approval.state !== 'approved') {
          record = await save(record, {
            status: 'cancelled',
            errorCode: `cao_control_approval_${approval.state}`,
          });
          return receipt(record);
        }
      }
      return execute(record);
    },

    async cancel(input: CaoControlScope & { requestId: string }): Promise<CaoControlPublicReceipt> {
      const record = await deps.store.load(input.requestId);
      if (
        !record ||
        record.accountId !== input.accountId ||
        record.workspaceId !== input.workspaceId ||
        record.projectId !== input.projectId
      ) {
        return Object.freeze({
          identity: 'Jarvis CAO',
          action: 'cancel',
          status: 'failed',
          runId: 'unavailable',
          requestId: input.requestId,
          targetIds: Object.freeze([]),
          errorCode: 'cao_control_request_missing',
        });
      }
      if (
        record.status === 'completed' ||
        record.status === 'failed' ||
        record.status === 'cancelled'
      )
        return receipt(record);
      const cancelled = await save(record, { status: 'cancelled' });
      controllers.get(record.runId)?.abort();
      await deps.action.cancel(record.runId).catch(() => undefined);
      if (record.leaseId && deps.authority)
        await deps.authority
          .release({ scope: record, runId: record.runId, leaseId: record.leaseId })
          .catch(() => undefined);
      return receipt(cancelled);
    },
  });
}
