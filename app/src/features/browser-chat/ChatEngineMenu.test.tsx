import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('switches between native and Browser Chat without changing the selected model', () => {
    const navigateChat = vi.fn();
    render(<ChatEngineMenu onNavigateChat={navigateChat} />);

    fireEvent.click(screen.getByRole('button', { name: /chat modes/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /browser chat/i }));

    expect(browserChatStore.getState().chatPreferences['chat-browser-mode']?.engine).toBe(
      'browser',
    );
    expect(navigateChat).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /chat modes/i }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /vibespace chat/i }));

    expect(browserChatStore.getState().chatPreferences['chat-browser-mode']?.engine).toBe('native');
    expect(Object.keys(browserChatStore.getState())).not.toContain('modelId');
  });
});
