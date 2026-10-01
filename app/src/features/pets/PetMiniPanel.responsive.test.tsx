import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PetMiniPanel } from './PetMiniPanel';
import { usePetPresentationStore } from './petPresentationStore';

vi.mock('./PetChatSurface', () => ({
  PetChatSurface: () => <div data-testid="shared-chat-surface" />,
}));

vi.mock('./PetTerminalSurface', () => ({
  PetTerminalSurface: () => <div data-testid="shared-terminal-surface" />,
}));

vi.mock('./petTauriBridge', () => ({
  hidePetPanel: vi.fn(async () => undefined),
  minimizePetPanel: vi.fn(async () => undefined),
}));

describe('PetMiniPanel responsive shell', () => {
  beforeEach(() => {
    localStorage.clear();
    usePetPresentationStore.setState({
      chats: {},
      terminals: {},
      activity: [],
      activitySeenIds: [],
      unreadActivity: 0,
      panelLifecycle: 'closed',
      panelActiveChatId: null,
      panelActiveTerminalId: null,
      lastLimitMessage: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the compact two-mode header mounted above the active shared surface', () => {
    render(<PetMiniPanel open onClose={vi.fn()} windowMode />);

    expect(screen.getByTestId('pet-panel-header').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByTestId('shared-chat-surface')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminals' })).toBeTruthy();
  });

  it('ignores the legacy collapsed preference and keeps every essential window control accessible', () => {
    localStorage.setItem('vibespace-pet-panel-header-collapsed', '1');

    render(<PetMiniPanel open onClose={vi.fn()} windowMode />);

    expect(screen.getByTestId('pet-panel-header').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Minimize pet panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close pet panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();
  });

  it('exposes density + continuous UI scale hooks without CSS transform on the shell', () => {
    render(<PetMiniPanel open onClose={vi.fn()} windowMode />);

    const panel = screen.getByRole('dialog', { name: 'Pet mini panel' });
    expect(panel.classList.contains('pet-mini-panel-shell')).toBe(true);
    expect(panel.hasAttribute('data-pet-panel-density')).toBe(true);
    expect(panel.hasAttribute('data-pet-ui-scale')).toBe(true);
    // Scale is applied via CSS variables / densification, not transform on the shell.
    expect(panel.getAttribute('style') ?? '').not.toMatch(/(?:^|;)\s*transform:\s*scale\(/);
  });

  it('keeps minimize and close lifecycle states visible for their bounded transitions', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    render(<PetMiniPanel open onClose={onClose} onMinimize={onMinimize} />);

    fireEvent.click(screen.getByRole('button', { name: 'Minimize pet panel' }));
    expect(
      screen
        .getByRole('dialog', { name: 'Pet mini panel' })
        .getAttribute('data-pet-panel-lifecycle'),
    ).toBe('minimizing');
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(160));
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the compact panel focused on only Chat and Terminals', () => {
    render(<PetMiniPanel open onClose={vi.fn()} windowMode />);

    expect(screen.getByRole('button', { name: 'Chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Terminals' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Voice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Terminals' }));
    expect(screen.getByTestId('shared-terminal-surface')).toBeTruthy();
  });
});
