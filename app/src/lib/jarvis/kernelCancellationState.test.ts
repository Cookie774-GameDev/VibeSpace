import { describe, expect, it } from 'vitest';
import type { JarvisCancellationAggregate, JarvisCancellationRequestResult } from '@/lib/jarvis/contracts/execution';
import { mapKernelCancellationState } from './kernelCancellationState';

function committed(aggregate: JarvisCancellationAggregate): JarvisCancellationRequestResult {
  return {
    kind: 'intent_committed', requestState: 'new', authorityState: 'current',
    cancellationRequestId: 'jcancel_owned', aggregate,
  };
}

describe('public kernel cancellation delivery state', () => {
  it.each<JarvisCancellationAggregate>([
    { kind: 'executor_missing' },
    { kind: 'unsupported', ownerIds: ['own'] },
    { kind: 'delivery_rejected', ownerIds: ['own'] },
    { kind: 'delivery_error', ownerIds: ['own'], safeErrorCategory: 'abort_owner_error' },
    { kind: 'delivery_pending', ownerIds: ['own'] },
    { kind: 'handoff_pending', ownerIds: ['own'] },
  ])('keeps $kind unresolved instead of reporting delivered', aggregate => {
    expect(mapKernelCancellationState(committed(aggregate))).toBe('handoff_pending');
  });

  it.each<JarvisCancellationAggregate>([
    { kind: 'queued_cancelled', ownerId: 'own', queueItemId: 'exact_queue_item' },
    { kind: 'signal_delivered', ownerIds: ['own'] },
  ])('retains real $kind delivery acknowledgement', aggregate => {
    expect(mapKernelCancellationState(committed(aggregate))).toBe('delivered');
  });

  it('preserves authority-revoked response and does not invent delivery', () => {
    expect(mapKernelCancellationState({ kind: 'authority_revoked_before_intent' })).toBe('not_found');
  });

  it('preserves existing already-terminal wire behavior', () => {
    expect(mapKernelCancellationState({ kind: 'already_terminal', terminalStatus: 'cancelled' })).toBe('not_found');
  });

  it('does not mutate the canonical cancellation result', () => {
    const result = committed({ kind: 'executor_missing' });
    Object.freeze(result.aggregate);
    Object.freeze(result);
    expect(mapKernelCancellationState(result)).toBe('handoff_pending');
    expect(result.aggregate.kind).toBe('executor_missing');
  });
});
