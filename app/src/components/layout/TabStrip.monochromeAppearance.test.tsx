import * as React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { liveChats } = vi.hoisted(() => ({
  liveChats: {
    current: [{ id: 'chat-1', title: 'Example chat', pinned: false }],
  },
}));

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => liveChats.current,
}));

vi.mock('@/stores/ui', () => ({
  useUIStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeChatId: 'chat-1',
      route: 'chat',
      setActiveChat: vi.fn(),
      setRoute: vi.fn(),
      setChatMode: vi.fn(),
    }),
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

describe('TabStrip MonoChrome appearance', () => {
  afterEach(() => {
    cleanup();
    liveChats.current = [{ id: 'chat-1', title: 'Example chat', pinned: false }];
  });

  it('keeps the themed strip outside a named group of sibling selection and close buttons', () => {
    render(<TabStrip />);

    const tabGroup = screen.getByRole('group', { name: 'Open chats' });
    const themedStrip = tabGroup.parentElement;
    expect(themedStrip?.getAttribute('data-monochrome-surface')).toBe('tab-strip');
    expect(themedStrip?.className).toContain('bg-panel');
    expect(themedStrip?.className).not.toMatch(/gradient|blur|shadow/);

    const tab = screen.getByRole('button', { name: /^Example chat/ });
    const tabItem = tab.parentElement;
    const close = screen.getByRole('button', { name: 'Close Example chat' });
    expect(tab.getAttribute('aria-pressed')).toBe('true');
    expect(tabItem?.className).toContain('motion-reduce:!transform-none');
    expect(tabItem?.className).toContain('motion-reduce:!opacity-100');
    expect(close.parentElement).toBe(tabItem);

    expect(Array.from(tabGroup.children)).toEqual([tabItem]);
    expect(within(tabGroup).queryByRole('button', { name: 'New chat' })).toBeNull();

    const newChat = screen.getByRole('button', { name: 'New chat' });
    expect(themedStrip?.contains(newChat)).toBe(true);

    fireEvent.contextMenu(tab);
    const tabMenu = screen.getByRole('menu');
    expect(tabGroup.contains(tabMenu)).toBe(false);
    expect(
      Array.from(tabGroup.children).every((child) => child.querySelector('button[aria-pressed]')),
    ).toBe(true);
  });

  it('shows a usable empty state without inventing an empty group or selection button', () => {
    liveChats.current = [];

    render(<TabStrip />);

    const emptyState = screen.getByText('No chats in this project yet.');
    const themedStrip = emptyState.closest('[data-monochrome-surface="tab-strip"]');

    expect(themedStrip).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Open chats' })).toBeNull();
    expect(screen.queryByRole('button', { pressed: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'New chat' })).not.toBeNull();
  });
});
