import { describe, expect, it, vi } from 'vitest';
import {
  createCodexRuntimeManager,
  type CodexRuntimeNativeAdapter,
  type ManagedCodexRuntimeEvent,
} from './codexRuntimeManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function adapter(overrides: Partial<CodexRuntimeNativeAdapter> = {}): CodexRuntimeNativeAdapter {
  return {
    available: () => true,
    detect: vi.fn().mockResolvedValue({ status: 'missing' }),
    install: vi.fn().mockResolvedValue({
      status: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-0000000000000001',
    }),
    cancel: vi.fn().mockResolvedValue(true),
    listen: vi.fn().mockResolvedValue(() => {}),
    ...overrides,
  };
}

describe('Codex runtime manager', () => {
  it('shares detection across simultaneous startup requests', async () => {
    const pending = deferred<Awaited<ReturnType<CodexRuntimeNativeAdapter['detect']>>>();
    const native = adapter({ detect: vi.fn(() => pending.promise) });
    const manager = createCodexRuntimeManager(native);
    const first = manager.refresh();
    const second = manager.refresh();
    pending.resolve({ status: 'missing' });
    await Promise.all([first, second]);
    expect(native.detect).toHaveBeenCalledOnce();
  });

  it('keeps verified readiness visible while rechecking and still invalidates missing tools', async () => {
    const pending = deferred<Awaited<ReturnType<CodexRuntimeNativeAdapter['detect']>>>();
    const native = adapter();
    const manager = createCodexRuntimeManager(native);
    await manager.install();
    vi.mocked(native.detect).mockReturnValue(pending.promise);
    const refresh = manager.refresh();
    expect(manager.getSnapshot().kind).toBe('ready');
    pending.resolve({ status: 'missing' });
    await refresh;
    expect(manager.getSnapshot().kind).toBe('missing');
  });

  it('detects missing tools on activation without silently installing', async () => {
    const native = adapter();
    const manager = createCodexRuntimeManager(native);
    const stop = manager.subscribe(() => {});
    await manager.refresh();

    expect(manager.getSnapshot()).toEqual({ kind: 'missing' });
    expect(native.install).not.toHaveBeenCalled();
    stop();
  });

  it('runs only one explicit install and adopts the verified executable identity', async () => {
    const pending = deferred<Awaited<ReturnType<CodexRuntimeNativeAdapter['install']>>>();
    const native = adapter({ install: vi.fn(() => pending.promise) });
    const manager = createCodexRuntimeManager(native);

    const first = manager.install();
    const second = manager.install();
    expect(first).toBe(second);
    expect(native.install).toHaveBeenCalledOnce();
    pending.resolve({
      status: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-0000000000000002',
    });
    await first;

    expect(manager.getSnapshot()).toEqual({
      kind: 'ready',
      codexVersion: '0.151.0',
      openCodexVersion: '5.0.0',
      executableId: 'cli-executable-0000000000000002',
    });
  });

  it('bounds progress, supports cancellation, and contains stale lifecycle events', async () => {
    let listener: ((event: ManagedCodexRuntimeEvent) => void) | undefined;
    const native = adapter({
      listen: vi.fn(async (next) => {
        listener = next;
        return () => {};
      }),
    });
    const manager = createCodexRuntimeManager(native);
    const stop = manager.subscribe(() => {});
    await Promise.resolve();
    listener?.({ kind: 'installing', component: 'codex', progress: 7 });
    expect(manager.getSnapshot()).toEqual({
      kind: 'installing',
      component: 'codex',
      progress: 1,
    });
    await manager.cancel();
    expect(native.cancel).toHaveBeenCalledOnce();
    stop();
    await Promise.resolve();
    listener?.({ kind: 'failed', recoverable: true, message: 'stale failure' });
    expect(manager.getSnapshot()).not.toMatchObject({ message: 'stale failure' });
  });

  it('bounds native errors and recovers on an explicit retry', async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new Error(`private-${'x'.repeat(700)}`))
      .mockResolvedValueOnce({
        status: 'ready',
        codexVersion: '0.151.0',
        openCodexVersion: '5.0.0',
        executableId: 'cli-executable-0000000000000003',
      });
    const manager = createCodexRuntimeManager(adapter({ detect }));
    await manager.refresh();
    expect(manager.getSnapshot()).toMatchObject({ kind: 'failed', recoverable: true });
    expect(JSON.stringify(manager.getSnapshot()).length).toBeLessThan(620);
    await manager.refresh();
    expect(manager.getSnapshot()).toMatchObject({ kind: 'ready' });
  });
});
