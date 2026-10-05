import type { TelemetryStorage } from './telemetryConsent';
import type { IntelligenceTelemetryEvent } from '@/lib/ai/intelligenceTelemetry';
import type { AppActivityEvent } from '@/lib/diagnostics/appActivityLog';
import {
  TELEMETRY_METRIC_NAMES,
  TELEMETRY_EVENT_NAMES,
  type TelemetryEvent,
  type AppDiagnosticsEvent,
  type TelemetryBatch,
} from '../../../../supabase/functions/_shared/telemetrySchema';

export type OptionalTelemetryEvent = TelemetryEvent | AppDiagnosticsEvent;
export type { TelemetryBatch };
type Receipt = { acceptedEventIds: readonly string[]; retryable?: boolean };
type Transport = (
  accountId: string,
  batch: TelemetryBatch,
  signal: AbortSignal,
) => Promise<Receipt>;
const KEY = 'vibespace-optional-telemetry-outbox-v1';
const MAX_EVENTS = 256;
const MAX_AGE = 24 * 60 * 60 * 1_000;

/** A separate allowlist adapter: no local diagnostic identity or free-text attribute leaves the device. */
export function optionalTelemetryEvent(
  source: IntelligenceTelemetryEvent,
  environment: Pick<OptionalTelemetryEvent, 'appVersion' | 'platform'>,
): TelemetryEvent | null {
  if (
    !TELEMETRY_EVENT_NAMES.includes(source.kind) ||
    !Number.isSafeInteger(source.observedAt) ||
    source.observedAt < 0
  )
    return null;
  const metrics: TelemetryEvent['metrics'] = {};
  for (const key of TELEMETRY_METRIC_NAMES) {
    const value = source.metrics[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12)
      metrics[key] = value;
  }
  const result = source.attributes.resultState;
  const outcome =
    result === 'ok' || result === 'completed' || result === 'succeeded'
      ? 'ok'
      : result === 'error' || result === 'failed'
        ? 'error'
        : result === 'cancelled'
          ? 'cancelled'
          : 'unknown';
  return {
    eventId: crypto.randomUUID(),
    eventName: source.kind,
    schemaVersion: 1,
    occurredAt: source.observedAt,
    ...environment,
    metrics,
    outcome,
  };
}

/** Observe only fixed operation classes and terminal outcomes, never diagnostic data. */
export function optionalActivityEvent(
  source: AppActivityEvent,
  environment: Pick<OptionalTelemetryEvent, 'appVersion' | 'platform'>,
): TelemetryEvent | null {
  const outcome = ['completed', 'success', 'succeeded'].includes(source.phase)
    ? 'ok'
    : ['failed', 'error', 'timed_out'].includes(source.phase)
      ? 'error'
      : source.phase === 'cancelled'
        ? 'cancelled'
        : null;
  const known =
    source.kind === 'model.tool' ||
    source.kind === 'model' ||
    source.kind === 'context.internal-tool' ||
    source.kind.startsWith('model.prepare.');
  if (!known || !outcome) return null;
  const duration = source.durationMs;
  return {
    eventId: crypto.randomUUID(),
    eventName: source.kind === 'model.tool' ? 'tool_outcome' : 'diagnostic',
    schemaVersion: 1,
    occurredAt: source.observedAt,
    ...environment,
    outcome,
    metrics:
      typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 && duration <= 1e12
        ? { durationMs: duration }
        : {},
  };
}

/** Bounded background outbox. Revocation aborts transport and discards queued events synchronously. */
export function createTelemetryExporter(options: {
  storage: TelemetryStorage;
  transport: Transport;
  validate: (batch: unknown) => batch is TelemetryBatch;
  now?: () => number;
  random?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  let accountId: string | null = null;
  let enabled = false;
  let appDiagnosticsAllowed = false;
  let queue: OptionalTelemetryEvent[] = [];
  let loaded = false;
  let dropped = 0;
  let acknowledged = 0;
  let retries = 0;
  let retryAt = 0;
  let storageError = false;
  let controller: AbortController | null = null;
  let flight: Promise<void> | null = null;
  let generation = 0;
  let dirty = false;
  const listeners = new Set<() => void>();
  const authorizationRejections = new Set<(accountId: string) => void>();
  let snapshot = {
    enabled,
    queued: 0,
    dropped,
    acknowledged,
    retryAt,
    storageError,
    sending: false,
  };
  const publish = () => {
    snapshot = {
      enabled,
      queued: queue.length,
      dropped,
      acknowledged,
      retryAt,
      storageError,
      sending: !!controller,
    };
    listeners.forEach((listener) => listener());
  };
  const persist = () => {
    if (!dirty) return;
    try {
      if (enabled && accountId && queue.length)
        options.storage.setItem(KEY, JSON.stringify({ accountId, events: queue }));
      else options.storage.removeItem(KEY);
      storageError = false;
      dirty = false;
    } catch {
      storageError = true;
    }
  };
  const prune = () => {
    const filtered = queue.filter(
      (event) => event.occurredAt >= now() - MAX_AGE && event.occurredAt <= now() + 60_000,
    );
    if (filtered.length !== queue.length) {
      dropped += queue.length - filtered.length;
      queue = filtered;
      dirty = true;
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeAuthorizationRejections(listener: (accountId: string) => void) {
      authorizationRejections.add(listener);
      return () => {
        authorizationRejections.delete(listener);
      };
    },
    configure(nextAccount: string | null, allowed: boolean, allowAppDiagnostics = false) {
      const nextEnabled = !!nextAccount && allowed;
      const nextDiagnostics = nextEnabled && allowAppDiagnostics;
      if (
        accountId === nextAccount &&
        enabled === nextEnabled &&
        appDiagnosticsAllowed === nextDiagnostics &&
        loaded
      )
        return;
      const sameLegacyScope = accountId === nextAccount && enabled && nextEnabled;
      generation += 1;
      controller?.abort();
      controller = null;
      accountId = nextAccount;
      enabled = nextEnabled;
      appDiagnosticsAllowed = nextDiagnostics;
      // A diagnostics-only permission change must not discard unrelated v1 receipts.
      queue = sameLegacyScope ? queue.filter((event) => event.schemaVersion === 1) : [];
      retries = 0;
      retryAt = 0;
      if (!loaded && enabled) {
        try {
          const raw = options.storage.getItem(KEY);
          if (raw && raw.length <= 512_000) {
            const saved = JSON.parse(raw);
            if (saved.accountId === accountId && Array.isArray(saved.events)) {
              for (const event of saved.events.slice(-MAX_EVENTS)) {
                // v2 delivery is best-effort. Its in-memory consent lifetime cannot be
                // reconstructed from persisted aggregates, so restart recovery is v1-only.
                if (
                  event?.schemaVersion === 1 &&
                  options.validate({ batchId: crypto.randomUUID(), events: [event] })
                )
                  queue.push(event);
              }
            }
          }
        } catch {
          storageError = true;
        }
      }
      loaded = true;
      dirty = true;
      prune();
      persist();
      publish();
    },
    enqueue(event: OptionalTelemetryEvent) {
      if (
        !enabled ||
        (event.schemaVersion === 2 && !appDiagnosticsAllowed) ||
        !options.validate({ batchId: event.eventId, events: [event] })
      )
        return false;
      if (queue.some((existing) => existing.eventId === event.eventId)) return false;
      if (queue.length === MAX_EVENTS) {
        queue.shift();
        dropped += 1;
      }
      queue.push(structuredClone(event));
      dirty = true;
      // Persistence and subscriber notifications are deferred to the background flush.
      return true;
    },
    flush(): Promise<void> {
      if (flight) return flight;
      prune();
      persist();
      publish();
      if (!enabled || !accountId || !queue.length || now() < retryAt) return Promise.resolve();
      const currentAccount = accountId;
      const epoch = generation;
      const abort = new AbortController();
      controller = abort;
      const batch: TelemetryBatch = { batchId: crypto.randomUUID(), events: queue.slice(0, 32) };
      if (
        !options.validate(batch) ||
        new TextEncoder().encode(JSON.stringify(batch)).length > 65_536
      ) {
        dropped += batch.events.length;
        queue.splice(0, batch.events.length);
        dirty = true;
        persist();
        controller = null;
        publish();
        return Promise.resolve();
      }
      const timer = setTimeout(() => abort.abort(), 15_000);
      let onAbort: () => void = () => undefined;
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException('Telemetry cancelled', 'AbortError'));
        abort.signal.addEventListener('abort', onAbort, { once: true });
      });
      publish();
      flight = (async () => {
        try {
          const receipt = await Promise.race([
            options.transport(currentAccount, batch, abort.signal),
            cancelled,
          ]);
          if (epoch !== generation || abort.signal.aborted) return;
          const sent = new Set(batch.events.map((event) => event.eventId));
          const accepted = new Set(receipt.acceptedEventIds.filter((id) => sent.has(id)));
          acknowledged += accepted.size;
          queue = queue.filter((event) => !accepted.has(event.eventId));
          dirty = true;
          if (receipt.retryable === false) {
            enabled = false;
            queue = [];
            generation += 1;
            // A transport denial revokes the runtime's cached decision too. The
            // epoch check above prevents an old account flight from revoking a new one.
            for (const listener of authorizationRejections) {
              try {
                listener(currentAccount);
              } catch {
                /* observational notification */
              }
            }
          } else if (accepted.size < batch.events.length)
            throw new Error('Unacknowledged telemetry');
          retries = 0;
          retryAt = 0;
        } catch {
          if (epoch === generation && enabled) {
            retries = Math.min(8, retries + 1);
            retryAt =
              now() + Math.min(300_000, 1_000 * 2 ** retries) + Math.floor(random() * 1_000);
          }
        } finally {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', onAbort);
          if (controller === abort) controller = null;
          persist();
          publish();
        }
      })().finally(() => {
        flight = null;
      });
      return flight;
    },
  };
}
