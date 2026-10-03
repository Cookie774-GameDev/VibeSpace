// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WallpaperHost } from './WallpaperHost';
import type { WorkbenchWallpaperConfig } from './types';

const wallpaper: WorkbenchWallpaperConfig = {
  id: 'particles', paused: false, interactive: true, intensity: 0.6,
  brightness: 0.8, quality: 'balanced',
};
let pending: Map<number, FrameRequestCallback>;
let painted: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pending = new Map();
  let next = 0;
  painted = vi.fn();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++next;
    pending.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const context = { clearRect: painted, beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillStyle: '' };
  const canvas2d: { getContext(contextId: '2d'): CanvasRenderingContext2D | null } = HTMLCanvasElement.prototype;
  vi.spyOn(canvas2d, 'getContext').mockImplementation((contextId) =>
    contextId === '2d' ? context as unknown as CanvasRenderingContext2D : null,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('coalesces repeated resizes into one continuing wallpaper animation chain', () => {
  render(<WallpaperHost config={wallpaper} />);
  expect(pending.size).toBe(1);
  for (let index = 0; index < 3; index++) fireEvent(window, new Event('resize'));
  expect(pending.size).toBe(1);
  const [id, callback] = [...pending.entries()][0];
  pending.delete(id);
  callback(16);
  expect(pending.size).toBe(1);
  expect(painted).toHaveBeenCalledTimes(5);
});

it('releases every scheduled chain and ignores a callback delivered after unmount', () => {
  const view = render(<WallpaperHost config={wallpaper} />);
  fireEvent(window, new Event('resize'));
  const lateCallbacks = [...pending.values()];
  const paintsBeforeUnmount = painted.mock.calls.length;
  view.unmount();
  expect(pending.size).toBe(0);
  for (const callback of lateCallbacks) callback(32);
  expect(pending.size).toBe(0);
  expect(painted).toHaveBeenCalledTimes(paintsBeforeUnmount);
  fireEvent(window, new Event('resize'));
  expect(painted).toHaveBeenCalledTimes(paintsBeforeUnmount);
});

it('keeps the saved paused presentation and resumes only one chain', () => {
  const view = render(<WallpaperHost config={wallpaper} />);
  view.rerender(<WallpaperHost config={{ ...wallpaper, paused: true }} />);
  expect(pending.size).toBe(0);
  fireEvent(window, new Event('resize'));
  expect(pending.size).toBe(0);
  expect(view.getByTestId('workbench-wallpaper').getAttribute('data-paused')).toBe('true');
  view.rerender(<WallpaperHost config={wallpaper} />);
  expect(pending.size).toBe(1);
});
