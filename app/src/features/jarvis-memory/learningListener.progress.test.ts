import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startJarvisLearningListener } from './learningListener';
import { useJarvisLearningStore } from './learningStore';

let stop: (() => Promise<void>) | undefined;
beforeEach(() => useJarvisLearningStore.getState().clearForTests());
afterEach(async () => {
  await stop?.();
});

it('retains progress and learning identity across restart before the twenty-message review', async () => {
  let durable: string | null = null;
  const bindings = {
    getAccountId: () => 'progress-account',
    load: async () => durable,
    save: async (_accountId: string, markdown: string) => {
      durable = markdown;
    },
    debounceMs: 0,
  };
  stop = startJarvisLearningListener(bindings);
  window.dispatchEvent(
    new CustomEvent('jarvis:send', {
      detail: {
        chatId: 'task-app',
        messageId: 'first-message',
        text: 'Please keep the task tracker simple and verify persistence before claiming completion.',
      },
    }),
  );
  await vi.waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(1),
  );
  const epoch = useJarvisLearningStore.getState().currentProfile().caoLearningEpoch;
  await stop();
  useJarvisLearningStore.getState().clearForTests();
  stop = startJarvisLearningListener(bindings);
  await vi.waitFor(() =>
    expect(useJarvisLearningStore.getState().currentProfile().meaningfulMessageCount).toBe(1),
  );
  expect(useJarvisLearningStore.getState().currentProfile().caoLearningEpoch).toBe(epoch);
  expect(useJarvisLearningStore.getState().currentProfile().lastEvaluationCount).toBe(0);
});
