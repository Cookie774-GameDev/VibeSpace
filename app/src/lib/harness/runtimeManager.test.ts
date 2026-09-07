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
    serverStatus: vi.fn().mockResolvedValue(null),
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
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('harness runtime manager', () => {
  it('becomes ready while native event-listener registration is still pending', async () => {
    const listenerRegistration = deferred<() => void>();
    const native = adapter({
      serverStatus: vi.fn().mockResolvedValue(readyConnection),
      listen: vi.fn(() => listenerRegistration.promise),
    });
    const manager = createHarnessRuntimeManager(native);

    const unsubscribe = manager.subscribe(() => undefined);
    await settle();

    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    expect(native.serverStatus).toHaveBeenCalledTimes(1);
    expect(native.detect).not.toHaveBeenCalled();

    unsubscribe();
    listenerRegistration.resolve(() => undefined);
  });

  it('adopts an already supervised server before slow install detection on a cold refresh', async () => {
    const native = adapter({
      serverStatus: vi.fn().mockResolvedValue(readyConnection),
    });
    const manager = createHarnessRuntimeManager(native);

    await manager.refresh();

    expect(native.serverStatus).toHaveBeenCalledTimes(1);
    expect(native.detect).not.toHaveBeenCalled();
    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getConnection()).toEqual(readyConnection);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
  });

  it('detects lazily for the first subscriber and maps compatible native results', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);

    expect(native.detect).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toEqual({ kind: 'checking' });
    const unsubscribe = manager.subscribe(() => {});
    await settle();
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
    await settle();
    expect(native.detect).toHaveBeenCalledTimes(1);

    detection.resolve(readyDetection);
    await Promise.all([first, second]);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
  });

  it('keeps an exact ready generation visible across a background refresh', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);
    await manager.refresh();
    vi.mocked(native.detect).mockClear();
    vi.mocked(native.ensureServer).mockClear();
    vi.mocked(native.serverStatus).mockClear();
    vi.mocked(native.serverStatus).mockResolvedValueOnce(readyConnection);
    const notifications = vi.fn();
    const unsubscribe = manager.subscribe(notifications);
    await settle();
    notifications.mockClear();

    await manager.refresh();

    expect(native.serverStatus).toHaveBeenCalledTimes(1);
    expect(native.detect).not.toHaveBeenCalled();
    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getConnection()).toEqual(readyConnection);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    expect(notifications).not.toHaveBeenCalled();
    unsubscribe();
  });

  it.each([
    ['missing', null],
    ['different generation', { ...readyConnection, generation: 'opencode-server-next-generation' }],
    ['different source', { ...readyConnection, source: 'system' as const }],
    ['different version', { ...readyConnection, version: '1.18.17' }],
  ])('falls back to fail-closed detection when ready status is %s', async (_label, status) => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);
    await manager.refresh();
    vi.mocked(native.detect).mockClear();
    vi.mocked(native.ensureServer).mockClear();
    vi.mocked(native.serverStatus).mockResolvedValueOnce(status);

    await manager.refresh();

    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
  });

  it('falls back to fail-closed detection when ready status cannot be read', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);
    await manager.refresh();
    vi.mocked(native.detect).mockClear();
    vi.mocked(native.ensureServer).mockClear();
    vi.mocked(native.serverStatus).mockRejectedValueOnce(new Error('status unavailable'));

    await manager.refresh();

    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
  });

  it('keeps an exact ready generation visible when a background status probe stalls', async () => {
    vi.useFakeTimers();
    const stalledStatus = deferred<OpenCodeServerConnection | null>();
    const native = adapter();
    const manager = createHarnessRuntimeManager(native, { serverStatusTimeoutMs: 25 });
    await manager.refresh();
    vi.mocked(native.detect).mockClear();
    vi.mocked(native.ensureServer).mockClear();
    vi.mocked(native.serverStatus).mockImplementationOnce(() => stalledStatus.promise);

    const refreshing = manager.refresh();
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    await refreshing;

    expect(native.detect).not.toHaveBeenCalled();
    expect(native.ensureServer).not.toHaveBeenCalled();
    expect(manager.getConnection()).toEqual(readyConnection);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    vi.useRealTimers();
  });

  it('falls back to trusted detection when the cold status probe stalls', async () => {
    vi.useFakeTimers();
    const stalledStatus = deferred<OpenCodeServerConnection | null>();
    const native = adapter({ serverStatus: vi.fn(() => stalledStatus.promise) });
    const manager = createHarnessRuntimeManager(native, { serverStatusTimeoutMs: 25 });

    const refreshing = manager.refresh();
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    await refreshing;

    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.ensureServer).toHaveBeenCalledWith(readyDetection.executableId);
    expect(manager.getConnection()).toEqual(readyConnection);
    vi.useRealTimers();
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

  it('keeps pending detection across navigation without notifying removed subscribers', async () => {
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

    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getConnection()).toEqual(readyConnection);
    expect(notifications).not.toHaveBeenCalled();
  });

  it('keeps a pending ensure result after the last subscriber is gone', async () => {
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

    expect(manager.getConnection()).toEqual(readyConnection);
    expect(manager.getSnapshot().kind).toBe('ready');
    expect(notifications).not.toHaveBeenCalled();
  });

  it('shares pending detection when another view subscribes after teardown', async () => {
    const detection = deferred<NativeRuntimeDetection>();
    const native = adapter({ detect: vi.fn(() => detection.promise) });
    const manager = createHarnessRuntimeManager(native);
    const first = manager.subscribe(() => {});
    await settle();
    first();
    await settle();
    const second = manager.subscribe(() => {});
    await settle();
    expect(native.detect).toHaveBeenCalledTimes(1);
    detection.resolve(readyDetection);
    await settle();
    expect(manager.getConnection()).toEqual(readyConnection);
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    second();
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
      serverStatus: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockImplementation(() => status.promise),
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
    expect(native.serverStatus).toHaveBeenCalledTimes(2);
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
      serverStatus: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(readyConnection),
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
    expect(native.serverStatus).toHaveBeenCalledTimes(2);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
    unsubscribe();
  });

  it('invokes explicit install and cancellation and refreshes from the install result', async () => {
    const native = adapter({
      detect: vi.fn().mockResolvedValue({ status: 'missing' }),
    });
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

  it('force-repairs an unhealthy harness even when detection would still report a compatible runtime', async () => {
    const native = adapter({
      serverStatus: vi.fn().mockRejectedValue(new Error('server unhealthy')),
      detect: vi.fn().mockResolvedValue(readyDetection),
      install: vi.fn().mockResolvedValue(readyDetection),
    });
    const manager = createHarnessRuntimeManager(native);

    await manager.repair();

    expect(native.install).toHaveBeenCalledOnce();
    expect(native.detect).not.toHaveBeenCalled();
    expect(native.ensureServer).toHaveBeenCalledWith(readyDetection.executableId);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'managed',
      version: '1.18.16',
    });
  });

  it('accepts an already compatible runtime on retry without downloading it again', async () => {
    const native = adapter({
      detect: vi.fn().mockResolvedValue({
        ...readyDetection,
        status: 'systemCompatible',
        source: 'system',
        version: '1.18.21',
      }),
      ensureServer: vi.fn().mockResolvedValue({
        ...readyConnection,
        source: 'system',
        version: '1.18.21',
      }),
    });
    const manager = createHarnessRuntimeManager(native);

    await manager.download();

    expect(native.detect).toHaveBeenCalledTimes(1);
    expect(native.install).not.toHaveBeenCalled();
    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      source: 'system',
      version: '1.18.21',
    });
  });

  it('shares one detection, download, and startup across concurrent retry callers', async () => {
    const detection = deferred<NativeRuntimeDetection>();
    const installation = deferred<NativeRuntimeDetection>();
    const native = adapter({
      detect: vi.fn(() => detection.promise),
      install: vi.fn(() => installation.promise),
    });
    const manager = createHarnessRuntimeManager(native);

    const first = manager.download();
    const second = manager.download();
    expect(first).toBe(second);
    expect(native.detect).toHaveBeenCalledTimes(1);

    detection.resolve({ status: 'missing' });
    await settle();
    expect(native.install).toHaveBeenCalledTimes(1);
    installation.resolve(readyDetection);
    await Promise.all([first, second]);

    expect(native.ensureServer).toHaveBeenCalledTimes(1);
    expect(manager.getSnapshot().kind).toBe('ready');
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

  it('exposes only the managed server descriptor to the renderer', async () => {
    const native = adapter();
    const manager = createHarnessRuntimeManager(native);

    await manager.refresh();

    expect(manager.getConnection()).toEqual(readyConnection);
    expect(JSON.stringify(manager.getConnection())).not.toMatch(
      /baseUrl|username|password|authorization/i,
    );
    expect(JSON.stringify(manager.getSnapshot())).not.toMatch(
      /baseUrl|username|password|authorization/i,
    );
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

  it('rejects malformed native server descriptors', async () => {
    for (const candidate of [
      { ...readyConnection, version: '' },
      { ...readyConnection, source: 'remote' },
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
        message: 'OpenCode server returned an invalid managed descriptor.',
      });
    }
  });

  it('preserves the native failed event and supports retry after install rejection', async () => {
    const first = deferred<NativeRuntimeDetection>();
    const native = adapter({
      detect: vi.fn().mockResolvedValue({ status: 'missing' }),
      install: vi.fn(() => first.promise),
    });
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
    await settle();
    first();
    expect(unlisten).not.toHaveBeenCalled();
    second();
    await settle();
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
