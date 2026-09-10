import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxoMotion } from './AxoMotion';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AXO activity lifecycle', () => {
  it('pauses outside the viewport and disconnects its observer when removed', () => {
    let notify!: IntersectionObserverCallback;
    const disconnect = vi.fn();
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { notify = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const view = render(<AxoMotion activity="working" />);
    const sprite = view.container.querySelector('svg')!;
    expect(observe.mock.calls[0]?.[0] === sprite).toBe(true);
    act(() => notify([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(sprite.dataset.paused).toBe('true');
    act(() => notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(sprite.dataset.paused).toBe('false');
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('pauses in a hidden document without changing the real activity state', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const view = render(<AxoMotion activity="working" />);
    hidden.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const sprite = view.container.querySelector('svg')!;
    expect(sprite.dataset.paused).toBe('true');
    expect(sprite.dataset.axoMotion).toBe('working');
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(sprite.dataset.paused).toBe('false');
  });

  it('does not replay saved completion or focus on mount', () => {
    const view = render(<AxoMotion activity="success" focusToken={4} />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
  });

  it('acknowledges a live completion once and settles', () => {
    vi.useFakeTimers();
    const view = render(<AxoMotion activity="working" />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('working');
    view.rerender(<AxoMotion activity="success" />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('success');
    act(() => {
      vi.advanceTimersByTime(1400);
    });
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
  });

  it('stops work immediately on cancellation or error without celebration', () => {
    const view = render(<AxoMotion activity="working" />);
    view.rerender(<AxoMotion activity="error" />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
    view.rerender(<AxoMotion activity="success" />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
  });

  it('restarts a focus flourish on a new selection without a stale timer ending it', () => {
    vi.useFakeTimers();
    const view = render(<AxoMotion focusToken={0} />);
    view.rerender(<AxoMotion focusToken={1} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    view.rerender(<AxoMotion focusToken={2} />);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('focus');
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
  });

  it('cancels the flourish when a lower effort replaces the selection', () => {
    const view = render(<AxoMotion focusToken={0} />);
    view.rerender(<AxoMotion focusToken={1} />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('focus');
    view.rerender(<AxoMotion focusToken={0} />);
    expect(view.container.querySelector('svg')?.dataset.axoMotion).toBe('idle');
  });
});
