import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { telemetryWithdrawalQueue } from './telemetryWithdrawal';
import { telemetryConsentStore } from './telemetryConsent';
import { startOptionalTelemetryRuntime } from './optionalTelemetryRuntime';

/** Retry saved withdrawals after restart/reconnection without opening Settings. */
export function TelemetryRuntime() {
  const accountId = useAuthStore((state) => state.cloudSession?.user_id ?? null);
  useEffect(() => {
    let disposed = false;
    let accountRevision = 0;
    // Observe transitions synchronously, including A -> B -> A changes React
    // can batch without remounting this effect.
    const unsubscribeAccount = useAuthStore.subscribe((next, previous) => {
      if (next.cloudSession?.user_id !== previous.cloudSession?.user_id) accountRevision += 1;
    });
    if (
      telemetryWithdrawalQueue.getSnapshot().pending.some((entry) => entry.accountId === accountId)
    )
      telemetryConsentStore.revoke();
    const flush = () => {
      const requestedRevision = accountRevision;
      void telemetryWithdrawalQueue.flush(
        accountId,
        () =>
          !disposed &&
          accountRevision === requestedRevision &&
          (useAuthStore.getState().cloudSession?.user_id ?? null) === accountId,
      );
    };
    flush();
    window.addEventListener('online', flush);
    const timer = window.setInterval(flush, 30_000);
    const stopExporter = startOptionalTelemetryRuntime(accountId);
    return () => {
      disposed = true;
      unsubscribeAccount();
      stopExporter();
      window.removeEventListener('online', flush);
      window.clearInterval(timer);
    };
  }, [accountId]);
  return null;
}
