import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { browserChatStore } from './browserChatStore';
import { ChatEngineMenu } from './ChatEngineMenu';
import { useUIStore } from '@/stores/ui';

describe('ChatEngineMenu', () => {
  beforeEach(() => {
    browserChatStore.setState({ engine: 'native', providerId: 'chatgpt', chatPreferences: {} });
    useUIStore.setState({ activeChatId: 'chat-browser-mode' });
  });
  afterEach(cleanup);

  it('delegates selection to the shared transition without changing the selected model', async () => {
    const navigateChat = vi.fn();
    const transitionEngine = vi.fn(async () => ({
      status: 'reused' as const,
      chatId: 'chat-browser-mode',
      engine: 'browser' as const,
    }));
    render(<ChatEngineMenu onNavigateChat={navigateChat} transitionEngine={transitionEngine} />);

    fireEvent.click(screen.getByRole('button', { name: /chat modes/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /browser chat/i }));

    await waitFor(() =>
      expect(transitionEngine).toHaveBeenCalledWith({
        chatId: 'chat-browser-mode',
        targetEngine: 'browser',
      }),
    );
    expect(navigateChat).toHaveBeenCalledOnce();
    expect(Object.keys(browserChatStore.getState())).not.toContain('modelId');
  });

  it('switches into the single existing ChatGPT Browser Chat', async () => {
    const navigateChat = vi.fn();
    const transitionEngine = vi.fn(async () => ({
      status: 'reused' as const,
      chatId: 'chat-chatgpt',
      engine: 'browser' as const,
    }));
    render(<ChatEngineMenu onNavigateChat={navigateChat} transitionEngine={transitionEngine} />);

    fireEvent.click(screen.getByRole('button', { name: /chat modes/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /browser chat/i }));

    await waitFor(() => expect(useUIStore.getState().activeChatId).toBe('chat-chatgpt'));
    expect(navigateChat).toHaveBeenCalledOnce();
  });
});
