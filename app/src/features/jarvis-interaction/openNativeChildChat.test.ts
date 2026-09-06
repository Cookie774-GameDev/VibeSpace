import { beforeEach, expect, it } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { browserChatStore } from '@/features/browser-chat/browserChatStore';
import { openNativeChildChat } from './openNativeChildChat';

beforeEach(() => useUIStore.setState(useUIStore.getInitialState()));

it('opens the exact child as a native task even from a different chat mode', () => {
  useUIStore.setState({ activeChatId: 'parent', route: 'workbench', chatMode: 'code' });
  browserChatStore.getState().setEngine('browser', 'parent');
  openNativeChildChat('child');
  expect(useUIStore.getState()).toMatchObject({
    activeChatId: 'child',
    route: 'chat',
    chatMode: 'chat',
  });
});

it('ignores an unavailable child id instead of clearing the selected conversation', () => {
  useUIStore.setState({ activeChatId: 'parent' });
  openNativeChildChat('  ');
  expect(useUIStore.getState().activeChatId).toBe('parent');
});
