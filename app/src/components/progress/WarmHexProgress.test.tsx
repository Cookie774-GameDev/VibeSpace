import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmHexProgress } from './WarmHexProgress';

const context = {
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  lineTo: vi.fn(),
  moveTo: vi.fn(),
  setTransform: vi.fn(),
  fillStyle: '',
};

let resizeCallback: ResizeObserverCallback | null = null;
const observe = vi.fn();
const disconnect = vi.fn();

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe = observe;
  disconnect = disconnect;
  unobserve = vi.fn();
}

function matchMedia(matches: boolean): MediaQueryList {
  return {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
}

describe('WarmHexProgress', () => {
  beforeEach(() => {
    resizeCallback = null;
    observe.mockClear();
    disconnect.mockClear();
    Object.values(context).forEach((value) => {
      if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    vi.stubGlobal('matchMedia', vi.fn(() => matchMedia(false)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders only the controlled bounded value with accessible progress semantics', () => {
    const view = render(
      <WarmHexProgress progress={116.4} label="Building context map" detail="Creating nodes" />,
    );
    const progressbar = screen.getByRole('progressbar', { name: 'Building context map' });

    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText('100%')).toBeTruthy();
    expect(screen.getByText('Creating nodes')).toBeTruthy();

    view.rerender(<WarmHexProgress progress={12.6} label="Building context map" />);
    expect(progressbar.getAttribute('aria-valuenow')).toBe('12.6');
    expect(screen.getByText('13%')).toBeTruthy();
  });

  it('supports compact mode and marks paused progress without scheduling animation', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    render(
      <WarmHexProgress
        progress={42}
        label="Indexing"
        detail="Checkpoint saved"
        mode="compact"
        paused
      />,
    );

    const progressbar = screen.getByRole('progressbar', { name: 'Indexing' });
    expect(progressbar.classList.contains('warm-hex-progress--compact')).toBe(true);
    expect(progressbar.getAttribute('data-paused')).toBe('true');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('42%, paused');
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('labels estimated progress visibly and accessibly without presenting it as exact', () => {
    render(<WarmHexProgress progress={41.6} label="Indexing" mode="compact" paused estimated />);

    const progressbar = screen.getByRole('progressbar', { name: 'Indexing' });
    expect(progressbar.getAttribute('aria-valuetext')).toBe('Approximately 42%, paused');
    expect(screen.getByText('≈ 42%')).toBeTruthy();
  });

  it('renders unknown work as indeterminate without inventing a percentage', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(41);
    render(<WarmHexProgress progress={null} label="Discovering files" />);

    const progressbar = screen.getByRole('progressbar', { name: 'Discovering files' });
    expect(progressbar.hasAttribute('aria-valuenow')).toBe(false);
    expect(progressbar.getAttribute('aria-valuetext')).toBe('Estimating time…');
    expect(progressbar.getAttribute('data-indeterminate')).toBe('true');
    expect(screen.queryByText(/%/u)).toBeNull();
    expect(requestFrame).toHaveBeenCalledOnce();
  });

  it('respects reduced motion and bounds high-DPI backing dimensions on resize', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 4 });
    vi.spyOn(window, 'matchMedia').mockImplementation(() => matchMedia(true));
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<WarmHexProgress progress={55} label="Summarizing" />);
    const canvas = container.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      width: 5_000,
      height: 2_000,
      top: 0,
      right: 5_000,
      bottom: 2_000,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(canvas.width).toBeLessThanOrEqual(2_048);
    expect(canvas.height).toBeLessThanOrEqual(768);
    expect(screen.getByRole('progressbar').getAttribute('data-motion')).toBe('reduced');
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it('animates only the visual shimmer and releases animation and observer resources', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(73);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const view = render(<WarmHexProgress progress={67} label="Warming VibeSpace" />);

    expect(requestFrame).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();

    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(73);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('shows a dense moving field immediately for a new SiYuan map', () => {
    const colors: string[] = [];
    context.fill.mockImplementation(() => { colors.push(context.fillStyle); });
    let nextFrame: FrameRequestCallback | undefined;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame = callback;
      return 91;
    });

    render(<WarmHexProgress progress={0} label="SiYuan map" mode="compact" density="fine" />);
    const firstFrame = colors.slice();
    expect(firstFrame.length).toBeGreaterThan(600);
    expect(nextFrame).toBeDefined();

    act(() => nextFrame?.(1_500));
    expect(colors.slice(firstFrame.length)).not.toEqual(firstFrame);
  });

  it('labels a failed map distinctly and stops its animation', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    render(<WarmHexProgress progress={29} label="SiYuan map" mode="compact" failed paused />);
    const progressbar = screen.getByRole('progressbar', { name: 'SiYuan map' });
    expect(progressbar.getAttribute('data-failed')).toBe('true');
    expect(progressbar.getAttribute('aria-valuetext')).toContain('failed');
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
