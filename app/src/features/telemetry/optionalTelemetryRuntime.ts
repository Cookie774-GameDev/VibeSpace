import { getSupabaseClient } from '@/lib/supabase/client';
import { localIntelligenceTelemetryRuntime } from '@/lib/ai/intelligenceTelemetryRuntime';
import { appActivityLog } from '@/lib/diagnostics/appActivityLog';
import { getAccountTelemetryConsent } from './accountTelemetryConsent';
import { telemetryConsentStore, type TelemetryStorage } from './telemetryConsent';
import { telemetryWithdrawalQueue } from './telemetryWithdrawal';
import {
  createTelemetryExporter,
  optionalTelemetryEvent,
  optionalActivityEvent,
  type TelemetryBatch,
} from './telemetryExporter';
import { parseTelemetryBatch } from '../../../../supabase/functions/_shared/telemetrySchema';

const storage: TelemetryStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
};

export const optionalTelemetryExporter = createTelemetryExporter({
  storage,
  validate: (batch): batch is TelemetryBatch => {
    try {
      parseTelemetryBatch(batch);
      return true;
    } catch {
      return false;
    }
  },
  transport: async (accountId, batch, signal) => {
    const client = getSupabaseClient();
    if (!client) throw new Error('Cloud unavailable');
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const session = sessionData.session;
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (sessionError || session?.user.id !== accountId || !session.access_token)
      return { acceptedEventIds: [], retryable: false };
    // The server authenticates this captured token and stamps account identity.
    const { data, error } = await client.functions.invoke('telemetry-ingest', {
      method: 'POST',
      body: batch,
      signal,
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (error) {
      const status = error.context instanceof Response ? error.context.status : null;
      if (status === 401 || status === 403) return { acceptedEventIds: [], retryable: false };
      throw new Error('Telemetry unavailable');
    }
    if (
      !data ||
      !Array.isArray(data.acceptedEventIds) ||
      !data.acceptedEventIds.every((id: unknown) => typeof id === 'string')
    )
      throw new Error('Invalid telemetry receipt');
    return { acceptedEventIds: data.acceptedEventIds as string[] };
  },
});

/** Observes bounded local snapshots on a timer; never adds network/disk work to a chat/tool hot path. */
export function startOptionalTelemetryRuntime(accountId: string | null) {
  let disposed = false;
  let approval: boolean | null = null;
  let checking = false;
  let revision = 0;
  let previousAllowed = false;
  let seen = new WeakSet<object>(localIntelligenceTelemetryRuntime.snapshot().events);
  let activitySequence = appActivityLog.snapshot().sequence;
  const platform = /Win/i.test(navigator.platform)
    ? 'windows'
    : /Mac/i.test(navigator.platform)
      ? 'macos'
      : /Linux/i.test(navigator.platform)
        ? 'linux'
        : 'other';
  const appVersion = import.meta.env.VITE_APP_VERSION || '0.0.0';
  const synchronize = () => {
    const consent = telemetryConsentStore.getSnapshot();
    const pending = telemetryWithdrawalQueue
      .getSnapshot()
      .pending.some((row) => row.accountId === accountId);
    const locallyAllowed =
      !pending &&
      !consent.storageError &&
      consent.consent.productUsage &&
      consent.consent.diagnostics &&
      consent.consent.toolOutcomes;
    // Loading identity/enrollment is not a withdrawal. Keep the persisted
    // outbox untouched until the account is authorized, without collecting
    // or sending anything while that decision is pending.
    if (locallyAllowed && approval === null) return false;
    const allowed = !!accountId && approval === true && locallyAllowed;
    if (allowed !== previousAllowed) {
      seen = new WeakSet(localIntelligenceTelemetryRuntime.snapshot().events);
      activitySequence = appActivityLog.snapshot().sequence;
    }
    previousAllowed = allowed;
    optionalTelemetryExporter.configure(accountId, allowed);
    return allowed;
  };
  const collect = () => {
    if (disposed || !synchronize()) return;
    for (const source of localIntelligenceTelemetryRuntime.snapshot().events) {
      if (seen.has(source)) continue;
      seen.add(source);
      const event = optionalTelemetryEvent(source, { appVersion, platform });
      if (event) optionalTelemetryExporter.enqueue(event);
    }
    const activity = appActivityLog.snapshot(activitySequence);
    activitySequence = activity.sequence;
    for (const source of activity.events) {
      const event = optionalActivityEvent(source, { appVersion, platform });
      if (event) optionalTelemetryExporter.enqueue(event);
    }
    void optionalTelemetryExporter.flush();
  };
  const authorize = async () => {
    if (!accountId || checking || disposed) return;
    checking = true;
    const current = revision;
    try {
      const result = await getAccountTelemetryConsent(accountId);
      if (disposed || current !== revision) return;
      if (result.ok) approval = result.state.enabled && result.state.eligible;
      synchronize();
    } finally {
      checking = false;
      if (!disposed && current !== revision) void authorize();
    }
  };
  // Revocation is synchronous; enrolling again requires a fresh server response.
  const consentChanged = () => {
    revision += 1;
    approval = false;
    synchronize();
    void authorize();
  };
  const unsubConsent = telemetryConsentStore.subscribe(consentChanged);
  const unsubWithdrawal = telemetryWithdrawalQueue.subscribe(() => {
    synchronize();
  });
  synchronize();
  void authorize();
  const timer = window.setInterval(collect, 5_000);
  const policyTimer = window.setInterval(() => {
    void authorize();
  }, 60_000);
  window.addEventListener('online', authorize);
  window.addEventListener('vibespace:telemetry-consent-changed', authorize);
  return () => {
    disposed = true;
    revision += 1;
    unsubConsent();
    unsubWithdrawal();
    window.clearInterval(timer);
    window.clearInterval(policyTimer);
    window.removeEventListener('online', authorize);
    window.removeEventListener('vibespace:telemetry-consent-changed', authorize);
    if (accountId) optionalTelemetryExporter.configure(null, false);
  };
}
