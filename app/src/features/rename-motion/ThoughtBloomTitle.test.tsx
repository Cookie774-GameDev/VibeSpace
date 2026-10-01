import * as React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThoughtBloomTitle } from './ThoughtBloomTitle';

const originalGetContext = HTMLCanvasElement.prototype.getContext;

function setReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
}

describe('ThoughtBloomTitle', () => {
  beforeEach(() => {
    setReducedMotion(false);
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const context = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillStyle: '',
    } as unknown as CanvasRenderingContext2D;
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => context,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    cleanup();
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('exposes the title once semantically while keeping its visual stage layout-stable', () => {
    render(<ThoughtBloomTitle title="Research roadmap" />);

    expect(screen.getAllByText('Research roadmap')).toHaveLength(1);
    expect(screen.getByTestId('thought-bloom-stage').getAttribute('data-thought-bloom-state')).toBe(
      'idle',
    );
  });

  it('starts one decorative canvas transition for an observed title change', () => {
    const view = render(<ThoughtBloomTitle title="Old title" />);

    view.rerender(<ThoughtBloomTitle title="New title" />);

    expect(screen.getByText('New title').classList.contains('sr-only')).toBe(true);
    expect(screen.getByTestId('thought-bloom-stage').getAttribute('data-thought-bloom-state')).toBe(
      'blooming',
    );
    expect(screen.getByTestId('thought-bloom-particles').getAttribute('aria-hidden')).toBe('true');
  });

  it('settles immediately without temporary animation layers for reduced motion', () => {
    setReducedMotion(true);
    const view = render(<ThoughtBloomTitle title="Old title" />);

    view.rerender(<ThoughtBloomTitle title="Accessible title" />);

    expect(screen.getAllByText('Accessible title')).toHaveLength(1);
    expect(screen.getByTestId('thought-bloom-stage').getAttribute('data-thought-bloom-state')).toBe(
      'idle',
    );
    expect(screen.queryByTestId('thought-bloom-particles')).toBeNull();
  });

  it('makes the newest observed rename authoritative when a run is interrupted', () => {
    const view = render(<ThoughtBloomTitle title="One" />);

    view.rerender(<ThoughtBloomTitle title="Two" />);
    view.rerender(<ThoughtBloomTitle title="Three" />);

    expect(screen.getByText('Three').classList.contains('sr-only')).toBe(true);
    expect(
      screen.queryAllByText('Two').some((element) => element.classList.contains('sr-only')),
    ).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('bounds temporary character layers while preserving the complete authoritative title', () => {
    const longTitle = 'A'.repeat(120);
    const view = render(<ThoughtBloomTitle title="Short" />);

    view.rerender(<ThoughtBloomTitle title={longTitle} />);

    expect(screen.getByText(longTitle).classList.contains('sr-only')).toBe(true);
    expect(document.querySelectorAll('[data-thought-bloom-old-char]').length).toBeLessThanOrEqual(
      72,
    );
  });
});
