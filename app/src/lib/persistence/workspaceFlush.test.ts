import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindCanvasWorkspaceFlush,
  flushWorkspacePersistence,
  flushWorkspacePersistenceAndAcknowledge,
  _resetCanvasFlushForTests,
} from './workspaceFlush';
import { captureLiveTree, _resetLiveCacheForTests } from '@/features/terminals/terminalLiveCache';
import { terminalTreeStorageKey } from '@/features/terminals/terminalProjectMove';
import { useTerminalTranscriptStore } from '@/features/terminals/transcriptStore';
import type { PaneNode } from '@/features/terminals/paneTree';
import {
  _resetTerminalSnapshotRegistryForTests,
  registerTerminalSnapshotFlush,
} from '@/features/terminals/terminalSnapshotRegistry';

function leaf(id: string, sessionId: string): PaneNode {
  return {
    kind: 'leaf',
    id,
    sessionId,
    projectId: 'project-a',
    command: 'powershell.exe',
    currentInput: undefined,
  } as PaneNode;
}

describe('flushWorkspacePersistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetLiveCacheForTests();
    _resetTerminalSnapshotRegistryForTests();
    _resetCanvasFlushForTests();
    useTerminalTranscriptStore.getState().reset();
    vi.useRealTimers();
  });

  it('broadcasts terminal persist before flushing transcripts and pane trees', async () => {
    const order: string[] = [];
    window.addEventListener(
      'jarvis:terminal:persist-now',
      () => {
        order.push('event');
        useTerminalTranscriptStore.getState().registerSession('pty-live', {
          paneId: 'pane-a',
          projectId: 'project-a',
          command: 'powershell.exe',
        });
        useTerminalTranscriptStore.getState().appendOutput('pty-live', 'last second output\n');
      },
      { once: true },
    );
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(
      this: Storage,
      key,
      value,
    ) {
      if (key === 'jarvis-terminal-transcripts') order.push('storage');
      return originalSetItem.call(this, key, value);
    });

    captureLiveTree('project-a', leaf('pane-a', 'pty-live'));
    await flushWorkspacePersistence('test');

    expect(order.indexOf('event')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('storage')).toBeGreaterThan(order.indexOf('event'));
    expect(window.localStorage.getItem(terminalTreeStorageKey('project-a'))).toContain('pane-a');
    expect(window.localStorage.getItem('jarvis-terminal-transcripts')).toContain(
      'last second output',
    );
  });

  it('awaits bound Canvas persistence before resolving the workspace flush', async () => {
    let release: (() => void) | undefined;
    const flushedReasons: string[] = [];
    const unbind = bindCanvasWorkspaceFlush(
      (reason) =>
        new Promise<void>((resolve) => {
          release = () => {
            flushedReasons.push(reason);
            resolve();
          };
        }),
    );

    let settled = false;
    const pending = flushWorkspacePersistence('tray-hide').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await pending;
    expect(flushedReasons).toEqual(['tray-hide']);
    unbind();
  });

  it.each(['jarvis-terminal-transcripts', terminalTreeStorageKey('project-a')])(
    'reports a failed durable write to %s and allows a later successful retry',
    async (failedKey) => {
      captureLiveTree('project-a', leaf('pane-a', 'pty-live'));
      useTerminalTranscriptStore.getState().registerSession('pty-live', {
        paneId: 'pane-a',
        projectId: 'project-a',
        command: 'powershell.exe',
      });
      useTerminalTranscriptStore.getState().appendOutput('pty-live', 'unsaved work');
      const original = Storage.prototype.setItem;
      const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        key,
        value,
      ) {
        if (key === failedKey) throw new DOMException('synthetic full disk', 'QuotaExceededError');
        return original.call(this, key, value);
      });
      try {
        expect((await flushWorkspacePersistence('pre-update-install')).failed).toBeGreaterThan(0);
      } finally {
        writes.mockRestore();
      }
      expect((await flushWorkspacePersistence('retry')).failed).toBe(0);
      expect(window.localStorage.getItem(failedKey)).toContain(
        failedKey === 'jarvis-terminal-transcripts' ? 'unsaved work' : 'pane-a',
      );
    },
  );

  it('contains a Canvas persistence failure without rejecting the workspace flush', async () => {
    const unbind = bindCanvasWorkspaceFlush(async () => {
      throw new Error('synthetic canvas failure');
    });

    await expect(flushWorkspacePersistence('canvas-error')).resolves.toMatchObject({
      timedOut: false,
      canvas: {
        completed: 0,
        failed: 1,
        timedOut: false,
      },
    });
    unbind();
  });

  it('returns after the 1,200 ms Canvas persistence deadline', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const unbind = bindCanvasWorkspaceFlush(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let result: Awaited<ReturnType<typeof flushWorkspacePersistence>> | undefined;
    const pending = flushWorkspacePersistence('canvas-timeout').then((value) => {
      result = value;
      return value;
    });

    await vi.advanceTimersByTimeAsync(1_200);
    try {
      expect(result).toMatchObject({
        canvas: {
          completed: 0,
          failed: 0,
          timedOut: true,
        },
      });
    } finally {
      release?.();
      await pending;
      unbind();
    }
  });

  it('awaits registered terminal snapshots after synchronous storage work', async () => {
    let release: (() => void) | undefined;
    registerTerminalSnapshotFlush(
      'pane-a',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    let settled = false;
    const pending = flushWorkspacePersistence('await-snapshot').then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release?.();
    await expect(pending).resolves.toEqual({
      completed: 1,
      failed: 0,
      timedOut: false,
      canvas: { completed: 0, failed: 0, timedOut: false },
    });
  });

  it('reports snapshot rejection without rejecting the workspace flush', async () => {
    registerTerminalSnapshotFlush('bad', async () => {
      throw new Error('synthetic snapshot failure');
    });

    await expect(flushWorkspacePersistence('rejection')).resolves.toEqual({
      completed: 0,
      failed: 1,
      timedOut: false,
      canvas: { completed: 0, failed: 0, timedOut: false },
    });
  });

  it('returns after the 1,200 ms snapshot deadline', async () => {
    vi.useFakeTimers();
    registerTerminalSnapshotFlush('stuck', () => new Promise(() => {}));

    const pending = flushWorkspacePersistence('timeout');
    await vi.advanceTimersByTimeAsync(1_200);

    await expect(pending).resolves.toEqual({
      completed: 0,
      failed: 0,
      timedOut: true,
      canvas: { completed: 0, failed: 0, timedOut: false },
    });
  });

  it('acknowledges desktop exit only after the bounded flush settles', async () => {
    let release: (() => void) | undefined;
    registerTerminalSnapshotFlush(
      'pane-exit',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const acknowledge = vi.fn(async () => undefined);

    const pending = flushWorkspacePersistenceAndAcknowledge('tray-exit', acknowledge);
    await Promise.resolve();
    expect(acknowledge).not.toHaveBeenCalled();

    release?.();
    await expect(pending).resolves.toEqual({
      completed: 1,
      failed: 0,
      timedOut: false,
      canvas: { completed: 0, failed: 0, timedOut: false },
    });
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
