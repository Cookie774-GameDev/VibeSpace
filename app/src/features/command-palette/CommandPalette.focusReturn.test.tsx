import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { CommandPalette } from './CommandPalette';
import { usePaletteStore } from './store';

function PaletteHost() {
  const open = useUIStore((state) => state.paletteOpen);
  return (
    <>
      <button type="button" onClick={() => useUIStore.getState().setPaletteOpen(true)}>
        Open command palette
      </button>
      <input aria-label="Chat composer" />
      {open ? <CommandPalette /> : null}
    </>
  );
}

describe('CommandPalette focus return', () => {
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
      useUIStore.setState({ paletteOpen: false });
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

  it('returns focus to the opener after an empty search is cleared and Escape closes', async () => {
    render(<PaletteHost />);
    const opener = screen.getByRole('button', { name: 'Open command palette' });
    opener.focus();
    fireEvent.click(opener);

    const input = screen.getByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: 'a4r8-no-matching-action-7d92' } });
    expect(await screen.findByText('No results found.')).not.toBeNull();
    fireEvent.change(input, { target: { value: '' } });

    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
  });

  it('returns focus to the input that owned a keyboard-opened palette', async () => {
    render(<PaletteHost />);
    const composer = screen.getByRole('textbox', { name: 'Chat composer' });
    composer.focus();
    act(() => useUIStore.getState().setPaletteOpen(true));

    const input = screen.getByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull(),
    );
    expect(document.activeElement).toBe(composer);
  });
});
