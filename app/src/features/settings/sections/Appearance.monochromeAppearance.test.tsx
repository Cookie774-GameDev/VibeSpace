import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SELECTABLE_THEMES } from '@/features/appearance/themes';
import { useUIStore } from '@/stores/ui';
import { Appearance } from './Appearance';

describe('Appearance MonoChrome appearance', () => {
  afterEach(() => {
    cleanup();
    useUIStore.setState({ theme: 'default' });
  });

  it('gates radius, background-image, and shadow under exact monochrome only', () => {
    useUIStore.setState({ theme: 'default' });
    render(<Appearance />);

    const root = document.querySelector<HTMLElement>('.mc7f-settings-appearance');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    expect(className).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');

    const themes = screen.getByRole('radiogroup', { name: 'App theme' });
    const radios = screen.getAllByRole('radio');
    const themeRadios = Array.from(themes.querySelectorAll('[role="radio"]'));
    expect(themeRadios).toHaveLength(SELECTABLE_THEMES.length);
    for (const radio of radios) {
      expect(radio.className).toContain('bg-panel');
    }
    for (const radio of themeRadios) {
      expect(radio.getAttribute('data-monochrome-control-size')).toBe('preserve');
    }
    expect(className).not.toMatch(/gradient|blur/);
  });
});
