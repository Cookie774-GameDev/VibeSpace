import * as React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageRouter } from './PageRouter';
import { useUIStore } from '@/stores/ui';

vi.mock('@/features/terminals/TerminalsPage', () => ({
  TerminalsPage: () => <div data-testid="terminals-page">Terminals live surface</div>,
}));

vi.mock('@/features/schedule', () => ({
  SchedulePage: () => <div data-testid="schedule-page">Schedule</div>,
}));

vi.mock('@/features/chat', () => ({
  ChatView: () => <div data-testid="chat-page">Chat</div>,
}));

describe('PageRouter terminal preservation', () => {
  afterEach(() => {
    useUIStore.getState().resetUI();
  });

  it('keeps the terminal page mounted after switching to another route', async () => {
    useUIStore.getState().setRoute('terminal');
    render(<PageRouter />);

    expect(await screen.findByTestId('terminals-page')).toBeTruthy();

    await act(async () => {
      useUIStore.getState().setRoute('schedule');
    });

    expect(await screen.findByTestId('schedule-page')).toBeTruthy();
    expect(screen.getByTestId('terminals-page')).toBeTruthy();
    expect(
      screen
        .getByTestId('terminals-page')
        .closest('[data-terminal-route-cache]')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');

    await act(async () => {
      useUIStore.getState().setRoute('terminal');
    });

    expect(
      screen
        .getByTestId('terminals-page')
        .closest('[data-terminal-route-cache]')
        ?.getAttribute('aria-hidden'),
    ).toBe('false');
  });
});
