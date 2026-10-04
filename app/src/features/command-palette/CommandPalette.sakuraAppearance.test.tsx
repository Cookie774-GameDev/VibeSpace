import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { CommandPalette } from './CommandPalette';
import { usePaletteStore } from './store';

describe('CommandPalette Sakura appearance', () => {
  const initialUiState = useUIStore.getState();
  const initialPaletteState = usePaletteStore.getState();

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    act(() => {
      useUIStore.setState({ paletteOpen: true });
      usePaletteStore.setState({ pageStack: [], search: '' });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    act(() => {
      useUIStore.setState(initialUiState, true);
      usePaletteStore.setState(initialPaletteState, true);
    });
  });

  it('marks both portal layers as app-owned Sakura chrome', () => {
    render(<CommandPalette />);

    expect(
      screen
        .getByRole('dialog', { name: 'Command palette' })
        .getAttribute('data-vibespace-owned-chrome'),
    ).toBe('command-palette');
    expect(
      document
        .querySelector('[data-sakura-overlay="command-palette"]')
        ?.getAttribute('data-vibespace-owned-chrome'),
    ).toBe('command-palette');
  });

  it('retains keyboard-ready initial focus', async () => {
    render(<CommandPalette />);

    const input = screen.getByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.closest('[data-command-search]')).toBeTruthy();
  });
});
