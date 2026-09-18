import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  appActivityLog,
  type AppActivityEvent,
  type createActivityRecorder,
} from './appActivityLog';
import {
  createActivityLogWriter,
  type DiagnosticBatch,
  type DiagnosticReceipt,
} from './activityLogPersistence';
import {
  deriveActivityDiagnosticClockCalibration,
  hasCompatibleActivityDiagnosticCapabilities,
  type ActivityDiagnosticCapabilities,
  type ActivityDiagnosticClockCalibration,
  type ActivityDiagnosticClockSample,
} from './activityDiagnosticContract';

type Recorder = ReturnType<typeof createActivityRecorder>;
type Writer = ReturnType<typeof createActivityLogWriter>;
type Stop = () => Promise<void>;
interface Options {
  recorder?: Recorder;
  write?: (batch: DiagnosticBatch) => Promise<DiagnosticReceipt>;
  capabilities?: () => Promise<ActivityDiagnosticCapabilities>;
  clockSample?: () => Promise<ActivityDiagnosticClockSample>;
  wallNow?: () => number;
  monotonicNow?: () => number;
  clockTimeoutMs?: number;
  isDesktop?: boolean;
  windowLabel?: string;
}
interface Entry {
  sequence: number;
  writer?: Writer;
  stop?: Stop;
  closing?: Promise<void>;
  schemaStatus?: 'checking' | 'ready' | 'mismatch' | 'unavailable';
  schemaError?: 'diagnostics_schema_mismatch' | 'diagnostics_capabilities_unavailable';
  clockStatus?: 'checking' | 'ready' | 'unavailable';
  clockSamples?: number;
  clockCalibration?: ActivityDiagnosticClockCalibration;
  calibrate?: () => Promise<void>;
  calibration?: Promise<void>;
}
interface Registry {
  entries: WeakMap<Recorder, Entry>;
  latest?: Entry;
}
// HMR and duplicate module URLs must not attach another recorder subscriber or
// replay already observed batches. Sequence means observed, not acknowledged;
// failed/ambiguous native writes remain explicit drops, never silent retries.
const registryKey = Symbol.for('vibespace.activityLogPersistence.v1');
const renderer = globalThis as typeof globalThis & { [registryKey]?: Registry };
const registry = (renderer[registryKey] ??= { entries: new WeakMap<Recorder, Entry>() });
const noOp: Stop = async () => undefined;
const DEFAULT_CLOCK_TIMEOUT_MS = 500;

async function clockSampleWithDeadline(
  read: () => Promise<ActivityDiagnosticClockSample>,
  timeoutMs: number,
): Promise<ActivityDiagnosticClockSample> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<ActivityDiagnosticClockSample>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('diagnostics_clock_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function startActivityLogPersistence(options: Options = {}): Stop {
  const desktop =
    options.isDesktop ?? (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window);
  if (!desktop) return noOp;
  let label: string;
  try {
    label = options.windowLabel ?? getCurrentWindow().label;
  } catch {
    return noOp;
  }
  if (label !== 'main') return noOp;

  const recorder = options.recorder ?? appActivityLog;
  let entry = registry.entries.get(recorder);
  if (entry?.stop) return entry.stop;
  if (!entry) {
    entry = { sequence: 0 };
    registry.entries.set(recorder, entry);
  }
  const current = entry;
  const previousClose = current.closing;
  current.schemaStatus = 'checking';
  current.schemaError = undefined;
  // Query native schema support eagerly. A stale native binary is visible before
  // the first model batch rather than discovered only after records are dropped.
  const readCapabilities = options.capabilities ?? (() =>
    invoke<ActivityDiagnosticCapabilities>('activity_diagnostics_capabilities'));
  let capabilityCheck: Promise<boolean>;
  try {
    capabilityCheck = readCapabilities()
      .then((capability) => {
        if (!hasCompatibleActivityDiagnosticCapabilities(capability)) {
          current.schemaStatus = 'mismatch';
          current.schemaError = 'diagnostics_schema_mismatch';
          return false;
        }
        current.schemaStatus = 'ready';
        current.schemaError = undefined;
        return true;
      })
      .catch(() => {
        current.schemaStatus = 'unavailable';
        current.schemaError = 'diagnostics_capabilities_unavailable';
        return false;
      });
  } catch {
    current.schemaStatus = 'unavailable';
    current.schemaError = 'diagnostics_capabilities_unavailable';
    capabilityCheck = Promise.resolve(false);
  }
  // Use the raw metadata-only command, not a traced invocation wrapper, to avoid
  // recursively recording the persistence of the recorder itself.
  const write =
    options.write ??
    ((batch: DiagnosticBatch) =>
      invoke<DiagnosticReceipt>('activity_diagnostics_append', { batch }));
  const writer = createActivityLogWriter(async (batch) => {
    // A hot replacement may subscribe immediately, but its writes wait for the
    // old bounded queue to drain; native rotation never sees overlapping writers.
    await previousClose;
    if (!(await capabilityCheck)) throw new Error(current.schemaError ?? 'diagnostics_schema_mismatch');
    return write(batch);
  });
  current.writer = writer;
  current.clockStatus = 'checking';
  current.clockSamples ??= 0;
  registry.latest = current;
  let stopped = false;
  const readClock = options.clockSample ?? (() =>
    invoke<ActivityDiagnosticClockSample>('activity_diagnostics_clock_sample'));
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const clockTimeoutMs = Math.min(
    5_000,
    Math.max(50, Math.trunc(options.clockTimeoutMs ?? DEFAULT_CLOCK_TIMEOUT_MS)),
  );

  const capture = (event: AppActivityEvent) => {
    if (event.sequence <= current.sequence) return;
    writer.noteSourceGap(event.sequence - current.sequence - 1);
    current.sequence = event.sequence;
    writer.enqueue(event);
  };
  const unsubscribe = recorder.subscribe(capture);
  const snapshot = recorder.snapshot(current.sequence);
  for (const event of snapshot.events) capture(event);
  // Also account for an empty/fully evicted source ring.
  if (snapshot.sequence > current.sequence) {
    writer.noteSourceGap(snapshot.sequence - current.sequence);
    current.sequence = snapshot.sequence;
  }

  const calibrate = async () => {
    if (stopped) return;
    if (!(await capabilityCheck)) {
      current.clockStatus = 'unavailable';
      return;
    }
    const rendererSentAt = wallNow();
    const rendererSentMonotonicMs = monotonicNow();
    let sample: ActivityDiagnosticClockSample;
    try {
      sample = await clockSampleWithDeadline(readClock, clockTimeoutMs);
    } catch {
      if (!stopped) current.clockStatus = 'unavailable';
      return;
    }
    const rendererReceivedAt = wallNow();
    const rendererReceivedMonotonicMs = monotonicNow();
    if (stopped) return;
    const calibration = deriveActivityDiagnosticClockCalibration(
      sample,
      rendererSentAt,
      rendererSentMonotonicMs,
      rendererReceivedAt,
      rendererReceivedMonotonicMs,
    );
    if (!calibration) {
      current.clockStatus = 'unavailable';
      recorder.record('diagnostics.clock', 'failed', { resultCode: 'clock_order_invalid' });
      return;
    }
    const clockSampleIndex = (current.clockSamples ?? 0) + 1;
    current.clockSamples = clockSampleIndex;
    current.clockCalibration = calibration;
    current.clockStatus = 'ready';
    recorder.record('diagnostics.clock', clockSampleIndex === 1 ? 'attached' : 'refreshed', {
      nativeProcessId: calibration.processId,
      nativeHandoffWallUs: calibration.nativeWallUs,
      nativeHandoffMonotonicUs: calibration.nativeMonotonicUs,
      rendererSentAt: calibration.rendererSentAt,
      rendererSentMonotonicMs: calibration.rendererSentMonotonicMs,
      rendererReceivedAt: calibration.rendererReceivedAt,
      rendererReceivedMonotonicMs: calibration.rendererReceivedMonotonicMs,
      clockRoundTripMs: calibration.roundTripMs,
      clockUncertaintyMs: calibration.uncertaintyMs,
    });
  };
  current.calibrate = calibrate;
  current.calibration = calibrate();

  let closing: Promise<void> | undefined;
  const stop: Stop = () => {
    if (stopped) return closing ?? Promise.resolve();
    stopped = true;
    unsubscribe();
    if (current.stop === stop) current.stop = undefined;
    closing = writer.close();
    current.closing = closing;
    return closing;
  };
  current.stop = stop;
  return stop;
}

export function getActivityLogPersistenceStatus() {
  const current = registry.latest;
  const writer = current?.writer?.status();
  return writer
    ? {
        ...writer,
        schemaStatus: current?.schemaStatus ?? 'checking',
        schemaError: current?.schemaError,
        clockStatus: current?.clockStatus ?? 'checking',
        clockSamples: current?.clockSamples ?? 0,
        clockCalibration: current?.clockCalibration,
      }
    : null;
}

export async function awaitActivityDiagnosticClockCalibration() {
  const current = registry.latest;
  await current?.calibration;
  return current?.clockCalibration ?? null;
}

export async function refreshActivityDiagnosticClockCalibration() {
  const current = registry.latest;
  if (!current?.calibrate) return null;
  current.clockStatus = 'checking';
  const calibration = current.calibrate();
  current.calibration = calibration;
  await calibration;
  return current.clockCalibration ?? null;
}
