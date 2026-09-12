import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { SettingsModal } from './SettingsModal';

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => false,
}));

describe('SettingsModal theme isolation', () => {
  const initialUiState = useUIStore.getState();

  afterEach(() => {
    act(() => useUIStore.setState(initialUiState, true));
  });

  it('keeps Warm-only artwork out of non-Warm Settings layout', () => {
    act(() => useUIStore.setState({ settingsOpen: true }));
    render(<SettingsModal initialTab="appearance" />);

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    const decorations = document.querySelectorAll<HTMLElement>('[data-warm-decoration]');
    expect(Array.from(decorations, (decoration) => decoration.dataset.warmDecoration)).toEqual([
      'settings-scene',
      'settings-wash',
    ]);
    for (const decoration of decorations) {
      expect(decoration.className).toContain('hidden');
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
