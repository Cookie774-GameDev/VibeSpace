import type { HarnessRuntimeState } from './types';

const RUNTIME_STATE_EVENT = 'vibespace://opencode-runtime-state';
const MAX_COPY_LENGTH = 512;
const DEFAULT_SERVER_STATUS_TIMEOUT_MS = 3_000;
const STATUS_PROBE_TIMED_OUT = Symbol('status-probe-timed-out');

export interface NativeRuntimeDetection {
  status: 'systemCompatible' | 'managedCompatible' | 'incompatible' | 'missing';
  source?: 'system' | 'managed';
  version?: string;
  reason?: string;
  executableId?: string;
  executablePath?: string;
  fingerprintSha256?: string;
}

export type NativeRuntimeEvent =
  | { kind: 'downloading'; progress: number }
  | { kind: 'verifying' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | {
      kind: 'ready';
      source: 'system' | 'managed';
      version: string;
      generation?: string;
    }
  | { kind: 'failed'; recoverable: boolean; message: string };

export interface OpenCodeServerConnection {
  version: string;
  source: 'system' | 'managed';
  generation: string;
}

export interface HarnessRuntimeNativeAdapter {
  available(): boolean;
  detect(): Promise<NativeRuntimeDetection>;
  install(): Promise<NativeRuntimeDetection>;
  cancel(): Promise<boolean>;
  ensureServer(executableId: string): Promise<OpenCodeServerConnection>;
  serverStatus(): Promise<OpenCodeServerConnection | null>;
  listen(listener: (event: NativeRuntimeEvent) => void): Promise<() => void>;
}

export interface HarnessRuntimeManager {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HarnessRuntimeState;
  getConnection(): OpenCodeServerConnection | undefined;
  refresh(): Promise<void>;
  download(): Promise<void>;
  repair(): Promise<void>;
  cancel(): Promise<void>;
}

type HarnessRuntimeManagerOptions = Readonly<{
  serverStatusTimeoutMs?: number;
}>;

function boundedStatusProbe<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof STATUS_PROBE_TIMED_OUT> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(STATUS_PROBE_TIMED_OUT);
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedCopy(value: unknown, fallback: string): string {
  const text =
    typeof value === 'string' ? value : value instanceof Error ? value.message : fallback;
  const normalized = text.replace(/\s+/g, ' ').trim() || fallback;
  return normalized.length <= MAX_COPY_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_COPY_LENGTH - 1)}…`;
}

function mapUnavailableDetection(detection: NativeRuntimeDetection): HarnessRuntimeState {
  if (detection.status === 'missing') {
    return { kind: 'download_required' };
  }
  return {
    kind: 'incompatible',
    reason: boundedCopy(detection.reason, 'OpenCode runtime is incompatible.'),
  };
}

function mapEvent(event: NativeRuntimeEvent): HarnessRuntimeState {
  switch (event.kind) {
    case 'downloading':
      return {
        kind: 'downloading',
        progress: Number.isFinite(event.progress) ? Math.min(1, Math.max(0, event.progress)) : 0,
      };
    case 'verifying':
      return { kind: 'verifying' };
    case 'installing':
      return { kind: 'installing' };
    case 'starting':
      return { kind: 'starting' };
    case 'ready':
      return { kind: 'starting' };
    case 'failed':
      return {
        kind: 'failed',
        recoverable: event.recoverable,
        message: boundedCopy(event.message, 'Harness installation failed.'),
      };
  }
}

const nativeAdapter: HarnessRuntimeNativeAdapter = {
  available: () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  async detect() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeRuntimeDetection>('opencode_runtime_detect');
  },
  async install() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<NativeRuntimeDetection>('opencode_runtime_install');
  },
  async cancel() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('opencode_runtime_install_cancel');
  },
  async ensureServer(executableId) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<OpenCodeServerConnection>('opencode_server_ensure', { executableId });
  },
  async serverStatus() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<OpenCodeServerConnection | null>('opencode_server_status');
  },
  async listen(listener) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<NativeRuntimeEvent>(RUNTIME_STATE_EVENT, ({ payload }) => {
      listener(payload);
    });
  },
};

export function createHarnessRuntimeManager(
  native: HarnessRuntimeNativeAdapter = nativeAdapter,
  options: HarnessRuntimeManagerOptions = {},
): HarnessRuntimeManager {
  const serverStatusTimeoutMs = Math.max(
    1,
    Math.floor(options.serverStatusTimeoutMs ?? DEFAULT_SERVER_STATUS_TIMEOUT_MS),
  );
  let snapshot: HarnessRuntimeState = { kind: 'checking' };
  const subscribers = new Set<() => void>();
  let unlisten: (() => void) | undefined;
  let activation = 0;
  let lifecycleActive = false;
  let teardownTicket = 0;
  let operationGeneration = 0;
  let eventGeneration = 0;
  let refreshFlight:
    | Readonly<{
        operation: number;
        promise: Promise<void>;
      }>
    | undefined;
  let downloadFlight:
    | Readonly<{
        activation: number | undefined;
        force: boolean;
        promise: Promise<void>;
      }>
    | undefined;
  let connection: OpenCodeServerConnection | undefined;

  const publish = (next: HarnessRuntimeState) => {
    snapshot = next;
    subscribers.forEach((subscriber) => subscriber());
  };

  const clearConnection = () => {
    connection = undefined;
  };

  const validatedConnection = (candidate: OpenCodeServerConnection): OpenCodeServerConnection => {
    if (
      !candidate.version.trim() ||
      !['system', 'managed'].includes(candidate.source) ||
      !/^opencode-server-[A-Za-z0-9_-]+$/.test(candidate.generation)
    ) {
      throw new Error('OpenCode server returned an invalid managed descriptor.');
    }
    return candidate;
  };

  const applyDetection = async (
    detection: NativeRuntimeDetection,
    current: () => boolean = () => true,
  ) => {
    if (!current()) return;
    if (detection.status !== 'systemCompatible' && detection.status !== 'managedCompatible') {
      clearConnection();
      publish(mapUnavailableDetection(detection));
      return;
    }
    if (!/^opencode-runtime-[a-f0-9]{24}$/.test(detection.executableId ?? '')) {
      throw new Error('Compatible OpenCode runtime has no trusted executable ID.');
    }
    clearConnection();
    publish({ kind: 'starting' });
    const ready = validatedConnection(await native.ensureServer(detection.executableId as string));
    if (!current()) return;
    connection = ready;
    publish({
      kind: 'ready',
      source: ready.source,
      version: boundedCopy(ready.version, 'unknown'),
    });
  };

  const lifecycleIsCurrent = (generation: number) =>
    lifecycleActive && generation === activation && subscribers.size > 0;

  const handleEvent = (event: NativeRuntimeEvent, generation: number) => {
    if (!lifecycleIsCurrent(generation)) return;
    const eventOperation = ++eventGeneration;
    if (event.kind === 'ready') {
      if (!event.generation) return;
      void boundedStatusProbe(native.serverStatus(), serverStatusTimeoutMs)
        .then((status) => {
          if (
            !lifecycleIsCurrent(generation) ||
            eventOperation !== eventGeneration ||
            status === STATUS_PROBE_TIMED_OUT ||
            !status ||
            status.generation !== event.generation
          ) {
            return;
          }
          const ready = validatedConnection(status);
          connection = ready;
          publish({
            kind: 'ready',
            source: ready.source,
            version: boundedCopy(ready.version, 'unknown'),
          });
        })
        .catch((error) => {
          if (!lifecycleIsCurrent(generation) || eventOperation !== eventGeneration) return;
          clearConnection();
          publish({
            kind: 'failed',
            recoverable: true,
            message: boundedCopy(error, 'OpenCode server status failed.'),
          });
        });
      return;
    }
    if (
      event.kind === 'starting' ||
      event.kind === 'failed' ||
      event.kind === 'downloading' ||
      event.kind === 'verifying' ||
      event.kind === 'installing'
    ) {
      clearConnection();
    }
    publish(mapEvent(event));
  };

  const refresh = (_lifecycleGeneration?: number): Promise<void> => {
    // Readiness belongs to the app, not whichever chat view currently subscribes.
    // Downloads/repairs still invalidate this flight through operationGeneration.
    if (
      refreshFlight &&
      refreshFlight.operation === operationGeneration
    ) {
      return refreshFlight.promise;
    }
    const operation = ++operationGeneration;
    const current = () => operation === operationGeneration;
    const promise = (async () => {
      if (!native.available()) {
        if (!current()) return;
        clearConnection();
        publish({ kind: 'ready', source: 'system', version: 'web-preview' });
        return;
      }
      if (!current()) return;
      const previous = snapshot.kind === 'ready' ? connection : undefined;
      try {
        const status = await boundedStatusProbe(native.serverStatus(), serverStatusTimeoutMs);
        if (!current()) return;
        if (status === STATUS_PROBE_TIMED_OUT) {
          // A wedged native status probe must not poison the manager's shared
          // refresh flight or erase a previously authenticated generation.
          // Live transport failures and supervisor events still fail closed.
          if (previous) return;
        } else if (status) {
          const ready = validatedConnection(status);
          const sameAsPrevious =
            previous &&
            ready.generation === previous.generation &&
            ready.source === previous.source &&
            ready.version === previous.version;
          if (!previous || sameAsPrevious) {
            connection = ready;
            if (!previous) {
              publish({
                kind: 'ready',
                source: ready.source,
                version: boundedCopy(ready.version, 'unknown'),
              });
            }
            return;
          }
        }
      } catch {
        if (!current()) return;
      }
      publish({ kind: 'checking' });
      try {
        const detection = await native.detect();
        if (!current()) return;
        await applyDetection(detection, current);
      } catch (error) {
        if (!current()) return;
        clearConnection();
        publish({
          kind: 'failed',
          recoverable: true,
          message: boundedCopy(error, 'Harness detection failed.'),
        });
      }
    })();
    const flight = Object.freeze({ operation, promise });
    refreshFlight = flight;
    const clearFlight = () => {
      if (refreshFlight === flight) refreshFlight = undefined;
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  };

  const installManaged = (force: boolean): Promise<void> => {
    if (!native.available()) return refresh();
    const operationActivation = subscribers.size > 0 ? activation : undefined;
    if (
      downloadFlight &&
      downloadFlight.activation === operationActivation &&
      (!force || downloadFlight.force)
    ) {
      return downloadFlight.promise;
    }
    const operation = ++operationGeneration;
    refreshFlight = undefined;
    const current = () =>
      operation === operationGeneration &&
      (operationActivation === undefined || lifecycleIsCurrent(operationActivation));
    const promise = (async () => {
      try {
        if (!force) {
          const existing = await native.detect();
          if (!current()) return;
          if (existing.status === 'systemCompatible' || existing.status === 'managedCompatible') {
            await applyDetection(existing, current);
            return;
          }
        }
        if (!current()) return;
        clearConnection();
        publish({ kind: 'downloading', progress: 0 });
        const installed = await native.install();
        if (!current()) return;
        await applyDetection(installed, current);
      } catch (error) {
        if (!current()) return;
        clearConnection();
        publish({
          kind: 'failed',
          recoverable: true,
          message: boundedCopy(error, 'Harness installation failed.'),
        });
      }
    })();
    const flight = Object.freeze({ activation: operationActivation, force, promise });
    downloadFlight = flight;
    const clearFlight = () => {
      if (downloadFlight === flight) downloadFlight = undefined;
    };
    void promise.then(clearFlight, clearFlight);
    return promise;
  };

  const activate = async (generation: number) => {
    if (!native.available()) {
      await refresh();
      return;
    }
    // Native event registration can be delayed by WebView/Tauri startup. It is
    // supplemental lifecycle telemetry, not a prerequisite for adopting the
    // supervisor's already health-gated private server connection. Resolve
    // readiness first so a slow event import can never gate Chat.
    if (snapshot.kind !== 'ready' || !connection) {
      await refresh(generation);
    }
    if (!lifecycleIsCurrent(generation)) return;
    try {
      const stop = await native.listen((event) => handleEvent(event, generation));
      if (!lifecycleIsCurrent(generation)) {
        stop();
        return;
      }
      unlisten = stop;
    } catch (error) {
      if (lifecycleIsCurrent(generation) && (snapshot.kind !== 'ready' || !connection)) {
        publish({
          kind: 'failed',
          recoverable: true,
          message: boundedCopy(error, 'Harness runtime events are unavailable.'),
        });
      }
    }
  };

  return {
    subscribe(listener) {
      subscribers.add(listener);
      teardownTicket += 1;
      if (subscribers.size === 1) {
        if (!lifecycleActive) {
          lifecycleActive = true;
          activation += 1;
          void activate(activation);
        }
      }
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) {
          const ticket = ++teardownTicket;
          queueMicrotask(() => {
            if (ticket !== teardownTicket || subscribers.size > 0) return;
            lifecycleActive = false;
            activation += 1;
            eventGeneration += 1;
            if (downloadFlight) {
              operationGeneration += 1;
              refreshFlight = undefined;
            }
            downloadFlight = undefined;
            unlisten?.();
            unlisten = undefined;
          });
        }
      };
    },
    getSnapshot: () => snapshot,
    getConnection: () => connection,
    refresh,
    download: () => installManaged(false),
    repair: () => installManaged(true),
    async cancel() {
      if (native.available()) {
        try {
          await native.cancel();
        } catch (error) {
          publish({
            kind: 'failed',
            recoverable: true,
            message: boundedCopy(error, 'Harness cancellation failed.'),
          });
        }
      }
    },
  };
}

export const harnessRuntimeManager = createHarnessRuntimeManager();
