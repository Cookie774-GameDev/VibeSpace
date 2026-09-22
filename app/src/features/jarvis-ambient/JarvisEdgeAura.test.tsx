import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JarvisEdgeAura, normalizeAmbientSnapshot } from './JarvisEdgeAura';
import type { JarvisAmbientSnapshot } from './types';

const mockRenderer = vi.hoisted(() => ({ draw: vi.fn(), warm: vi.fn(), destroy: vi.fn() }));
vi.mock('./auraRenderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auraRenderer')>()),
  createAuraRenderer: () => mockRenderer,
}));

const listening: JarvisAmbientSnapshot = {
  revision: 4,
  state: 'listening',
  source: 'voice',
  observedAt: 100,
  energy: 0.72,
};

describe('JarvisEdgeAura', () => {
  it('uses the approved renderer with 5.5x energy and a stable reduced-motion frame', () => {
    let frame!: FrameRequestCallback;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frame = cb;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const context = { clearRect: vi.fn(), setTransform: vi.fn() };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as ReturnType<HTMLCanvasElement['getContext']>,
    );
    render(<JarvisEdgeAura snapshot={{ ...listening, energy: 0.1, active: true }} reducedMotion />);
    frame(0);
    expect(mockRenderer.draw).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ energy: 0.55 }),
      expect.any(Number),
      expect.any(Number),
      0,
      true,
    );
  });

  it('warms the native renderer before reporting readiness while idle remains hidden', () => {
    const order: string[] = [];
    const context = { clearRect: vi.fn(), setTransform: vi.fn() };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as ReturnType<HTMLCanvasElement['getContext']>,
    );
    mockRenderer.warm.mockImplementation(() => order.push('warm'));
    const onRendererWarm = () => order.push('ready');

    render(
      <JarvisEdgeAura
        snapshot={{ ...listening, state: 'idle', energy: 0, active: false, prewarm: true }}
        warmRendererOnMount
        onRendererWarm={onRendererWarm}
      />,
    );

    expect(mockRenderer.warm).toHaveBeenCalledWith(context, window.innerWidth, window.innerHeight);
    expect(order).toEqual(['warm', 'ready']);
    expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-active')).toBe('false');
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it('exposes only a decorative full-window canvas for the active state', () => {
    render(<JarvisEdgeAura snapshot={listening} reducedMotion />);
    const aura = screen.getByTestId('jarvis-edge-aura');
    expect(aura.getAttribute('data-jarvis-ambient-state')).toBe('listening');
    expect(aura.getAttribute('data-energy')).toBe('0.72');
    expect(aura.getAttribute('aria-hidden')).toBe('true');
    expect(aura.querySelector('canvas')).not.toBeNull();
    expect(aura.textContent).toBe('');
  });

  it('keeps idle hidden even when the voice session remains open', () => {
    render(
      <JarvisEdgeAura
        snapshot={{ ...listening, state: 'idle', energy: 0, active: true }}
        reducedMotion
      />,
    );
    const aura = screen.getByTestId('jarvis-edge-aura');
    expect(aura.getAttribute('data-jarvis-ambient-state')).toBe('idle');
    expect(aura.getAttribute('data-active')).toBe('false');
    expect(aura.getAttribute('data-energy')).toBe('0.00');
  });

  it('does not paint a late speaking snapshot after explicit close', () => {
    let frame!: FrameRequestCallback;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frame = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const context = {
      clearRect: vi.fn(),
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      strokeRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as ReturnType<HTMLCanvasElement['getContext']>,
    );
    render(
      <JarvisEdgeAura
        snapshot={{ ...listening, state: 'speaking', active: false }}
        reducedMotion
      />,
    );
    frame(0);
    expect(context.strokeRect).not.toHaveBeenCalled();
    expect(context.stroke).not.toHaveBeenCalled();
    expect(screen.getByTestId('jarvis-edge-aura').getAttribute('data-active')).toBe('false');
  });

  it('stops drawing on idle and resumes when listening returns', () => {
    let next!: FrameRequestCallback;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      next = cb;
      return 1;
    });
    const context = { clearRect: vi.fn(), setTransform: vi.fn() };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(
      context as unknown as ReturnType<HTMLCanvasElement['getContext']>,
    );
    const view = render(<JarvisEdgeAura snapshot={{ ...listening, active: true }} />);
    act(() => next(10));
    view.rerender(<JarvisEdgeAura snapshot={{ ...listening, state: 'idle', active: true }} />);
    mockRenderer.draw.mockClear();
    act(() => next(30));
    expect(mockRenderer.draw).not.toHaveBeenCalled();
    expect(mockRenderer.destroy).toHaveBeenCalled();
    view.rerender(<JarvisEdgeAura snapshot={{ ...listening, active: true }} />);
    act(() => next(50));
    expect(mockRenderer.draw).toHaveBeenCalledTimes(1);
  });

  it('accepts native Rust Option nulls without hiding a live screen-edge Aura', () => {
    const decoded = normalizeAmbientSnapshot({
      ...listening,
      active: true,
      sessionId: null,
      transientUntil: null,
    });
    expect(decoded).toMatchObject({ revision: 4, state: 'listening', energy: 0.72, active: true });
    expect(decoded.transientUntil).toBeUndefined();
    expect(decoded.sessionId).toBeUndefined();
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(
      normalizeAmbientSnapshot({ ...listening, active: false, transientUntil: null }),
    ).toMatchObject({ active: false, revision: 4 });
  });

  it('fails malformed snapshots closed to invisible idle', () => {
    expect(normalizeAmbientSnapshot({ ...listening, energy: 4 })).toMatchObject({
      state: 'idle',
      energy: 0,
    });
    expect(normalizeAmbientSnapshot({ ...listening, prewarm: 'yes' })).toMatchObject({
      state: 'idle',
      energy: 0,
    });
    expect(normalizeAmbientSnapshot(null)).toMatchObject({ state: 'idle', energy: 0 });
  });
});
