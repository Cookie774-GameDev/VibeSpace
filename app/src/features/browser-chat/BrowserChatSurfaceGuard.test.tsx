import * as React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUIStore } from '@/stores/ui';
import { browserChatStore } from './browserChatStore';
import {
  BrowserChatSurfaceGuard,
  shouldShowBrowserChatSurface,
} from './BrowserChatSurfaceGuard';

describe('BrowserChatSurfaceGuard', () => {
  beforeEach(async () => {
    useUIStore.setState({ route: 'chat', activeChatId: null });
    await browserChatStore.persist.rehydrate();
    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('derives visibility from the immediate route and selected chat engine', () => {
    expect(
      shouldShowBrowserChatSurface({ route: 'chat', engine: 'browser', chatId: 'chat-1' }),
    ).toBe(true);
    expect(shouldShowBrowserChatSurface({ route: 'files', engine: 'browser', chatId: 'chat-1' })).toBe(
      false,
    );
    expect(shouldShowBrowserChatSurface({ route: 'chat', engine: 'native', chatId: 'chat-1' })).toBe(
      false,
    );
    expect(shouldShowBrowserChatSurface({ route: 'chat', engine: 'browser', chatId: null })).toBe(
      false,
    );
  });

  it('hides native provider children immediately when the route leaves Browser Chat', async () => {
    useUIStore.setState({ route: 'chat', activeChatId: 'chat-browser' });
    browserChatStore.setState({
      engine: 'native',
      chatPreferences: { 'chat-browser': { engine: 'browser', providerId: 'chatgpt' } },
    });
    const runtime = { hideAll: vi.fn(async () => undefined) };
    render(<BrowserChatSurfaceGuard runtime={runtime} />);

    expect(runtime.hideAll).not.toHaveBeenCalled();

    act(() => useUIStore.setState({ route: 'terminal' }));
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
  });

  it('hides when the active chat switches back to the native engine', async () => {
    useUIStore.setState({ route: 'chat', activeChatId: 'chat-browser' });
    browserChatStore.setState({
      engine: 'native',
      chatPreferences: { 'chat-browser': { engine: 'browser', providerId: 'chatgpt' } },
    });
    const runtime = { hideAll: vi.fn(async () => undefined) };
    render(<BrowserChatSurfaceGuard runtime={runtime} />);

    act(() =>
      browserChatStore.setState({
        chatPreferences: { 'chat-browser': { engine: 'native', providerId: 'chatgpt' } },
      }),
    );
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
  });

  it('hides on the default chat page even if a global Browser Chat engine was persisted', async () => {
    useUIStore.setState({ route: 'chat', activeChatId: null });
    browserChatStore.setState({ engine: 'browser', chatPreferences: {} });
    const runtime = { hideAll: vi.fn(async () => undefined) };
    render(<BrowserChatSurfaceGuard runtime={runtime} />);
    await waitFor(() => expect(runtime.hideAll).toHaveBeenCalledOnce());
  });
});
