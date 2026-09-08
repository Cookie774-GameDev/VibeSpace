import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startJarvisLearningListener } from './learningListener';
import { useJarvisLearningStore } from './learningStore';
let stop: (() => Promise<void>) | undefined;
beforeEach(() => useJarvisLearningStore.getState().clearForTests());
afterEach(async () => { await stop?.(); });
it('learns persisted user control commands without sending another provider request', async () => {
  const send = vi.fn(); window.addEventListener('jarvis:send', send);
  const save = vi.fn(async () => {});
  try {
    stop = startJarvisLearningListener({ getAccountId: () => 'command-account', load: async () => null, save, debounceMs: 0 });
    window.dispatchEvent(new CustomEvent('jarvis:user-command', { detail: { chatId: 'chat-1', messageId: 'command-1', text: 'CAO diagnose chat:task-tracker', origin: 'user' } }));
    await vi.waitFor(() => expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(1));
    window.dispatchEvent(new CustomEvent('jarvis:user-command', { detail: { chatId: 'chat-1', text: 'CAO-generated instructions are not a user preference.', origin: 'cao' } }));
    await stop(); stop = undefined;
    expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(1);
    expect(save).toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  } finally { window.removeEventListener('jarvis:send', send); }
});
