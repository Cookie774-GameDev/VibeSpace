import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { liveChats, ui } = vi.hoisted(() => ({
  liveChats: {
    current: [
      {
        id: 'chat-1',
        title: 'A very long conversation label that must yield before the close control',
        pinned: false,
      },
    ],
  },
  ui: {
    activeChatId: 'chat-1',
    route: 'chat',
    setActiveChat: vi.fn(),
    setRoute: vi.fn(),
    setChatMode: vi.fn(),
  },
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => liveChats.current,
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: typeof ui) => unknown) => selector(ui),
}));

vi.mock('@/stores/auth', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      workspaceId: 'workspace-1',
      projectId: null,
      setProjectId: vi.fn(),
    }),
}));

vi.mock('@/lib/hotkeys', () => ({
  HOTKEYS: { NEW_TAB: 'Mod+T', CLOSE_TAB: 'Mod+W' },
  useBoundHotkey: vi.fn(),
  useHotkey: vi.fn(),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Hint: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/features/chat/chatLifecycle', () => ({
  ensureActiveChat: vi.fn(),
}));

vi.mock('@/features/pets/petPresentationStore', () => ({
  usePetPresentationStore: { getState: vi.fn() },
}));

vi.mock('@/features/pets/petSettingsStore', () => ({
  usePetSettingsStore: { getState: vi.fn() },
}));

import { TabStrip } from './TabStrip';

describe('TabStrip Sakura shell contract', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('keeps a long active tab keyboard-operable while preserving its close target', () => {
    render(<TabStrip />);

    const strip = screen.getByRole('group', { name: 'Open chats' }).parentElement;
    const tab = screen.getByRole('button', {
      name: /^A very long conversation label/,
    });
    const label = screen.getByText(
      'A very long conversation label that must yield before the close control',
    );
    const close = screen.getByRole('button', { name: /Close A very long conversation label/ });

    expect(strip?.getAttribute('data-sakura-shell-region')).toBe('tab-strip');
    expect(tab.getAttribute('tabindex')).toBe('0');
    expect(tab.getAttribute('aria-pressed')).toBe('true');
    expect(label.className).toContain('truncate');
    expect(close.className).toContain('min-h-6');
    expect(close.className).toContain('min-w-6');

    fireEvent.keyDown(tab, { key: 'Enter' });
    expect(ui.setActiveChat).toHaveBeenCalledWith('chat-1');
  });
});
