import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Orb } from './Orb';

function setReducedMotion(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('Orb motion policy', () => {
  beforeEach(() => setReducedMotion(false));

  it('keeps the signal globe still while listening and only speaks from output energy', () => {
    const view = render(<Orb state="listening" presentation="signal-globe" />);
    expect(screen.getByRole('img').getAttribute('data-orb-motion')).toBe('idle');
    view.rerender(<Orb state="speaking" presentation="signal-globe" />);
    expect(screen.getByRole('img').getAttribute('data-orb-motion')).toBe('active');
    expect(screen.getByRole('img').getAttribute('data-speaking')).toBe('true');
  });

  it('keeps idle presentation still and reserves continuous expression for active voice', () => {
    const view = render(<Orb state="idle" />);
    expect(screen.getByRole('img').getAttribute('data-orb-motion')).toBe('idle');

    view.rerender(<Orb state="speaking" />);
    expect(screen.getByRole('img').getAttribute('data-orb-motion')).toBe('active');
  });

  it('disables nonessential movement when reduced motion is requested', () => {
    setReducedMotion(true);
    render(<Orb state="error" />);

    const orb = screen.getByRole('img');
    expect(orb.getAttribute('data-orb-motion')).toBe('reduced');
    expect(orb.style.filter).toContain('hue-rotate(220deg)');
  });

  it('preserves the default painted effects while the monochrome presentation stays flat', () => {
    const view = render(<Orb />);
    const defaultOrb = screen.getByRole('img');
    const defaultLayers = Array.from(defaultOrb.children) as HTMLElement[];

    expect(defaultLayers.some((layer) => layer.style.background.includes('gradient'))).toBe(true);
    expect(defaultLayers.some((layer) => layer.style.filter.includes('blur'))).toBe(true);
    expect(defaultLayers.some((layer) => layer.style.boxShadow.length > 0)).toBe(true);

    view.rerender(<Orb presentation="monochrome-flat" />);
    const flatOrb = screen.getByRole('img');
    const flatLayers = Array.from(flatOrb.children) as HTMLElement[];

    expect(flatOrb.getAttribute('data-orb-presentation')).toBe('monochrome-flat');
    expect(flatLayers).toHaveLength(5);
    for (const layer of flatLayers) {
      expect(layer.style.background).not.toContain('gradient');
      expect(layer.style.backgroundImage).toBe('');
      expect(layer.style.filter).not.toContain('blur');
      expect(layer.style.boxShadow).toBe('');
    }
    expect(flatLayers.some((layer) => layer.style.background.startsWith('hsl('))).toBe(true);
    expect(flatLayers.some((layer) => layer.style.border.length > 0)).toBe(true);
  });

  it('keeps the complete flat orb subtree filter-free under reduced motion', () => {
    setReducedMotion(true);
    render(<Orb state="error" presentation="monochrome-flat" />);

    const flatOrb = screen.getByRole('img');
    const flatTree = [flatOrb, ...Array.from(flatOrb.children)] as HTMLElement[];

    for (const element of flatTree) {
      expect(element.style.background).not.toContain('gradient');
      expect(element.style.backgroundImage).toBe('');
      expect(element.style.filter).toBe('');
      expect(element.style.boxShadow).toBe('');
    }
  });
});
