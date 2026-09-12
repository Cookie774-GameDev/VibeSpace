import { describe, expect, it, vi } from 'vitest';
import {
  createHarnessRuntimeManager,
  type HarnessRuntimeNativeAdapter,
  type NativeRuntimeDetection,
  type NativeRuntimeEvent,
  type OpenCodeServerConnection,
} from './runtimeManager';

const readyDetection: NativeRuntimeDetection = {
  status: 'managedCompatible',
  source: 'managed',
  version: '1.18.16',
  executableId: 'opencode-runtime-0123456789abcdef01234567',
};

const readyConnection: OpenCodeServerConnection = {
  baseUrl: 'http://127.0.0.1:43123',
  username: 'vibespace',
  password: 'A'.repeat(64),
  version: '1.18.16',
  source: 'managed',
  generation: 'opencode-server-safe-generation',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, deny) => {
    resolve = accept;
    reject = deny;
  });
  return { promise, resolve, reject };
}

function adapter(
  overrides: Partial<HarnessRuntimeNativeAdapter> = {},
): HarnessRuntimeNativeAdapter & { emit(event: NativeRuntimeEvent): void } {
  let listener: ((event: NativeRuntimeEvent) => void) | undefined;
  return {
    available: () => true,
    detect: vi.fn().mockResolvedValue(readyDetection),
    install: vi.fn().mockResolvedValue(readyDetection),
    cancel: vi.fn().mockResolvedValue(true),
    ensureServer: vi.fn().mockResolvedValue(readyConnection),
    serverStatus: vi.fn().mockResolvedValue(readyConnection),
    listen: vi.fn(async (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    }),
    emit(event) {
      listener?.(event);
    },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('harness runtime manager', () => {
  it('detects lazily for the first subscriber and maps compatible native results', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);

    expect(native.detect).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({ kind: 'checking' });
    const unsubscribe = manager.subscribe(() => {});
    await settle();

    expect(native.listen).toHaveBeenCalledTimes(1);
    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledWith(readyDetection.executableId);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    unsubscribe();
  });

  it('shares one detect and ensure chain across concurrent refresh callers', async () => {
    const detection = deferred<NativeRuntimeDetection>();
    const native = adapter({ detect: vi.fn(() => detection.promise) });
    const manager = createHarnessRuntimeManager(native);

    const first = manager.refresh();
    const second = manager.refresh();
    expect(native.detect).toHaveBeenCalledTimes(1);

    detection.resolve(readyDetection);
    await Promise.all([first, second]);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
  });

  it('coalesces a StrictMode-style immediate unsubscribe and remount', async () => {
    const detection = deferred<NativeRuntimeDetection>();
    const native = adapter({ detect: vi.fn(() => detection.promise) });
    const manager = createHarnessRuntimeManager(native);

    const first = manager.subscribe(() => {});
    await settle();
    expect(native.detect).toHaveBeenCalledTimes(1);
    first();
    const second = manager.subscribe(() => {});
    await settle();
    expect(native.detect).toHaveBeenCalledTimes(1);

    detection.resolve(readyDetection);
    await settle();
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    second();
  });

  it('discards a pending detection after the last subscriber is truly gone', async () => {
    const detection = deferred<NativeRuntimeDetection>();
    const native = adapter({ detect: vi.fn(() => detection.promise) });
    const manager = createHarnessRuntimeManager(native);
    const notifications = vi.fn();

    const unsubscribe = manager.subscribe(notifications);
    await settle();
    unsubscribe();
    await settle();
    notifications.mockClear();
    detection.resolve(readyDetection);
    await settle();

    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getConnection()).toBeUndefined();
    expect(notifications).not.toHaveBeenCalled();
  });

  it('discards a pending ensure result after the last subscriber is gone', async () => {
    const server = deferred<OpenCodeServerConnection>();
    const native = adapter({ ensureServer: vi.fn(() => server.promise) });
    const manager = createHarnessRuntimeManager(native);
    const notifications = vi.fn();

    const unsubscribe = manager.subscribe(notifications);
    await settle();
    expect(manager.getSnapshot()).toEqual({ kind: 'starting' });
    unsubscribe();
    await settle();
    notifications.mockClear();
    server.resolve(readyConnection);
    await settle();

    expect(manager.getConnection()).toBeUndefined();
    expect(manager.getSnapshot()).toEqual({ kind: 'starting' });
    expect(notifications).not.toHaveBeenCalled();
  });

  it('reuses a validated ready connection when the runtime subscriber remounts', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);
    const first = manager.subscribe(() => {});
    await settle();
    expect(manager.getSnapshot().kind).toBe('ready');
    first();
    await settle();

    const second = manager.subscribe(() => {});
    await settle();
    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
    second();
  });

  it('discards a late ready-event server status after lifecycle teardown', async () => {
    const status = deferred<OpenCodeServerConnection | null>();
    const native = adapter({
      detect: vi.fn().mockResolvedValue({ status: 'missing' }),
      serverStatus: vi.fn(() => status.promise),
    });
    const manager = createHarnessRuntimeManager(native);
    const notifications = vi.fn();
    const unsubscribe = manager.subscribe(notifications);
    await settle();

    native.emit({
      kind: 'ready',
      source: 'managed',
      version: readyConnection.version,
      generation: readyConnection.generation,
    });
    expect(native.serverStatus).toHaveBeenCalledTimes(1);
    unsubscribe();
    await settle();
    notifications.mockClear();
    status.resolve(readyConnection);
    await settle();

    expect(manager.getConnection()).toBeUndefined();
    expect(manager.getSnapshot()).toEqual({ kind: 'download_required' });
    expect(notifications).not.toHaveBeenCalled();
  });

  it('stays starting until the authenticated native server is ready', async () => {
    const server = deferred<OpenCodeServerConnection>();
    const native = adapter({ ensureServer: vi.fn(() => server.promise) });
    const manager = createHarnessRuntimeManager(native);

    const refreshing = manager.refresh();
    await settle();
    expect(manager.getSnapshot()).toEqual({ kind: 'starting' });
    expect(manager.getConnection()).toBeUndefined();

    server.resolve(readyConnection);
    await refreshing;
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    expect(manager.getConnection()).toEqual(readyConnection);
  });

  it('maps missing, incompatible, and failed detection without exposing diagnostics', async () => {
    const missing = adapter({
      detect: vi.fn().mockResolvedValue({ status: 'missing' }),
    });
    const missingManager = createHarnessRuntimeManager(missing);
    await missingManager.refresh();
    expect(missingManager.getSnapshot()).toEqual({ kind: 'download_required' });
    expect(missingManager.getConnection()).toBeUndefined();

    const incompatible = adapter({
      detect: vi.fn().mockResolvedValue({
        status: 'incompatible',
        reason: ` Unsupported runtime ${'x'.repeat(1_000)} `,
        executablePath: 'C:\\private\\opencode.exe',
        fingerprintSha256: 'private-fingerprint',
      }),
    });
    const incompatibleManager = createHarnessRuntimeManager(incompatible);
    await incompatibleManager.refresh();
    const incompatibleState = incompatibleManager.getSnapshot();
    expect(incompatibleState.kind).toBe('incompatible');
    if (incompatibleState.kind === 'incompatible') {
      expect(incompatibleState.reason).toHaveLength(512);
      expect(incompatibleState.reason).toMatch(/^Unsupported runtime x+…$/);
      expect(incompatibleState.reason).not.toContain('C:\\private');
    }

    const failed = adapter({
      detect: vi.fn().mockRejectedValue(new Error(`native ${'y'.repeat(1_000)}`)),
    });
    const failedManager = createHarnessRuntimeManager(failed);
    await failedManager.refresh();
    const failedState = failedManager.getSnapshot();
    expect(failedState.kind).toBe('failed');
    if (failedState.kind === 'failed') {
      expect(failedState.recoverable).toBe(true);
      expect(failedState.message).toHaveLength(512);
      expect(failedState.message).toMatch(/^native y+…$/);
    }
  });

  it('clamps progress events and refreshes credentials for a server-ready generation', async () => {
    const native = adapter({
      detect: vi.fn().mockResolvedValue({ status: 'missing' }),
    });
    const manager = createHarnessRuntimeManager(native);
    const unsubscribe = manager.subscribe(() => {});
    await settle();

    native.emit({ kind: 'downloading', progress: 5 });
    expect(manager.getSnapshot()).toEqual({ kind: 'downloading', progress: 1 });
    native.emit({ kind: 'downloading', progress: Number.NaN });
    expect(manager.getSnapshot()).toEqual({ kind: 'downloading', progress: 0 });
    native.emit({ kind: 'verifying' });
    expect(manager.getSnapshot()).toEqual({ kind: 'verifying' });
    native.emit({ kind: 'installing' });
    expect(manager.getSnapshot()).toEqual({ kind: 'installing' });
    native.emit({ kind: 'ready', source: 'managed', version: '1.18.16' });
    expect(manager.getSnapshot()).toEqual({ kind: 'installing' });
    native.emit({ kind: 'starting' });
    expect(manager.getSnapshot()).toEqual({ kind: 'starting' });
    native.emit({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
      generation: readyConnection.generation,
    });
    await settle();
    expect(native.serverStatus).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    unsubscribe();
  });

  it('invokes explicit install and cancellation and refreshes from the install result', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);

    await manager.download();
    expect(native.install).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledWith(readyDetection.executableId);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    await manager.cancel();
    expect(native.cancel).toHaveBeenCalledTimes(1);
  });

  it('maps cancellation failures without an unhandled rejection', async () => {
    const native = adapter({
      cancel: vi.fn().mockRejectedValue(new Error('Cancellation unavailable.')),
    });
    const manager = createHarnessRuntimeManager(native);

    await expect(manager.cancel()).resolves.toBeUndefined();
    expect(manager.getSnapshot()).toEqual({
      kind: 'failed',
      recoverable: true,
      message: 'Cancellation unavailable.',
    });
  });

  it('keeps ephemeral server credentials out of the public snapshot', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);

    await manager.refresh();

    expect(manager.getConnection()).toEqual(readyConnection);
    expect(JSON.stringify(manager.getSnapshot())).not.toContain(readyConnection.password);
  });

  it('fails closed for a compatible detection without an opaque executable ID', async () => {
    const native = adapter({
      detect: vi.fn().mockResolvedValue({
        status: 'systemCompatible',
        source: 'system',
        version: '1.18.16',
      }),
    });
    const manager = createHarnessRuntimeManager(native);

    await manager.refresh();

    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getConnection()).toBeUndefined();
    expect(manager.getSnapshot()).toEqual({
      kind: 'failed',
      recoverable: true,
      message: 'Compatible OpenCode runtime has no trusted executable ID.',
    });
  });

  it('rejects non-loopback or malformed native server connections', async () => {
    for (const candidate of [
      { ...readyConnection, baseUrl: 'http://0.0.0.0:43123' },
      { ...readyConnection, baseUrl: 'https://127.0.0.1:43123' },
      { ...readyConnection, password: 'short' },
      { ...readyConnection, generation: '../unsafe' },
    ]) {
      const native = adapter({
        ensureServer: vi.fn().mockResolvedValue(candidate),
      });
      const manager = createHarnessRuntimeManager(native);

      await manager.refresh();

      expect(manager.getConnection()).toBeUndefined();
      expect(manager.getSnapshot()).toEqual({
        kind: 'failed',
        recoverable: true,
        message: 'OpenCode server returned an invalid private connection.',
      });
    }
  });

  it('preserves the native failed event and supports retry after install rejection', async () => {
    const first = deferred<NativeRuntimeDetection>();
    const native = adapter({ install: vi.fn(() => first.promise) });
    const manager = createHarnessRuntimeManager(native);

    const installing = manager.download();
    native.emit({
      kind: 'failed',
      recoverable: true,
      message: 'Integrity verification failed.',
    });
    first.reject(new Error('Integrity verification failed.'));
    await installing;
    expect(manager.getSnapshot()).toEqual({
      kind: 'failed',
      recoverable: true,
      message: 'Integrity verification failed.',
    });

    vi.mocked(native.install).mockResolvedValueOnce(readyDetection);
    await manager.download();
    expect(manager.getSnapshot().kind).toBe('ready');
  });

  it('unlistens after the last subscriber and reactivates for a later subscriber', async () => {
    const unlisten = vi.fn();
    const native = adapter({ listen: vi.fn(async () => unlisten) });
    const manager = createHarnessRuntimeManager(native);
    const first = manager.subscribe(() => {});
    const second = manager.subscribe(() => {});
    await settle();
    first();
    expect(unlisten).not.toHaveBeenCalled();
    second();
    await settle();
    expect(unlisten).toHaveBeenCalledTimes(1);

    const third = manager.subscribe(() => {});
    await settle();
    expect(native.listen).toHaveBeenCalledTimes(2);
    expect(native.detect).toHaveBeenCalledTimes(1);
    third();
  });

  it('falls back to a ready compatibility state outside Tauri', async () => {
    const native = adapter({ available: () => false });
    const manager = createHarnessRuntimeManager(native);
    const unsubscribe = manager.subscribe(() => {});
    await settle();

    expect(native.listen).not.toHaveBeenCalled();
    expect(native.detect).not.toHaveBeenCalled();
    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'system',
      version: 'web-preview',
    });
    unsubscribe();
  });
});
