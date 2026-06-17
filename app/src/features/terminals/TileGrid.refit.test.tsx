import * as React from 'react';
import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TileGrid } from './TileGrid';
import { fromLeaves, newLeaf, type PaneNode } from './paneTree';

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
  PaneToolbar: ({ onFullscreenToggle }: { onFullscreenToggle: () => void }) => (
    <button type="button" onClick={onFullscreenToggle}>
      fullscreen
    </button>
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

  beforeEach(() => {
    rafQueue = [];
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
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

    expect(dispatch.mock.calls.some(([event]) => event.type === 'jarvis:terminals:visible')).toBe(true);
  });

  it('broadcasts a terminal refit after fullscreen visibility changes', () => {
    const onChange = vi.fn();
    const dispatch = vi.spyOn(window, 'dispatchEvent');
    const tree = twoPaneTree();
    const { rerender } = render(<TileGrid tree={tree} onChange={onChange} fullscreenPaneId={null} />);

    rerender(<TileGrid tree={tree} onChange={onChange} fullscreenPaneId="pane-a" />);
    flushAnimationFrames();

    expect(dispatch.mock.calls.some(([event]) => event.type === 'jarvis:terminals:visible')).toBe(true);
  });
});
