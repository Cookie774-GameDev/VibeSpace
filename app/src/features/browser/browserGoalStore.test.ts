import { describe, expect, it, vi } from 'vitest';

import { createBrowserGoalStore, type BrowserGoalChatSnapshot } from './browserGoalStore';

function snapshot(patch: Partial<BrowserGoalChatSnapshot> = {}): BrowserGoalChatSnapshot {
  return {
    schemaVersion: 1,
    chatId: 'chat-1',
    goalId: 'goal-1',
    accountId: 'account-1',
    projectId: 'project-1',
    runId: 'run-1',
    objective: 'Complete the reviewed browser workflow.',
    state: 'active',
    tokenMode: 'normal',
    providerId: 'openai',
    modelId: 'gpt-5',
    completedActions: 1,
    totalActions: 3,
    checkpointSequence: 1,
    checkpointState: 'running',
    checkpointCreatedAt: 1_000,
    cursorExpiresAt: 10_000,
    evidenceRefs: ['jlive_browser_1'],
    providerArtifactRefs: [],
    ...patch,
  };
}

describe('browser goal store', () => {
  it('publishes immutable bounded snapshots and notifies subscribers', () => {
    const store = createBrowserGoalStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.publish(snapshot());

    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot('chat-1')).toMatchObject({
      state: 'active',
      providerId: 'openai',
      modelId: 'gpt-5',
    });
    expect(Object.isFrozen(store.getSnapshot('chat-1'))).toBe(true);
    expect(Object.isFrozen(store.getSnapshot('chat-1')?.evidenceRefs)).toBe(true);
  });

  it('rejects provider/model identity changes and checkpoint rollback', () => {
    const store = createBrowserGoalStore();
    store.publish(snapshot());

    expect(() => store.publish(snapshot({ modelId: 'other-model' }))).toThrow(/identity/i);
    expect(() => store.publish(snapshot({ checkpointSequence: 0 }))).toThrow(
      /invalid browser goal/i,
    );
  });

  it('rejects malformed rendered fields and terminal-state rollback', () => {
    const store = createBrowserGoalStore();
    expect(() => store.publish(snapshot({ currentOrigin: 'javascript:alert(1)' }))).toThrow(
      /invalid browser goal/i,
    );

    store.publish(snapshot({ state: 'completed' }));
    expect(() => store.publish(snapshot({ state: 'active', checkpointSequence: 2 }))).toThrow(
      /identity/i,
    );
  });
});
