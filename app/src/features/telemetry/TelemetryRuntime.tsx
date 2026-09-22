import { useEffect } from 'react';
import { useAuthStore } from '@/stores/auth';
import { telemetryWithdrawalQueue } from './telemetryWithdrawal';
import { telemetryConsentStore } from './telemetryConsent';
import { startOptionalTelemetryRuntime } from './optionalTelemetryRuntime';

/** Retry saved withdrawals after restart/reconnection without opening Settings. */
export function TelemetryRuntime() {
  const accountId = useAuthStore((state) => state.cloudSession?.user_id ?? null);
  useEffect(() => {
    if (
      telemetryWithdrawalQueue.getSnapshot().pending.some((entry) => entry.accountId === accountId)
    )
      telemetryConsentStore.revoke();
    const flush = () => {
      void telemetryWithdrawalQueue.flush(accountId);
    };
    flush();
    window.addEventListener('online', flush);
    const timer = window.setInterval(flush, 30_000);
    const stopExporter = startOptionalTelemetryRuntime(accountId);
    return () => {
      stopExporter();
      window.removeEventListener('online', flush);
      window.clearInterval(timer);
    };
  }, [accountId]);
  return null;
}
