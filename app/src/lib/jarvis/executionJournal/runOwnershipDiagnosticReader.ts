interface Observation {
  scope: Readonly<{ accountId: string; runId: string; workspaceId?: string; projectId?: string }>;
  consistency: 'changed_during_read' | 'non_atomic_observation'; settlementAuthority: false;
  latestAttempt: Readonly<{ requestId: string; attemptNumber: number }> | null;
  registry: Readonly<{ owners: readonly unknown[]; pendingCancellation: boolean; truncated: boolean }> | null;
  journal: Readonly<{ tailSeq: number | null; cancellationIntentSeqs: readonly number[] }>;
  approvals: readonly unknown[]; terminals: readonly unknown[]; queue: readonly unknown[];
  terminalRead: 'observed' | 'unavailable'; unknowns: readonly string[];
}
type Authority = Readonly<{ accountId: string; workspaceId: string; projectId: string; epoch: number }>;
export type RunDiagnosticProjection = Readonly<{
  accountId: string; runId: string; authorityEpoch: number;
  consistency: 'non_atomic_observation'; settlementAuthority: false;
  latestAttempt: Readonly<{ requestId: string; attemptNumber: number }> | null;
  ownerCount: number; terminalCount: number; queueCount: number;
  cancellationIntentCount: number; approvalCount: number; pendingCancellation: boolean | null;
  terminalRead: 'observed' | 'unavailable'; unknowns: readonly string[];
}>;
const RUN = /^jrun_[A-Za-z0-9_-]{1,195}$/u;
const same = (a: Authority, b: Authority | undefined) => b !== undefined &&
  a.accountId === b.accountId && a.workspaceId === b.workspaceId &&
  a.projectId === b.projectId && a.epoch === b.epoch;
/** Host-only: caller supplies a run ID, never account/root/authority. No writes. */
export function createRunOwnershipDiagnosticReader(deps: {
  currentAuthority(): Authority | undefined;
  inspect(input: Readonly<{ accountId: string; runId: string }>): Promise<Observation>;
}) {
  return async (input: Readonly<{ runId: string }>): Promise<RunDiagnosticProjection | undefined> => {
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'runId') || !RUN.test(input.runId)) return undefined;
    const current = deps.currentAuthority();
    if (!current || !Number.isSafeInteger(current.epoch) || current.epoch < 1) return undefined;
    const before = Object.freeze({ ...current });
    try {
      const result = await deps.inspect({ accountId: before.accountId, runId: input.runId });
      if (!same(before, deps.currentAuthority()) || result.scope.accountId !== before.accountId ||
          result.scope.runId !== input.runId || result.scope.workspaceId !== before.workspaceId ||
          result.scope.projectId !== before.projectId || result.consistency !== 'non_atomic_observation' ||
          result.settlementAuthority !== false) return undefined;
      // Scalar metadata only. Never expose owner IDs, commands, paths, approval payloads or tokens.
      return Object.freeze({ accountId: before.accountId, runId: input.runId, authorityEpoch: before.epoch,
        consistency: 'non_atomic_observation', settlementAuthority: false,
        latestAttempt: result.latestAttempt ? Object.freeze({ requestId: result.latestAttempt.requestId,
          attemptNumber: result.latestAttempt.attemptNumber }) : null,
        ownerCount: result.registry?.owners.length ?? 0, terminalCount: result.terminals.length,
        queueCount: result.queue.length, cancellationIntentCount: result.journal.cancellationIntentSeqs.length,
        approvalCount: result.approvals.length, pendingCancellation: result.registry?.pendingCancellation ?? null, terminalRead: result.terminalRead,
        unknowns: Object.freeze([...result.unknowns, ...(!result.registry ? ['registry_owner_unavailable'] : []), ...(result.registry?.truncated ? ['registry_owner_window_truncated'] : [])]) });
    } catch { return undefined; }
  };
}
