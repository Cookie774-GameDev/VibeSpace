import * as React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SakuraBackdrop, SakuraBackdropView } from './SakuraBackdrop';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SakuraBackdropView', () => {
  it('is an inert, untabbable, pointer-free scenic sibling behind app chrome', () => {
    const rendered = render(
      <SakuraBackdropView intensity="open" paused={false} rendering="enhanced" />,
    );
    const backdrop = rendered.container.querySelector('[data-sakura-backdrop]');

    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop?.getAttribute('inert')).toBe('');
    expect(backdrop?.getAttribute('data-sakura-intensity')).toBe('open');
    expect(backdrop?.getAttribute('data-sakura-rendering')).toBe('enhanced');
    expect(backdrop?.getAttribute('data-sakura-paused')).toBe('false');
    expect(backdrop?.getAttribute('class')).toContain('pointer-events-none');
    expect(backdrop?.getAttribute('class')).toContain('inset-0');
    expect(backdrop?.getAttribute('class')).toContain('overflow-hidden');
    expect(backdrop?.getAttribute('class')).toContain('z-0');
    expect(backdrop?.querySelector('[tabindex]')).toBeNull();
    expect(backdrop?.querySelector('[data-sakura-scene]')).not.toBeNull();
    expect(backdrop?.querySelectorAll('[data-sakura-petal]')).toHaveLength(9);
  });

  it('keeps the opaque scene but suppresses atmospheric motion in static mode', () => {
    const rendered = render(<SakuraBackdropView intensity="quiet" paused rendering="static" />);
    const backdrop = rendered.container.querySelector('[data-sakura-backdrop]');

    expect(backdrop?.querySelector('[data-sakura-scene]')).not.toBeNull();
    expect(backdrop?.querySelector('[data-sakura-petal]')).toBeNull();
    expect(backdrop?.getAttribute('data-sakura-paused')).toBe('true');
  });

  it('can disable petals without removing the scenic source', () => {
    const rendered = render(
      <SakuraBackdropView
        intensity="standard"
        paused={false}
        petalsEnabled={false}
        petalSpeed="normal"
        rendering="enhanced"
      />,
    );

    expect(rendered.container.querySelector('[data-sakura-scene]')).not.toBeNull();
    expect(rendered.container.querySelector('[data-sakura-petals]')).toBeNull();
  });

  it('runs one bounded startup probe, pauses across focus loss, and cleans up listeners', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        nextFrame += 1;
        frames.set(nextFrame, callback);
        return nextFrame;
      });
    const cancelFrame = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((id) => void frames.delete(id));
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');

    const rendered = render(<SakuraBackdrop route="chat" />);
    const backdrop = () => rendered.container.querySelector('[data-sakura-backdrop]');
    expect(backdrop()?.getAttribute('data-sakura-rendering')).toBe('static');
    expect(requestFrame).toHaveBeenCalledTimes(1);

    act(() => frames.get(1)?.(10));
    act(() => frames.get(2)?.(38));
    expect(backdrop()?.getAttribute('data-sakura-rendering')).toBe('enhanced');
    expect(requestFrame).toHaveBeenCalledTimes(2);

    focused = false;
    act(() => window.dispatchEvent(new Event('blur')));
    expect(backdrop()?.getAttribute('data-sakura-paused')).toBe('true');
    focused = true;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(backdrop()?.getAttribute('data-sakura-paused')).toBe('false');
    expect(requestFrame).toHaveBeenCalledTimes(2);

    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(backdrop()?.getAttribute('data-sakura-paused')).toBe('true');

    rendered.unmount();
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
    expect(cancelFrame).not.toHaveBeenCalled();
  });

  it('never schedules atmosphere work when reduced motion is active', () => {
    vi.stubGlobal('CSS', { supports: vi.fn(() => true) });
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');

    const rendered = render(<SakuraBackdrop route="chat" />);
    expect(
      rendered.container
        .querySelector('[data-sakura-backdrop]')
        ?.getAttribute('data-sakura-rendering'),
    ).toBe('static');
    expect(rendered.container.querySelector('[data-sakura-petal]')).toBeNull();
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
