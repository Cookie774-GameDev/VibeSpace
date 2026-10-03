import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestTerminalLeafClose, TileGrid } from './TileGrid';
import { fromLeaves, newLeaf, type PaneNode } from './paneTree';

const playUiSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/sfx', () => ({ playUiSound }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('./TerminalView', () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));

vi.mock('./AgentRolePicker', () => ({
  AgentRolePicker: () => <button type="button">agent</button>,
}));

vi.mock('./ConnectedFilesButton', () => ({
  ConnectedFilesButton: () => <button type="button">files</button>,
}));

vi.mock('./PaneToolbar', () => ({
  nextFontSize: (current: number) => current + 1,
  PaneToolbar: ({
    onFullscreenToggle,
    onClose,
  }: {
    onFullscreenToggle: () => void;
    onClose: () => void;
  }) => (
    <>
      <button type="button" onClick={onFullscreenToggle}>
        fullscreen
      </button>
      <button type="button" onClick={onClose}>
        close terminal
      </button>
    </>
  ),
}));

function twoPaneTree(): PaneNode {
  return fromLeaves([
    newLeaf({ id: 'pane-a', command: 'powershell' }) as Extract<PaneNode, { kind: 'leaf' }>,
    newLeaf({ id: 'pane-b', command: 'powershell' }) as Extract<PaneNode, { kind: 'leaf' }>,
  ]);
}

describe('TileGrid terminal refit scheduling', () => {
  let rafQueue: FrameRequestCallback[] = [];
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    playUiSound.mockReset();
    rafQueue = [];
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    originalMatchMedia = window.matchMedia;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn() as typeof window.cancelAnimationFrame;
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 500,
      top: 0,
      left: 0,
      right: 800,
      bottom: 500,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  function flushAnimationFrames() {
    for (let i = 0; i < 3; i += 1) {
      const pending = rafQueue;
      rafQueue = [];
      pending.forEach((cb) => cb(performance.now()));
    }
  }

  it('broadcasts a terminal refit after manual grid resize completes', () => {
    const onChange = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const { getByRole } = render(<TileGrid tree={twoPaneTree()} onChange={onChange} />);

    const separator = getByRole('separator', { name: /drag to resize/i });
    fireEvent.mouseDown(separator, { clientX: 400, clientY: 20 });
    fireEvent.mouseMove(document, { clientX: 460, clientY: 20 });
    fireEvent.mouseUp(document);
    flushAnimationFrames();

    expect(dispatch.mock.calls.some(([event]) => event.type === 'jarvis:terminals:visible')).toBe(
      true,
    );
  });

  it('broadcasts a terminal refit after fullscreen visibility changes', () => {
    const onChange = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const tree = twoPaneTree();
    const { rerender } = render(
      <TileGrid tree={tree} onChange={onChange} fullscreenPaneId={null} />,
    );

    rerender(<TileGrid tree={tree} onChange={onChange} fullscreenPaneId="pane-a" />);
    flushAnimationFrames();

    expect(dispatch.mock.calls.some(([event]) => event.type === 'jarvis:terminals:visible')).toBe(
      true,
    );
  });

  it('flattens the rendered pane shadow only in MonoChrome', () => {
    const { container } = render(<TileGrid tree={newLeaf()} onChange={vi.fn()} />);
    const pane = container.querySelector<HTMLElement>('[data-terminal-drop="pane"]');

    expect(pane?.className).toContain('shadow-soft');
    expect(pane?.className).toContain('[html[data-theme=monochrome]_&]:shadow-none');
  });

  it('plays the delete cue only after a terminal pane closes', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<TileGrid tree={newLeaf()} onChange={onChange} />);

    fireEvent.click(getByRole('button', { name: 'close terminal' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(playUiSound).toHaveBeenCalledWith('trash_delete');
  });

  it('uses immediate focus scrolling and non-animated focus chrome for reduced motion', () => {
    vi.useFakeTimers();
    try {
      window.matchMedia = vi.fn(
        () =>
          ({
            matches: true,
            media: '(prefers-reduced-motion: reduce)',
            onchange: null,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
          }) as MediaQueryList,
      );
      const scrollIntoView = vi.fn();
      HTMLElement.prototype.scrollIntoView = scrollIntoView;
      const tree: PaneNode = {
        kind: 'leaf',
        id: 'pane-focus',
        sessionId: 'pty-focus',
        command: 'powershell',
      };
      const { container } = render(<TileGrid tree={tree} onChange={vi.fn()} />);

      act(() => {
        window.dispatchEvent(
          new CustomEvent('jarvis:terminal:focus', {
            detail: { sessionId: 'pty-focus', paneId: 'pane-focus' },
          }),
        );
      });

      const pane = container.querySelector<HTMLElement>('[data-terminal-drop="pane"]');
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
      expect(pane?.className).toContain('animate-terminal-focus');
      expect(pane?.className).toContain('motion-reduce:animate-none');
      expect(pane?.className).toContain('[html[data-theme=monochrome]_&]:animate-none');
      expect(pane?.className).toContain('[html[data-theme=monochrome]_&]:ring-0');
      expect(pane?.className).toContain('[html[data-theme=monochrome]_&]:outline');

      act(() => {
        vi.advanceTimersByTime(2_500);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the exact acknowledged create shell before closing without cancelling its completed run', async () => {
    const kill = vi.fn(async () => undefined);
    const forget = vi.fn();
    const requestCanonical = vi.fn(async () => null);
    await expect(requestTerminalLeafClose({ executionId: 'jterm_1', sessionId: 'pty_1' }, {
      isCompletedCreation: (executionId, sessionId) => executionId === 'jterm_1' && sessionId === 'pty_1',
      isCanonical: () => true, kill, forget, requestCanonical,
    })).resolves.toBe('manual_closed');
    expect(kill).toHaveBeenCalledExactlyOnceWith('pty_1');
    expect(forget).toHaveBeenCalledExactlyOnceWith('pty_1');
    expect(requestCanonical).not.toHaveBeenCalled();
  });

  it('retains an acknowledged create pane when its native kill fails', async () => {
    const forget = vi.fn();
    await expect(requestTerminalLeafClose({ executionId: 'jterm_1', sessionId: 'pty_1' }, {
      isCompletedCreation: () => true,
      kill: async () => { throw new Error('native kill failed'); }, forget,
    })).rejects.toThrow('native kill failed');
    expect(forget).not.toHaveBeenCalled();
  });

  it('rejects unavailable canonical pane close truth without a raw kill', async () => {
    const requestCanonical = vi.fn(async () => null);
    const kill = vi.fn(async () => undefined);

    await expect(
      requestTerminalLeafClose(
        { executionId: 'jterm_1', sessionId: 'pty_1' },
        {
          isCanonical: () => true,
          requestCanonical,
          kill,
        },
      ),
    ).resolves.toBe('canonical_rejected');

    expect(requestCanonical).toHaveBeenCalledWith('jterm_1');
    expect(kill).not.toHaveBeenCalled();
  });

  it('reports canonical pane close pending only after intent is committed', async () => {
    const requestCanonical = vi.fn(async () => ({
      kind: 'intent_committed' as const,
      requestState: 'new' as const,
      authorityState: 'current' as const,
      cancellationRequestId: 'jcancel_1',
      aggregate: { kind: 'handoff_pending' as const, ownerIds: ['terminal:jterm_1'] },
    }));

    await expect(
      requestTerminalLeafClose(
        { executionId: 'jterm_1', sessionId: 'pty_1' },
        { isCanonical: () => true, requestCanonical },
      ),
    ).resolves.toBe('canonical_pending');
  });
});
