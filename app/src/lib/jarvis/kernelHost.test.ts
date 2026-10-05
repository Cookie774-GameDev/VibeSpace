import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KernelHostRequestEvent } from './kernelBridgeProtocol';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handler: undefined as ((event: { payload: KernelHostRequestEvent }) => void) | undefined,
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: tauri.listen.mockImplementation(async (_event, handler) => {
    tauri.handler = handler;
    return tauri.unlisten;
  }),
}));

import {
  requestLocalJarvisKernelHost,
  sanitizeKernelHostFailureCode,
  startJarvisKernelHost,
} from './kernelHost';

const request: KernelHostRequestEvent = {
  epoch: 7,
  requestId: 'kreq-7-1',
  request: {
    version: 1,
    kind: 'cancel',
    accountId: 'account-1',
    runId: 'run-1',
  },
};

describe('trusted kernel host', () => {
  it('keeps kernel failure diagnostics bounded to safe codes', () => {
    expect(sanitizeKernelHostFailureCode(new Error('kernel_action_scope_mismatch'))).toBe(
      'kernel_action_scope_mismatch',
    );
    expect(sanitizeKernelHostFailureCode(new Error('kernel_action_decide_scope_failed'))).toBe(
      'kernel_action_decide_scope_failed',
    );
    expect(
      sanitizeKernelHostFailureCode({
        name: 'JarvisRepositoryError',
        code: 'approval_status_conflict',
      }),
    ).toBe('approval_status_conflict');
    expect(
      sanitizeKernelHostFailureCode(
        new Error('token=synthetic-secret account=private-user C:\\private\\file.txt'),
      ),
    ).toBe('unclassified');
    expect(sanitizeKernelHostFailureCode({ code: 'not safe' })).toBe('unclassified');
  });

  it('logs only the request kind and sanitized failure code when a host request throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tauri.invoke.mockImplementation(async (command: string) =>
      command === 'register_kernel_host'
        ? { epoch: 7, ownerToken: 'native-owner-token' }
        : undefined,
    );
    const session = await startJarvisKernelHost({
      createRuntime: () => ({
        handleRequest: async () => {
          throw new Error('kernel_action_scope_mismatch');
        },
        invalidateAccount: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    tauri.handler?.({ payload: request });
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith('[jarvis-kernel] request failed', {
        requestKind: 'cancel',
        code: 'kernel_action_scope_mismatch',
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('account-1');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('run-1');

    if (session.role !== 'host') throw new Error(session.reason);
    await session.dispose();
  });

  beforeEach(() => {
    tauri.invoke.mockReset();
    tauri.listen.mockReset();
    tauri.listen.mockImplementation(async (_event, handler) => {
      tauri.handler = handler;
      return tauri.unlisten;
    });
    tauri.unlisten.mockReset();
    tauri.handler = undefined;
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it.each([
    ['kernel_host_wrong_window', 'kernel_host_wrong_window'],
    ['current webview is not a WebviewWindow', 'webview_window_unavailable'],
    [new Error('current webview is not a WebviewWindow'), 'webview_window_unavailable'],
    ['current webview is not a WebviewWindow: ownerToken=private', 'unclassified'],
    [new Error('ownerToken=private C:\\private\\file.txt account=private-user'), 'unclassified'],
    [
      { message: 'kernel_host_wrong_window', ownerToken: 'private', epoch: 417 },
      'kernel_host_wrong_window',
    ],
  ])('reports a closed registration diagnostic for %j', async (error, code) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createRuntime = vi.fn();
    tauri.invoke.mockRejectedValueOnce(error);

    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });

    expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
      stage: 'native_registration',
      code,
    });
    expect(tauri.invoke.mock.calls).toEqual([['register_kernel_host']]);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(tauri.unlisten).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/private|ownerToken|epoch|417/);
  });

  it('reports invalid registration without logging returned credentials or constructing a runtime', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const createRuntime = vi.fn();
    tauri.invoke.mockResolvedValueOnce({ epoch: 417, ownerToken: 'private', unexpected: 'secret' });
    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
      stage: 'native_registration',
      code: 'kernel_host_registration_invalid',
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(tauri.invoke.mock.calls).toEqual([['register_kernel_host']]);
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it('reports runtime creation failure and preserves listener cleanup and native release order', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    tauri.unlisten.mockImplementation(() => {
      order.push('unlisten');
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      order.push(command);
      return command === 'register_kernel_host'
        ? { epoch: 417, ownerToken: 'native-private-token' }
        : undefined;
    });
    const createRuntime = vi.fn(() => {
      throw new Error('jarvis_kernel_host_already_installed');
    });
    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });
    expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
      stage: 'runtime_creation',
      code: 'jarvis_kernel_host_already_installed',
    });
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(order).toEqual(['register_kernel_host', 'unlisten', 'release_kernel_host']);
    expect(tauri.invoke.mock.calls).toEqual([
      ['register_kernel_host'],
      ['release_kernel_host', { epoch: 417, ownerToken: 'native-private-token' }],
    ]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toMatch(/private|ownerToken|epoch|417/);
    expect(requestLocalJarvisKernelHost(request.request)).toBeNull();
  });

  it.each(['reject', 'throw'])(
    'reports native listener failure (%s) without acquiring authority',
    async (mode) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = new Error('ownerToken=private-listener-secret');
      if (mode === 'reject') tauri.listen.mockRejectedValueOnce(error);
      else
        tauri.listen.mockImplementationOnce(() => {
          throw error;
        });
      const createRuntime = vi.fn();
      await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
        role: 'unavailable',
        reason: 'host_unavailable',
      });
      expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
        stage: 'native_listener',
        code: 'unclassified',
      });
      expect(tauri.invoke).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(tauri.unlisten).not.toHaveBeenCalled();
    },
  );

  it('reports native transport import failure without invoking a listener or registering', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.resetModules();
    vi.doMock('@tauri-apps/api/core', () => {
      throw new Error('ownerToken=private-import-secret');
    });
    try {
      const isolatedHost = await import('./kernelHost');
      const createRuntime = vi.fn();
      await expect(isolatedHost.startJarvisKernelHost({ createRuntime })).resolves.toEqual({
        role: 'unavailable',
        reason: 'host_unavailable',
      });
      expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
        stage: 'native_transport',
        code: 'unclassified',
      });
      expect(tauri.listen).not.toHaveBeenCalled();
      expect(tauri.invoke).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
    } finally {
      vi.doMock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
      vi.resetModules();
    }
  });

  it.each(['accessor', 'proxy'])(
    'never exposes or invokes hostile error properties (%s)',
    async (kind) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const getter = vi.fn(() => {
        throw new Error('ownerToken=private-error-getter');
      });
      const error =
        kind === 'accessor'
          ? Object.defineProperty({}, 'message', { get: getter })
          : new Proxy({}, { getOwnPropertyDescriptor: getter });
      tauri.invoke.mockImplementation(async (command: string) =>
        command === 'register_kernel_host'
          ? { epoch: 417, ownerToken: 'native-private-token' }
          : undefined,
      );
      await expect(
        startJarvisKernelHost({
          createRuntime: () => {
            throw error;
          },
        }),
      ).resolves.toEqual({
        role: 'unavailable',
        reason: 'host_unavailable',
      });
      expect(consoleError).toHaveBeenCalledExactlyOnceWith('[jarvis-kernel] startup failed', {
        stage: 'runtime_creation',
        code: 'unclassified',
      });
      if (kind === 'accessor') expect(getter).not.toHaveBeenCalled();
      expect(tauri.unlisten).toHaveBeenCalledOnce();
      expect(tauri.invoke.mock.calls).toEqual([
        ['register_kernel_host'],
        ['release_kernel_host', { epoch: 417, ownerToken: 'native-private-token' }],
      ]);
    },
  );

  it.each(['getter', 'call'])(
    'keeps cleanup and subsequent host startup intact when console observation throws (%s)',
    async (kind) => {
      const original = Object.getOwnPropertyDescriptor(console, 'error')!;
      const fail = vi.fn(() => {
        throw new Error('private-observer-failure');
      });
      Object.defineProperty(
        console,
        'error',
        kind === 'getter'
          ? { configurable: true, get: fail }
          : { configurable: true, writable: true, value: fail },
      );
      tauri.invoke.mockImplementation(async (command: string) =>
        command === 'register_kernel_host'
          ? { epoch: 417, ownerToken: 'native-private-token' }
          : undefined,
      );
      let failed;
      try {
        failed = await startJarvisKernelHost({
          createRuntime: () => {
            throw new Error('private-runtime-error');
          },
        });
      } finally {
        Object.defineProperty(console, 'error', original);
      }
      expect(failed).toEqual({ role: 'unavailable', reason: 'host_unavailable' });
      expect(fail).toHaveBeenCalledOnce();
      expect(tauri.unlisten).toHaveBeenCalledOnce();
      expect(tauri.invoke.mock.calls.map(([command]) => command)).toEqual([
        'register_kernel_host',
        'release_kernel_host',
      ]);
      const next = await startJarvisKernelHost({
        createRuntime: () => ({
          handleRequest: vi.fn(),
          invalidateAccount: vi.fn(),
          dispose: vi.fn(),
        }),
      });
      expect(next.role).toBe('host');
      if (next.role === 'host') await next.dispose();
    },
  );

  it('constructs one runtime only after native attestation and keeps the owner token closed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    const invalidateAccount = vi.fn((accountId: string) => order.push(`invalidate:${accountId}`));
    const disposeRuntime = vi.fn(async () => {
      order.push('runtime:dispose');
    });
    const handleRequest = vi.fn(async () => ({
      version: 1 as const,
      kind: 'cancellation_state' as const,
      runId: 'run-1',
      state: 'delivered' as const,
    }));
    const createRuntime = vi.fn(() => ({
      handleRequest,
      invalidateAccount,
      dispose: disposeRuntime,
    }));
    tauri.invoke.mockImplementation(async (command: string, input?: Record<string, unknown>) => {
      order.push(command);
      if (command === 'register_kernel_host') {
        return { epoch: 7, ownerToken: 'native-owner-token' };
      }
      if (command === 'kernel_host_respond') {
        expect(input).toMatchObject({
          epoch: 7,
          ownerToken: 'native-owner-token',
          requestId: 'kreq-7-1',
        });
      }
      return undefined;
    });

    const session = await startJarvisKernelHost({ createRuntime });
    expect(session.role).toBe('host');
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(JSON.stringify(session)).not.toContain('native-owner-token');

    tauri.handler?.({ payload: request });
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledWith(request.request));
    await vi.waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith(
        'kernel_host_respond',
        expect.objectContaining({ requestId: 'kreq-7-1' }),
      ),
    );

    if (session.role !== 'host') throw new Error(session.reason);
    session.invalidateAccount('account-1');
    await session.dispose();
    expect(tauri.unlisten).toHaveBeenCalledOnce();
    expect(order.indexOf('runtime:dispose')).toBeLessThan(order.indexOf('release_kernel_host'));
    expect(invalidateAccount).toHaveBeenCalledWith('account-1');
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('installs one validated host-local DTO path only for the attested runtime lifetime', async () => {
    const handleRequest = vi.fn(async () => ({
      version: 1 as const,
      kind: 'turn_accepted' as const,
      runId: 'wrong-kind',
    }));
    tauri.invoke.mockImplementation(async (command: string) =>
      command === 'register_kernel_host'
        ? { epoch: 7, ownerToken: 'native-owner-token' }
        : undefined,
    );

    expect(requestLocalJarvisKernelHost(request.request)).toBeNull();
    const session = await startJarvisKernelHost({
      createRuntime: () => ({
        handleRequest,
        invalidateAccount: vi.fn(),
        dispose: vi.fn(),
      }),
    });
    expect(session.role).toBe('host');
    expect(Object.keys(session).sort()).toEqual(['dispose', 'invalidateAccount', 'role']);

    await expect(requestLocalJarvisKernelHost(request.request)).resolves.toEqual({
      version: 1,
      kind: 'unavailable',
      requestKind: 'cancel',
      reason: 'invalid_response',
    });
    expect(handleRequest).toHaveBeenCalledWith(request.request);
    expect(
      requestLocalJarvisKernelHost({
        ...request.request,
        arbitraryTarget: 'main',
      } as never),
    ).toBeNull();

    if (session.role !== 'host') throw new Error(session.reason);
    await session.dispose();
    expect(requestLocalJarvisKernelHost(request.request)).toBeNull();
  });

  it('serializes StrictMode-style host lifecycles until native release completes', async () => {
    let epoch = 0;
    let activeRuntimes = 0;
    let maximumActiveRuntimes = 0;
    const createRuntime = vi.fn(() => {
      activeRuntimes += 1;
      maximumActiveRuntimes = Math.max(maximumActiveRuntimes, activeRuntimes);
      return {
        handleRequest: vi.fn(),
        invalidateAccount: vi.fn(),
        dispose: async () => {
          activeRuntimes -= 1;
        },
      };
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'register_kernel_host') {
        epoch += 1;
        return { epoch, ownerToken: `native-owner-token-${epoch}` };
      }
      return undefined;
    });

    const firstPromise = startJarvisKernelHost({ createRuntime });
    const secondPromise = startJarvisKernelHost({ createRuntime });
    const first = await firstPromise;
    await Promise.resolve();
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'register_kernel_host'),
    ).toHaveLength(1);

    if (first.role !== 'host') throw new Error(first.reason);
    await first.dispose();
    const second = await secondPromise;
    expect(second.role).toBe('host');
    expect(maximumActiveRuntimes).toBe(1);
    if (second.role !== 'host') throw new Error(second.reason);
    await second.dispose();
  });

  it('fails closed in a secondary native webview without constructing runtime authority', async () => {
    const createRuntime = vi.fn();
    tauri.invoke.mockRejectedValueOnce('kernel_host_wrong_window');
    const session = await startJarvisKernelHost({ createRuntime });
    expect(session).toEqual({ role: 'unavailable', reason: 'host_unavailable' });
    expect(createRuntime).not.toHaveBeenCalled();
    expect(tauri.listen).toHaveBeenCalledOnce();
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it('uses native window attestation even when a secondary query marker is present', async () => {
    window.history.replaceState({}, '', '/?workbench=1');
    const createRuntime = vi.fn();
    tauri.invoke.mockRejectedValueOnce('kernel_host_wrong_window');

    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });

    expect(tauri.invoke).toHaveBeenCalledWith('register_kernel_host');
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('serializes simultaneous native client requests through one host runtime', async () => {
    let releaseFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handled: string[] = [];
    const handleRequest = vi.fn(
      async (
        input:
          | typeof request.request
          | {
              version: 1;
              kind: 'command_center_snapshot';
              accountId: string;
            },
      ) => {
        if (input.kind === 'cancel') {
          await firstBlocked;
          handled.push(input.kind);
          return {
            version: 1 as const,
            kind: 'cancellation_state' as const,
            runId: input.runId,
            state: 'delivered' as const,
          };
        }
        if (input.kind !== 'command_center_snapshot') {
          throw new Error(`Unexpected host request: ${input.kind}`);
        }
        handled.push(input.kind);
        return {
          version: 1 as const,
          kind: 'command_center_snapshot' as const,
          accountId: input.accountId,
          runs: [],
        };
      },
    );
    tauri.invoke.mockImplementation(async (command: string) =>
      command === 'register_kernel_host'
        ? { epoch: 7, ownerToken: 'native-owner-token' }
        : undefined,
    );
    const session = await startJarvisKernelHost({
      createRuntime: () => ({
        handleRequest,
        invalidateAccount: vi.fn(),
        dispose: vi.fn(),
      }),
    });

    tauri.handler?.({ payload: request });
    tauri.handler?.({
      payload: {
        epoch: 7,
        requestId: 'kreq-7-2',
        request: {
          version: 1,
          kind: 'command_center_snapshot',
          accountId: 'account-1',
        },
      },
    });
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(1));
    releaseFirst();
    await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledTimes(2));
    expect(handled).toEqual(['cancel', 'command_center_snapshot']);

    if (session.role !== 'host') throw new Error(session.reason);
    await session.dispose();
  });

  it('releases the native epoch after a runtime teardown error', async () => {
    const order: string[] = [];
    tauri.invoke.mockImplementation(async (command: string) => {
      order.push(command);
      return command === 'register_kernel_host'
        ? { epoch: 9, ownerToken: 'native-owner-token' }
        : undefined;
    });
    const session = await startJarvisKernelHost({
      createRuntime: () => ({
        handleRequest: vi.fn(),
        invalidateAccount: vi.fn(),
        dispose: async () => {
          order.push('runtime:dispose');
          throw new Error('teardown failed');
        },
      }),
    });

    if (session.role !== 'host') throw new Error(session.reason);
    await expect(session.dispose()).rejects.toThrow('teardown failed');
    expect(order.indexOf('runtime:dispose')).toBeLessThan(order.indexOf('release_kernel_host'));
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it('requires a non-stealable browser Web Lock and releases it after runtime teardown', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const order: string[] = [];
    let lockReleased = false;
    const requestLock = vi.fn(
      async (
        _name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => {
        expect(options).toMatchObject({ mode: 'exclusive', ifAvailable: true, steal: false });
        await callback({ name: 'vibespace.jarvis.kernel-host.v1', mode: 'exclusive' });
        order.push('lock:released');
        lockReleased = true;
      },
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: requestLock },
    });
    const session = await startJarvisKernelHost({
      createRuntime: () => ({
        handleRequest: vi.fn(),
        invalidateAccount: vi.fn(),
        dispose: async () => {
          order.push('runtime:dispose');
        },
      }),
    });
    expect(session.role).toBe('host');
    expect(lockReleased).toBe(false);
    if (session.role !== 'host') throw new Error(session.reason);
    await session.dispose();
    await vi.waitFor(() => expect(lockReleased).toBe(true));
    expect(order).toEqual(['runtime:dispose', 'lock:released']);
  });

  it.each(['/?workbench=1', '/?view=dictation', '/?view=pet-overlay', '/?view=pet-mini-panel'])(
    'never elects browser authority for auxiliary surface %s',
    async (url) => {
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      window.history.replaceState({}, '', url);
      const createRuntime = vi.fn();
      const requestLock = vi.fn();
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: requestLock },
      });

      await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
        role: 'unavailable',
        reason: 'host_unavailable',
      });

      expect(requestLock).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
    },
  );

  it('does not construct browser authority when Web Locks are absent or already held', async () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    const createRuntime = vi.fn();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });

    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: LockOptions, callback: Function) => callback(null),
      },
    });
    await expect(startJarvisKernelHost({ createRuntime })).resolves.toEqual({
      role: 'unavailable',
      reason: 'host_unavailable',
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
