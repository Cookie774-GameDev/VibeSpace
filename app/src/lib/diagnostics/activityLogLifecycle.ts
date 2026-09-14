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

type Recorder = ReturnType<typeof createActivityRecorder>;
type Writer = ReturnType<typeof createActivityLogWriter>;
type Stop = () => Promise<void>;
interface Options {
  recorder?: Recorder;
  write?: (batch: DiagnosticBatch) => Promise<DiagnosticReceipt>;
  isDesktop?: boolean;
  windowLabel?: string;
}
interface Entry {
  sequence: number;
  writer?: Writer;
  stop?: Stop;
  closing?: Promise<void>;
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
    return write(batch);
  });
  current.writer = writer;
  registry.latest = current;

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
  let stopped = false;
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
  return registry.latest?.writer?.status() ?? null;
}
