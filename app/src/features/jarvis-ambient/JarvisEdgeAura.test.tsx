import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JarvisEdgeAura, normalizeAmbientSnapshot } from './JarvisEdgeAura';
import type { JarvisAmbientSnapshot } from './types';

const listening: JarvisAmbientSnapshot = {
  revision: 4,
  state: 'listening',
  source: 'voice',
  observedAt: 100,
  energy: 0.72,
};

describe('JarvisEdgeAura', () => {
  it('paints soft transparent-ended gradients without sharp border strokes', () => {
    let frame!: FrameRequestCallback;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frame = callback; return 1; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const addColorStop = vi.fn();
    const context = {
      clearRect: vi.fn(), setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop })),
      createRadialGradient: vi.fn(() => ({ addColorStop })),
      fillRect: vi.fn(), stroke: vi.fn(),
    };
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement['getContext']>);
    render(<JarvisEdgeAura snapshot={{ ...listening, active: true }} reducedMotion />);
    frame(0);
    expect(context.createLinearGradient).toHaveBeenCalledTimes(4);
    expect(context.createRadialGradient).toHaveBeenCalledTimes(3);
    expect(addColorStop.mock.calls.filter(([offset, color]) => offset === 1 && String(color).endsWith(',0)'))).toHaveLength(7);
    expect(context.stroke).not.toHaveBeenCalled();
  });
  beforeEach(() => {
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

  it('exposes open idle separately from actual listening without fabricated energy', () => {
    render(
      <JarvisEdgeAura
        snapshot={{ ...listening, state: 'idle', energy: 0, active: true }}
        reducedMotion
      />,
    );
    const aura = screen.getByTestId('jarvis-edge-aura');
    expect(aura.getAttribute('data-jarvis-ambient-state')).toBe('idle');
    expect(aura.getAttribute('data-active')).toBe('true');
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

  it('accepts native Rust Option nulls without hiding a live screen-edge Aura', () => {
    const decoded = normalizeAmbientSnapshot({ ...listening, active: true, sessionId: null, transientUntil: null });
    expect(decoded).toMatchObject({ revision: 4, state: 'listening', energy: 0.72, active: true });
    expect(decoded.transientUntil).toBeUndefined();
    expect(decoded.sessionId).toBeUndefined();
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(normalizeAmbientSnapshot({ ...listening, active: false, transientUntil: null })).toMatchObject({ active: false, revision: 4 });
  });

  it('fails malformed snapshots closed to invisible idle', () => {
    expect(normalizeAmbientSnapshot({ ...listening, energy: 4 })).toMatchObject({
      state: 'idle',
      energy: 0,
    });
    expect(normalizeAmbientSnapshot(null)).toMatchObject({ state: 'idle', energy: 0 });
  });
});
