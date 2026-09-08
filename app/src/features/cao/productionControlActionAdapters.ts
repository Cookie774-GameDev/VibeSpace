import type { CaoTargetRegistry } from '@/lib/jarvis/executionJournal/caoTargetAuthority';
import {
  CAO_CONTROL_ACTIONS,
  type CaoControlAction,
  type CaoResolvedControlTarget,
} from './controlCommand';
import type { CaoControlRecord } from './controlRuntime';
import type { CaoControlActionAdapter } from './productionControlRuntime';

const SAFE_RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type CaoCanonicalActionCapability = Readonly<{
  execute(input: {
    record: CaoControlRecord;
    target: CaoResolvedControlTarget;
    signal: AbortSignal;
  }): Promise<{ status: 'completed'; receiptId: string } | { status: 'failed' | 'cancelled' }>;
}>;

export type CaoCanonicalActionCapabilities = Partial<
  Record<CaoControlAction, Partial<Record<'chat' | 'terminal', CaoCanonicalActionCapability>>>
>;

function unavailable(action: CaoControlAction, kind: CaoResolvedControlTarget['kind']): Error {
  return new Error(`cao_control_${action}_${kind}_unavailable`);
}

function exactAuthority(
  record: CaoControlRecord,
  observed: readonly {
    kind: string;
    targetId: string;
    accountId: string;
    workspaceId: string;
    projectId: string;
    revision: number;
    selected: boolean;
    locked: boolean;
    ownerLeaseId?: string;
  }[],
): boolean {
  return (
    observed.length === record.targets.length &&
    observed.every((target, index) => {
      const expected = record.targets[index];
      return (
        expected &&
        target.kind === expected.kind &&
        target.targetId === expected.targetId &&
        target.accountId === record.accountId &&
        target.workspaceId === record.workspaceId &&
        target.projectId === record.projectId &&
        target.revision === expected.revision &&
        target.selected === true &&
        target.locked === false &&
        target.ownerLeaseId === record.leaseId
      );
    })
  );
}

export function createProductionCaoControlActionAdapters(input: {
  registry: CaoTargetRegistry;
  capabilities: CaoCanonicalActionCapabilities;
}) {
  if (!input?.registry || typeof input.registry.readExact !== 'function' || !input.capabilities) {
    throw new Error('cao_control_action_composition_unavailable');
  }

  function assertAvailable(action: CaoControlAction, targets: readonly CaoResolvedControlTarget[]) {
    for (const target of targets) {
      const capability = input.capabilities[action]?.[target.kind];
      if (!capability || typeof capability.execute !== 'function')
        throw unavailable(action, target.kind);
    }
  }

  const actions = Object.fromEntries(
    CAO_CONTROL_ACTIONS.map((action) => {
      const adapter: CaoControlActionAdapter = {
        async execute({ record, signal }) {
          if (signal.aborted) return { status: 'cancelled' };
          if (!record.leaseId) return { status: 'failed' };
          try {
            assertAvailable(action, record.targets);
            const observed = await input.registry.readExact({
              accountId: record.accountId,
              workspaceId: record.workspaceId,
              projectId: record.projectId,
              runId: record.runId,
              leaseId: record.leaseId,
              targets: record.targets.map(({ kind, targetId }) => ({ kind, targetId })),
            });
            if (signal.aborted) return { status: 'cancelled' };
            if (!exactAuthority(record, observed)) return { status: 'failed' };

            const receipts: string[] = [];
            for (const target of record.targets) {
              if (signal.aborted) return { status: 'cancelled' };
              const capability = input.capabilities[action]![target.kind]!;
              const result = await capability.execute({
                record: structuredClone(record),
                target: structuredClone(target),
                signal,
              });
              if (result.status !== 'completed') return result;
              if (!SAFE_RECEIPT_ID.test(result.receiptId)) return { status: 'failed' };
              receipts.push(result.receiptId);
            }
            let receiptId = receipts.join('.');
            if (receiptId.length > 128) {
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(receipts)));
              receiptId = `cao_aggregate_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
            }
            return SAFE_RECEIPT_ID.test(receiptId)
              ? { status: 'completed', receiptId }
              : { status: 'failed' };
          } catch {
            return signal.aborted ? { status: 'cancelled' } : { status: 'failed' };
          }
        },
      };
      return [action, adapter] as const;
    }),
  ) as Record<CaoControlAction, CaoControlActionAdapter>;

  return Object.freeze({ actions: Object.freeze(actions), assertAvailable });
}
