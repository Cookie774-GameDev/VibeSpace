import {
  APP_DIAGNOSTICS_FEATURES,
  type AppDiagnosticsEvent,
} from '../../../../supabase/functions/_shared/telemetrySchema';

export interface DiagnosticUiState {
  route: string;
  settingsOpen: boolean;
  paletteOpen: boolean;
  voiceModalOpen: boolean;
}
export interface AppDiagnosticsOptions {
  allowed: () => boolean;
  readUi: () => DiagnosticUiState;
  subscribeUi: (listener: () => void) => () => void;
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  isVisible: () => boolean;
  readHeap: () => { usedBytes: number; limitBytes: number } | null;
  now: () => number;
  monotonic: () => number;
  environment: Pick<AppDiagnosticsEvent, 'appVersion' | 'platform'>;
  emit: (event: AppDiagnosticsEvent) => boolean;
}

const FLUSH_MS = 60_000;
const SAMPLE_MS = 5_000;
const MAX_KEYS = 128;
const MAX_EMITTED_PER_FLUSH = 32;
const FEATURES = new Set<string>(APP_DIAGNOSTICS_FEATURES);
const isFeature = (value: string): value is AppDiagnosticsEvent['feature'] => FEATURES.has(value);
const OPERATIONS = new Map<string, AppDiagnosticsEvent['feature']>([
  ['terminal-command', 'terminal'],
  ['semantic-tool', 'tools'],
  ['harness', 'ade'],
]);
type Aggregate = Pick<
  AppDiagnosticsEvent,
  'eventName' | 'feature' | 'diagnostic' | 'outcome' | 'metrics'
>;

/** Content-free, bounded aggregates. The owner recreates this collector after any revocation. */
export function createAppDiagnosticsCollector(options: AppDiagnosticsOptions) {
  let disposed = false;
  let previous: DiagnosticUiState | null = null;
  let unsubscribe = () => {};
  let lastSample: number | null = null;
  let lastFlush: number | null = null;
  let lastHeap: number | null = null;
  const aggregates = new Map<string, Aggregate>();
  const clock = () => {
    try {
      const value = options.monotonic();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };
  const visible = () => {
    try {
      return options.isVisible();
    } catch {
      return false;
    }
  };
  const live = () => {
    if (disposed) return false;
    try {
      if (options.allowed()) return true;
    } catch {
      /* observation only */
    }
    dispose();
    return false;
  };
  const aggregate = (value: Aggregate): Aggregate | null => {
    const key = `${value.eventName}:${value.feature}:${value.diagnostic ?? ''}:${value.outcome}`;
    const existing = aggregates.get(key);
    if (existing) return existing;
    if (aggregates.size >= MAX_KEYS) return null;
    const row = { ...value, metrics: {} };
    aggregates.set(key, row);
    return row;
  };
  const count = (value: Omit<Aggregate, 'metrics'>, duration?: unknown) => {
    const row = aggregate({ ...value, metrics: {} });
    if (!row) return;
    row.metrics.count = Math.min(1_000, (row.metrics.count ?? 0) + 1);
    if (
      typeof duration === 'number' &&
      Number.isFinite(duration) &&
      duration >= 0 &&
      duration <= 86_400_000
    )
      row.metrics.durationMs = Math.min(
        86_400_000,
        (row.metrics.durationMs ?? 0) + Math.round(duration),
      );
  };
  const onUi = () => {
    if (!live() || !visible()) return;
    try {
      const current = options.readUi();
      const route = isFeature(current.route) ? current.route : '';
      if (previous) {
        if (route && route !== previous.route)
          count({
            eventName: 'feature_open',
            feature: route,
            outcome: 'ok',
          });
        for (const [key, feature] of [
          ['settingsOpen', 'settings'],
          ['paletteOpen', 'command-palette'],
          ['voiceModalOpen', 'voice'],
        ] as const)
          if (current[key] === true && previous[key] !== true)
            count({ eventName: 'feature_open', feature, outcome: 'ok' });
      }
      previous = {
        route,
        settingsOpen: current.settingsOpen === true,
        paletteOpen: current.paletteOpen === true,
        voiceModalOpen: current.voiceModalOpen === true,
      };
    } catch {
      /* a UI read failure cannot affect the product */
    }
  };
  const onError = () => {
    if (live() && visible())
      count({
        eventName: 'diagnostic',
        feature: 'app',
        diagnostic: 'renderer_error',
        outcome: 'error',
      });
  };
  const onRejection = () => {
    if (live() && visible())
      count({
        eventName: 'diagnostic',
        feature: 'app',
        diagnostic: 'unhandled_rejection',
        outcome: 'error',
      });
  };
  const onVisibility = () => {
    if (!live()) return;
    aggregates.clear();
    previous = null;
    lastSample = null;
    lastFlush = lastHeap = clock();
    if (visible()) onUi();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    aggregates.clear();
    previous = null;
    try {
      unsubscribe();
    } catch {
      /* observation only */
    }
    options.events.removeEventListener('error', onError);
    options.events.removeEventListener('unhandledrejection', onRejection);
    options.events.removeEventListener('visibilitychange', onVisibility);
  }
  if (live()) {
    lastSample = lastFlush = lastHeap = clock();
    onUi();
    try {
      unsubscribe = options.subscribeUi(onUi);
      options.events.addEventListener('error', onError);
      options.events.addEventListener('unhandledrejection', onRejection);
      options.events.addEventListener('visibilitychange', onVisibility);
    } catch {
      dispose();
    }
  }
  return {
    dispose,
    recordOperation(kind: string, phase: string, duration: unknown) {
      if (!live() || !visible()) return;
      const feature = OPERATIONS.get(kind);
      const outcome = ['completed', 'success', 'succeeded'].includes(phase)
        ? 'ok'
        : ['failed', 'error', 'timed_out'].includes(phase)
          ? 'error'
          : phase === 'cancelled'
            ? 'cancelled'
            : null;
      if (feature && outcome) count({ eventName: 'tool_outcome', feature, outcome }, duration);
    },
    sample() {
      if (!live() || !visible()) return;
      const at = clock();
      if (at === null) return;
      if (lastSample !== null && at < lastSample) {
        lastSample = lastFlush = lastHeap = at;
        return;
      }
      if (lastSample !== null && at - lastSample <= SAMPLE_MS + 60_000) {
        const row = aggregate({
          eventName: 'diagnostic',
          feature: 'app',
          diagnostic: 'event_loop_delay',
          outcome: 'ok',
          metrics: {},
        });
        if (row) {
          row.metrics.sampleCount = Math.min(60, (row.metrics.sampleCount ?? 0) + 1);
          row.metrics.eventLoopDelayMs = Math.max(
            row.metrics.eventLoopDelayMs ?? 0,
            Math.round(Math.max(0, at - lastSample - SAMPLE_MS)),
          );
        }
      }
      lastSample = at;
      if (lastHeap === null || at - lastHeap >= FLUSH_MS) {
        lastHeap = at;
        try {
          const heap = options.readHeap();
          if (
            heap &&
            Number.isFinite(heap.usedBytes) &&
            Number.isFinite(heap.limitBytes) &&
            heap.usedBytes >= 0 &&
            heap.limitBytes >= 1024 * 1024 &&
            heap.usedBytes <= heap.limitBytes
          ) {
            const used = Math.floor(heap.usedBytes / (1024 * 1024));
            const limit = Math.floor(heap.limitBytes / (1024 * 1024));
            if (limit <= 1_048_576) {
              const row = aggregate({
                eventName: 'diagnostic',
                feature: 'app',
                diagnostic: 'resource_sample',
                outcome: 'ok',
                metrics: {},
              });
              if (row) row.metrics = { sampleCount: 1, heapUsedMiB: used, heapLimitMiB: limit };
            }
          }
        } catch {
          /* unsupported measurements are omitted, never replaced with zero */
        }
      }
      if (lastFlush === null) {
        lastFlush = at;
        return;
      }
      if (at - lastFlush < FLUSH_MS) return;
      lastFlush = at;
      const ready = [...aggregates.values()].slice(0, MAX_EMITTED_PER_FLUSH);
      aggregates.clear();
      for (const row of ready) {
        if (!live()) break;
        try {
          const occurredAt = options.now();
          if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) continue;
          options.emit({
            ...row,
            metrics: { ...row.metrics },
            schemaVersion: 2,
            eventId: crypto.randomUUID(),
            occurredAt,
            appVersion: options.environment.appVersion,
            platform: options.environment.platform,
          });
        } catch {
          /* telemetry must never fail the observed action */
        }
      }
    },
  };
}
