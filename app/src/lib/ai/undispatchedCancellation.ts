import type { JarvisKernelTurnInput } from '@/lib/jarvis/kernel';
import type { JarvisKernelRuntime } from '@/lib/jarvis/kernelRuntime';

/** Finish an allocated turn stopped before an executor acquired ownership. */
export async function settleUndispatchedCancellation(
  host: Pick<JarvisKernelRuntime, 'requestCancellation' | 'runInitialTurn'>,
  turn: Readonly<JarvisKernelTurnInput>,
  signal: AbortSignal,
): Promise<void> {
  if (!signal.aborted) return;
  await host.requestCancellation({ accountId: turn.accountId, runId: turn.run.id });
  // The registry replays committed cancellation to the kernel's late abort
  // owner. Its account-bound lifecycle commits the terminal state before any
  // provider starts; a cancellation intent alone leaves this run queued.
  await host.runInitialTurn(turn);
  signal.throwIfAborted();
}
