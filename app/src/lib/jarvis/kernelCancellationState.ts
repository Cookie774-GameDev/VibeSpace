import type { JarvisCancellationRequestResult } from '@/lib/jarvis/contracts/execution';

/** Delivery acknowledgement does not certify the persisted run's terminal status. */
export function mapKernelCancellationState(
  cancellation: JarvisCancellationRequestResult,
): 'delivered' | 'handoff_pending' | 'not_found' {
  if (cancellation.kind !== 'intent_committed') return 'not_found';
  switch (cancellation.aggregate.kind) {
    case 'queued_cancelled':
    case 'signal_delivered':
      return 'delivered';
    default:
      // An intent with no executor, rejected/failed delivery or pending handoff
      // must remain visibly unresolved; it grants no status-write authority.
      return 'handoff_pending';
  }
}
