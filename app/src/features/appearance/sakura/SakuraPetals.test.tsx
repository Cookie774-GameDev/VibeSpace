import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { resolveSakuraPetalProfile, SAKURA_PETAL_COUNT, SakuraPetals } from './SakuraPetals';

describe('SakuraPetals', () => {
  it('renders a stable bounded field without JS animation work', () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const interval = vi.spyOn(window, 'setInterval');
    const rendered = render(<SakuraPetals paused={false} />);
    const petals = rendered.container.querySelectorAll('[data-sakura-petal]');

    expect(SAKURA_PETAL_COUNT).toBe(12);
    expect(petals).toHaveLength(9);
    expect(Array.from(petals, (petal) => petal.getAttribute('data-sakura-petal'))).toEqual(
      Array.from({ length: 9 }, (_, index) => String(index + 1)),
    );
    expect(requestFrame).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it('pauses as state and removes the field entirely for static rendering', () => {
    const rendered = render(<SakuraPetals paused />);
    expect(rendered.container.firstElementChild?.getAttribute('data-sakura-paused')).toBe('true');

    rendered.rerender(<SakuraPetals paused={false} staticMode />);
    expect(rendered.container.firstElementChild).toBeNull();
  });

  it('resolves one authoritative sparse density and duration profile for every speed', () => {
    expect(resolveSakuraPetalProfile('slow')).toEqual({ count: 7, durationMultiplier: 1.45 });
    expect(resolveSakuraPetalProfile('normal')).toEqual({ count: 9, durationMultiplier: 1 });
    expect(resolveSakuraPetalProfile('fast')).toEqual({ count: 12, durationMultiplier: 0.65 });

    const rendered = render(<SakuraPetals paused={false} speed="slow" />);
    const field = rendered.container.querySelector('[data-sakura-petals]');
    const fieldElement = field as HTMLElement;

    expect(field?.getAttribute('data-sakura-speed')).toBe('slow');
    expect(field?.getAttribute('aria-hidden')).toBe('true');
    expect(fieldElement.style.getPropertyValue('--sakura-petal-speed-multiplier')).toBe('1.45');
    expect(field?.querySelectorAll('[data-sakura-petal]')).toHaveLength(7);

    rendered.rerender(<SakuraPetals paused={false} speed="fast" />);
    expect(fieldElement.style.getPropertyValue('--sakura-petal-speed-multiplier')).toBe('0.65');
    expect(field?.querySelectorAll('[data-sakura-petal]')).toHaveLength(12);
  });
});
