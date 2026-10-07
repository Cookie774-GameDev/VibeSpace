import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { ContextAutoUpdateHost } from './ContextAutoUpdateHost';

const io = vi.hoisted(() => ({
  queryGates: [] as Promise<void>[],
  enabled: true,
  revision: 1,
  tickGate: undefined as Promise<void> | undefined,
  factoryGate: undefined as Promise<void> | undefined,
  signals: [] as AbortSignal[],
  runners: [] as Array<{ tick: ReturnType<typeof vi.fn> }>,
  puts: [] as unknown[],
}));
const setting = () => ({
  kind: 'context-auto-update-v1',
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  mapId: 'map-a',
  enabled: io.enabled,
  consentRevision: io.revision,
  fingerprint: 'fixture',
});
vi.mock('@/lib/db', () => ({
  openDb: async () => {},
  db: {
    settings: {
      where: () => ({
        startsWith: () => ({
          toArray: async () => {
            await io.queryGates.shift();
            return [
              {
                key: JSON.stringify({
                  accountId: 'account-a',
                  workspaceId: 'workspace-a',
                  projectId: 'project-a',
                  mapId: 'map-a',
                }),
                value: setting(),
              },
            ];
          },
        }),
      }),
      get: async () => ({ value: setting() }),
      put: async (row: unknown) => {
        io.puts.push(row);
      },
    },
    transaction: async (_mode: string, _store: unknown, run: () => Promise<void>) => run(),
  },
}));
vi.mock('./contextAutoUpdate', () => ({
  CONTEXT_AUTO_UPDATE_EVENT: 'jarvis:context-auto-update-changed',
  contextAutoUpdateKey: (scope: unknown) => JSON.stringify(scope),
  createProductionContextAutoUpdater: async () => {
    const runner = {
      tick: vi.fn(async (signal: AbortSignal) => {
        io.signals.push(signal);
        await io.tickGate;
        return 'idle';
      }),
    };
    io.runners.push(runner);
    await io.factoryGate;
    return runner;
  },
}));
vi.mock('@/features/dev-console', () => ({ devConsole: { log: vi.fn() } }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const pending: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  io.queryGates = [];
  io.enabled = true;
  io.revision = 1;
  io.signals = [];
  io.runners = [];
  io.puts = [];
  io.tickGate = undefined;
  io.factoryGate = undefined;
  useAuthStore.setState({
    localUserId: 'account-a',
    cloudSession: null,
    workspaceId: 'workspace-a' as WorkspaceId,
    projectId: 'project-a' as ProjectId,
  });
});
afterEach(async () => {
  cleanup();
  for (const resolve of pending.splice(0)) resolve();
  await Promise.resolve();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
async function mountHost() {
  render(<ContextAutoUpdateHost />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}
function switchAwayAndBack(part: 'account' | 'workspace' | 'project') {
  const original = useAuthStore.getState();
  useAuthStore.setState(
    part === 'account'
      ? { localUserId: 'account-b' }
      : part === 'workspace'
        ? { workspaceId: 'workspace-b' as WorkspaceId }
        : { projectId: 'project-b' as ProjectId },
  );
  useAuthStore.setState(original);
}
describe('Context auto-update host lifetime', () => {
  it.each(['idle', 'running', 'initializing'] as const)(
    'recovers a transient settings-read failure while %s with unchanged consent',
    async (phase) => {
      const gate = deferred();
      pending.push(gate.resolve);
      if (phase === 'running') io.tickGate = gate.promise;
      if (phase === 'initializing') io.factoryGate = gate.promise;
      await mountHost();
      const originalRunner = io.runners[0]!;
      const originalSignal = io.signals[0];
      const query = deferred();
      pending.push(query.resolve);
      io.queryGates.push(query.promise);
      await act(async () => {
        window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
        query.reject(new Error('temporary settings read failure'));
        await Promise.resolve();
      });
      if (originalSignal) expect(originalSignal.aborted).toBe(true);
      io.tickGate = undefined;
      io.factoryGate = undefined;
      await act(async () => {
        gate.resolve();
        await vi.advanceTimersByTimeAsync(30_001);
      });
      expect(io.runners).toHaveLength(2);
      expect(io.signals.at(-1)).toBeDefined();
      expect(io.signals.at(-1)).not.toBe(originalSignal);
      expect(io.signals.at(-1)?.aborted).toBe(false);
      if (phase === 'initializing') expect(originalRunner.tick).not.toHaveBeenCalled();
      expect(io.revision).toBe(1);
      expect(io.puts).toEqual([]);
    },
  );

  it('does not recreate a disabled map after a transient settings-read failure', async () => {
    await mountHost();
    const originalSignal = io.signals[0]!;
    const query = deferred();
    pending.push(query.resolve);
    io.queryGates.push(query.promise);
    await act(async () => {
      window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
      query.reject(new Error('temporary settings read failure'));
      await Promise.resolve();
    });
    io.enabled = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    expect(originalSignal.aborted).toBe(true);
    expect(io.runners).toHaveLength(1);
    expect(io.signals).toHaveLength(1);
    expect(io.puts).toEqual([]);
  });

  it('ignores an old-scope settings-read failure after a fresh runner starts', async () => {
    const running = deferred();
    pending.push(running.resolve);
    io.tickGate = running.promise;
    await mountHost();
    const query = deferred();
    pending.push(query.resolve);
    io.queryGates.push(query.promise);
    act(() => {
      window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
      switchAwayAndBack('workspace');
      io.tickGate = undefined;
    });
    await act(async () => {
      running.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(io.signals).toHaveLength(2);
    const freshSignal = io.signals[1]!;
    await act(async () => {
      query.reject(new Error('old-scope settings read failure'));
      await vi.advanceTimersByTimeAsync(30_001);
    });
    expect(freshSignal.aborted).toBe(false);
    expect(io.runners).toHaveLength(2);
    expect(io.signals.at(-1)).toBe(freshSignal);
    expect(io.puts).toEqual([]);
  });

  it.each(['account', 'workspace', 'project'] as const)(
    'revokes an in-flight update during batched %s ABA',
    async (part) => {
      const gate = deferred();
      io.tickGate = gate.promise;
      pending.push(gate.resolve);
      await mountHost();
      expect(io.signals).toHaveLength(1);
      const previousSignal = io.signals[0]!;
      act(() => switchAwayAndBack(part));
      expect(previousSignal.aborted).toBe(true);
      expect(io.puts).toEqual([]);
    },
  );

  it('does not start a runner whose initialization crossed a scope ABA', async () => {
    const gate = deferred();
    io.factoryGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    expect(io.runners).toHaveLength(1);
    const oldRunner = io.runners[0]!;
    act(() => switchAwayAndBack('project'));
    await act(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(oldRunner.tick).not.toHaveBeenCalled();
    expect(io.puts).toEqual([]);
  });

  it('aborts a disabled map while preserving its saved setting', async () => {
    const gate = deferred();
    io.tickGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    await act(async () => {
      io.enabled = false;
      window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
      await Promise.resolve();
    });
    expect(io.signals[0]?.aborted).toBe(true);
    expect(io.puts).toEqual([]);
  });

  it('aborts the owned runner and removes polling on unmount', async () => {
    const gate = deferred();
    io.tickGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    cleanup();
    expect(io.signals[0]?.aborted).toBe(true);
    await act(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(io.runners).toHaveLength(1);
  });
  it('does not start a runner disabled while initialization is pending', async () => {
    const gate = deferred();
    io.factoryGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    expect(io.runners).toHaveLength(1);
    const oldRunner = io.runners[0]!;
    await act(async () => {
      io.enabled = false;
      window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
      await Promise.resolve();
    });
    await act(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(oldRunner.tick).not.toHaveBeenCalled();
    expect(io.puts).toEqual([]);
  });

  it('preserves an active runner across ordinary settings and tree publication', async () => {
    const gate = deferred();
    io.tickGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    const originalSignal = io.signals[0]!;
    await act(async () => {
      window.dispatchEvent(new Event('jarvis:context-tree-updated'));
      window.dispatchEvent(new Event('jarvis:context-auto-update-changed'));
      await Promise.resolve();
    });
    expect(originalSignal.aborted).toBe(false);
    expect(io.runners).toHaveLength(1);
  });

  it('starts a fresh runner after returning to the original scope', async () => {
    const gate = deferred();
    io.tickGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    const originalSignal = io.signals[0]!;
    act(() => switchAwayAndBack('project'));
    io.tickGate = undefined;
    await act(async () => {
      gate.resolve();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(originalSignal.aborted).toBe(true);
    expect(io.signals).toHaveLength(2);
    expect(io.signals[1]).not.toBe(originalSignal);
    expect(io.signals[1]?.aborted).toBe(false);
  });

  it('does not write a stale failure receipt after scope revocation', async () => {
    const gate = deferred();
    io.tickGate = gate.promise;
    pending.push(gate.resolve);
    await mountHost();
    act(() => switchAwayAndBack('account'));
    io.tickGate = undefined;
    await act(async () => {
      gate.reject(new Error('old-scope failure'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(io.puts).toEqual([]);
    expect(io.signals).toHaveLength(2);
  });
});
