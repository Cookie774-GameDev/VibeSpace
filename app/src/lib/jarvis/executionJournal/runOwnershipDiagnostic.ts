import { validateJarvisCanonicalResultEvidence, validateJarvisDurableLiveEvidence, validateJarvisProducerSourceEvidence } from '@/lib/jarvis/contracts/validators';
import type { JarvisEvent, JarvisTransportAttemptV1 } from '@/lib/jarvis/contracts/execution';
import type { JarvisRepositories } from '@/lib/db/jarvisRepositories';
import type { JarvisKernelAccountBinding } from '@/lib/jarvis/kernelRuntime';

export type ScopedOwnershipScope = Readonly<{ accountId: string; runId: string }>;
export type ScopedTerminalObservation = Readonly<{
  executionId: string; claimed: boolean; sessionBound: boolean;
  nativeActive: boolean | null; runtimeGeneration: string | null;
}>;
export interface RunOwnershipDiagnosticPorts {
  registry(scope: ScopedOwnershipScope): Readonly<{
    owners: readonly Readonly<{ id: string; kind: string }>[];
    pendingCancellation: boolean; truncated: boolean;
  }>;
  terminals(scope: ScopedOwnershipScope): Promise<readonly ScopedTerminalObservation[]>;
  queue(scope: ScopedOwnershipScope, executionIds: readonly string[]): readonly Readonly<{
    executionId: string; state: 'runnable' | 'claimed' | 'tombstone' | 'missing';
  }>[];
}


/** Correlate the advertised typed transport with actual validated bounded journal evidence. */
function requireCurrentAttemptProof(events: readonly JarvisEvent[], accountId: string, runId: string,
  attempt: JarvisTransportAttemptV1 | undefined): void {
  if (!attempt) return; // No typed metadata advertised; latestAttempt stays null/unknown.
  const proofs = events.flatMap(event => [
    validateJarvisCanonicalResultEvidence(event.canonicalResultEvidence),
    validateJarvisDurableLiveEvidence(event.liveEvidence),
    validateJarvisProducerSourceEvidence(event.producerSourceEvidence),
  ].flatMap(parsed => parsed.ok && parsed.value.accountId === accountId && parsed.value.runId === runId
    ? [{ requestId: parsed.value.requestId, attemptNumber: parsed.value.attemptNumber }] : []));
  const highest = Math.max(0, ...proofs.map(proof => proof.attemptNumber));
  const latest = proofs.filter(proof => proof.attemptNumber === highest);
  if (highest !== attempt.attemptNumber || latest.length === 0 ||
      new Set(latest.map(proof => proof.requestId)).size !== 1 || latest[0].requestId !== attempt.requestId)
    throw new Error('diagnostic_current_attempt_unverified');
}

/** @internal Construct only inside the real kernel; never a renderer/model/public bridge API. */
export function createRunOwnershipDiagnostic(input: {
  repositories: Pick<JarvisRepositories, 'run' | 'event' | 'approval'>;
  assertIssuedBinding(binding: JarvisKernelAccountBinding): void;
  ports?: RunOwnershipDiagnosticPorts;
}) {
  return Object.freeze({
    async inspect(binding: JarvisKernelAccountBinding, runId: string) {
      const current = () => {
        input.assertIssuedBinding(binding);
        binding.assertCurrent();
      };
      current();
      if (!/^jrun_[A-Za-z0-9_-]{1,195}$/.test(runId)) throw new Error('diagnostic_invalid_run');
      const accountId = binding.identity.accountId;
      const before = await input.repositories.run.getById(accountId, runId);
      current();
      if (!before || before.accountId !== accountId || before.id !== runId)
        throw new Error('diagnostic_run_scope_mismatch');
      const events = await input.repositories.event.listByRun(accountId, runId, { limit: 128 });
      current();
      requireCurrentAttemptProof(events, accountId, runId, before.transportAttempts?.at(-1));
      const approvals = await input.repositories.approval.listByRun(accountId, runId, { limit: 100 });
      current();
      if (events.some(event => event.runId !== runId) || approvals.some(row => row.runId !== runId))
        throw new Error('diagnostic_row_scope_mismatch');
      const scope = Object.freeze({ accountId, runId });
      const registry = input.ports?.registry(scope);
      let terminals: readonly ScopedTerminalObservation[] = [];
      let terminalRead = 'unavailable' as 'observed' | 'unavailable';
      if (input.ports) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          terminals = await Promise.race([
            input.ports.terminals(scope),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('diagnostic_native_read_timeout')), 8_000);
            }),
          ]);
          terminalRead = 'observed';
        } catch { /* no raw native error, command, path, token or private payload */ }
        finally { if (timer !== undefined) clearTimeout(timer); }
      }
      current();
      if (terminals.length > 100) throw new Error('diagnostic_terminal_bound');
      const executionIds = [...new Set(terminals.map(row => row.executionId))];
      const queue = input.ports?.queue(scope, executionIds) ?? [];
      current();
      if (queue.some(row => !executionIds.includes(row.executionId)))
        throw new Error('diagnostic_queue_scope_mismatch');
      const after = await input.repositories.run.getById(accountId, runId);
      const tail = await input.repositories.event.listByRun(accountId, runId, { limit: 128 });
      current();
      if (!after || after.accountId !== accountId || after.id !== runId)
        throw new Error('diagnostic_run_scope_mismatch');
      const attempt = before.transportAttempts?.at(-1);
      const latest = after.transportAttempts?.at(-1);
      requireCurrentAttemptProof(tail, accountId, runId, latest);
      const changed = before.updatedAt !== after.updatedAt || before.status !== after.status ||
        before.chatId !== after.chatId || before.workspaceId !== after.workspaceId ||
        before.projectId !== after.projectId || attempt?.requestId !== latest?.requestId ||
        attempt?.attemptNumber !== latest?.attemptNumber ||
        events.at(-1)?.seq !== tail.at(-1)?.seq;
      return Object.freeze({
        kind: 'canonical-run-ownership-diagnostic' as const,
        settlementAuthority: false as const,
        consistency: changed ? 'changed_during_read' as const : 'non_atomic_observation' as const,
        scope: { ...scope, chatId: before.chatId, workspaceId: before.workspaceId, projectId: before.projectId },
        status: before.status,
        latestAttempt: attempt ? {
          requestId: attempt.requestId, attemptNumber: attempt.attemptNumber,
          state: attempt.state, startedEventSeq: attempt.startedEventSeq,
        } : null,
        journal: {
          tailSeq: events.at(-1)?.seq ?? null,
          windowPossiblyTruncated: events.length >= 128,
          cancellationIntentSeqs: events.filter(row => row.status === 'cancellation_requested').map(row => row.seq),
          executionClaims: events.filter(row => row.executionEvidence).map(row => ({
            seq: row.seq, kind: row.executionEvidence!.kind,
            ownerKind: row.executionEvidence!.ownerKind, ownerId: row.executionEvidence!.ownerId,
            requestId: row.executionEvidence!.requestId, attemptNumber: row.executionEvidence!.attemptNumber,
          })),
        },
        approvals: approvals.map(row => ({
          id: row.id, actionId: row.actionId, status: row.status,
          requestId: row.requestId, attemptNumber: row.attemptNumber,
        })),
        approvalWindowPossiblyTruncated: approvals.length >= 100,
        messageProposalCoverage: 'unverified' as const,
        registry: registry ?? null, terminalRead, terminals, queue,
        unknowns: [
          'cross_webview_owner_fence_unavailable',
          'durable_owner_generation_correlation_unavailable',
          'full_message_proposal_join_unverified',
          ...(terminalRead === 'unavailable' ? ['native_terminal_read_unavailable'] : []),
          ...(executionIds.length === 0 ? ['historical_queue_execution_ids_unavailable'] : []),
          ...(events.length >= 128 ? ['journal_history_outside_window'] : []),
        ],
      });
    },
  });
}
