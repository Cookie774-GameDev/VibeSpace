import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { AppearanceQuickSwitch } from './AppearanceQuickSwitch';
import { useUIStore } from '@/stores/ui';
import { RELEASE_THEME_DEFINITIONS } from '@/features/appearance/themeContract.generated';

describe('AppearanceQuickSwitch', () => {
  beforeEach(() => {
    useUIStore.getState().setTheme('default');
  });

  it('exposes every release appearance without dropping Warm', () => {
    render(<AppearanceQuickSwitch />);
    for (const theme of RELEASE_THEME_DEFINITIONS) {
      expect(screen.getByRole('button', { name: theme.label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Warm' })).toBeTruthy();
  });

  it('applies the selected release theme through the canonical store', () => {
    render(<AppearanceQuickSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Warm' }));
    expect(useUIStore.getState().theme).toBe('warm');
    expect(screen.getByRole('button', { name: 'Warm' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps every appearance choice at the shared 24px header pointer target', () => {
    const { rerender } = render(<AppearanceQuickSwitch />);
    for (const theme of RELEASE_THEME_DEFINITIONS) {
      const button = screen.getByRole('button', { name: theme.label });
      expect(button.className, theme.label).toContain('min-h-6');
      expect(button.className, theme.label).toContain('min-w-6');
    }

    rerender(<AppearanceQuickSwitch compact />);
    for (const theme of RELEASE_THEME_DEFINITIONS) {
      const button = screen.getByRole('button', { name: theme.label });
      expect(button.className, theme.label).toContain('min-h-6');
      expect(button.className, theme.label).toContain('min-w-6');
    }
  });
});
