import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_CHATGPT_BROWSER_CHAT_MESSAGE,
  closeExclusiveBrowserChatSurface,
} from './closeExclusiveBrowserChat';

describe('closeExclusiveBrowserChatSurface', () => {
  it('skips confirmation for a native VibeSpace chat', async () => {
    const hideSurface = vi.fn(async () => undefined);
    const retireChat = vi.fn();

    await expect(
      closeExclusiveBrowserChatSurface({
        chatId: 'chat-native',
        engine: 'native',
        hideSurface,
        retireChat,
      }),
    ).resolves.toBe('skipped');
    expect(hideSurface).not.toHaveBeenCalled();
    expect(retireChat).not.toHaveBeenCalled();
  });

  it('asks before closing the ChatGPT screen and can be cancelled', async () => {
    const hideSurface = vi.fn(async () => undefined);
    const retireChat = vi.fn();

    await expect(
      closeExclusiveBrowserChatSurface({
        chatId: 'chat-chatgpt',
        engine: 'browser',
        confirm: () => false,
        hideSurface,
        retireChat,
      }),
    ).resolves.toBe('cancelled');
    expect(hideSurface).not.toHaveBeenCalled();
    expect(retireChat).not.toHaveBeenCalled();
    expect(CLOSE_CHATGPT_BROWSER_CHAT_MESSAGE).toMatch(/entire ChatGPT screen/i);
  });

  it('closes the entire ChatGPT screen after confirmation', async () => {
    const hideSurface = vi.fn(async () => undefined);
    const retireChat = vi.fn();

    await expect(
      closeExclusiveBrowserChatSurface({
        chatId: 'chat-chatgpt',
        engine: 'browser',
        confirm: () => true,
        hideSurface,
        retireChat,
      }),
    ).resolves.toBe('closed');
    expect(hideSurface).toHaveBeenCalledOnce();
    expect(retireChat).toHaveBeenCalledWith('chat-chatgpt');
  });
});
