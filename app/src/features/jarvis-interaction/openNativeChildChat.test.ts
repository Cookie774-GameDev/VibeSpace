import { beforeEach, expect, it } from 'vitest';
import { useUIStore } from '@/stores/ui';
import { OPEN_CHILD_CHAT_PANEL_EVENT, openNativeChildChat } from './openNativeChildChat';

beforeEach(() => useUIStore.setState(useUIStore.getInitialState()));

it('opens the exact child in its parent side panel without changing the top-level chat', () => {
  useUIStore.setState({ activeChatId: 'parent', route: 'workbench', chatMode: 'code' });
  const requests: CustomEvent<{ childChatId: string; parentChatId?: string }>[] = [];
  const listen = (event: Event) =>
    requests.push(event as CustomEvent<{ childChatId: string; parentChatId?: string }>);
  window.addEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, listen);
  try {
    openNativeChildChat('child', 'parent');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.detail).toEqual({ childChatId: 'child', parentChatId: 'parent' });
    expect(useUIStore.getState()).toMatchObject({
      activeChatId: 'parent',
      route: 'workbench',
      chatMode: 'code',
    });
  } finally {
    window.removeEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, listen);
  }
});

it('ignores an unavailable child id instead of clearing the selected conversation', () => {
  useUIStore.setState({ activeChatId: 'parent' });
  let requested = false;
  const listen = () => {
    requested = true;
  };
  window.addEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, listen);
  openNativeChildChat('  ', 'parent');
  window.removeEventListener(OPEN_CHILD_CHAT_PANEL_EVENT, listen);
  expect(requested).toBe(false);
  expect(useUIStore.getState().activeChatId).toBe('parent');
});
