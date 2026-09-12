import { describe, expect, it } from 'vitest';
import {
  mergeJarvisInteractionState,
  migrateJarvisInteractionState,
  serializeJarvisInteractionState,
  useJarvisInteractionStore,
} from './sessionStore';
import type { JarvisChatAgent } from './types';

function agent(agentId: string, status: JarvisChatAgent['status']): JarvisChatAgent {
  return {
    agentId,
    name: `Agent ${agentId}`,
    parentChatId: 'chat_parent',
    childChatId: `chat_${agentId}`,
    task: 'Complete a bounded task',
    modelLabel: 'ollama/llama3.2:latest',
    status,
    currentStep: status === 'done' ? 'Finished' : 'Running in child chat',
    filesTouched: [],
    lockedFiles: [],
    createdAt: '2026-08-08T12:00:00.000Z',
    updatedAt: '2026-08-08T12:01:00.000Z',
  };
}

describe('Jarvis interaction restart persistence', () => {
  it('fails closed for interrupted agents and clears session-only plan approval', () => {
    const activeStatuses = [
      'queued',
      'thinking',
      'planning',
      'asking_question',
      'waiting_permission',
      'editing',
      'testing',
    ] as const;
    const state = {
      modesByChat: { chat_parent: 'agent' as const },
      planSafeApprovalsByChat: { chat_parent: true },
      agentsByChat: {
        chat_parent: [
          ...activeStatuses.map((status) => agent(status, status)),
          agent('done', 'done'),
          agent('failed', 'failed'),
          agent('blocked', 'blocked'),
          agent('cancelled', 'cancelled'),
        ],
      },
    };
    const migrated = migrateJarvisInteractionState(state, 1);
    const serialized = serializeJarvisInteractionState(state);

    for (const persisted of [migrated, serialized]) {
      expect(persisted.modesByChat).toEqual({ chat_parent: 'agent' });
      expect(persisted.planSafeApprovalsByChat).toEqual({});
      expect(
        persisted.agentsByChat.chat_parent?.map(({ agentId, status }) => ({
          agentId,
          status,
        })),
      ).toEqual([
        ...activeStatuses.map((agentId) => ({ agentId, status: 'failed' })),
        { agentId: 'done', status: 'done' },
        { agentId: 'failed', status: 'failed' },
        { agentId: 'blocked', status: 'blocked' },
        { agentId: 'cancelled', status: 'cancelled' },
      ]);
      expect(persisted.agentsByChat.chat_parent?.[0]).toMatchObject({
        currentStep: 'Interrupted by app restart',
        summary: 'This child run did not report a terminal result before VibeSpace restarted.',
        error: 'Interrupted by app restart.',
      });
      expect(persisted.agentsByChat.chat_parent?.[activeStatuses.length]).toMatchObject({
        currentStep: 'Finished',
      });
      expect(persisted.agentsByChat.chat_parent?.[activeStatuses.length]).not.toHaveProperty(
        'summary',
      );
      expect(persisted.agentsByChat.chat_parent?.[activeStatuses.length]).not.toHaveProperty(
        'error',
      );
    }
  });

  it('drops malformed persisted agent rows instead of breaking app startup', () => {
    expect(() =>
      migrateJarvisInteractionState(
        {
          modesByChat: { chat_parent: 'agent' },
          planSafeApprovalsByChat: { chat_parent: true },
          agentsByChat: {
            chat_parent: 'not-an-agent-list',
            chat_other: [null, { status: 'thinking' }],
          },
        },
        1,
      ),
    ).not.toThrow();
    expect(
      migrateJarvisInteractionState({ agentsByChat: { chat_parent: 'not-an-agent-list' } }, 1)
        .agentsByChat,
    ).toEqual({});
  });

  it('sanitizes malformed current-version hydration while preserving store methods', () => {
    const current = useJarvisInteractionStore.getInitialState();

    const merged = mergeJarvisInteractionState(
      {
        modesByChat: { chat_parent: 'invalid-mode' },
        planSafeApprovalsByChat: { chat_parent: true },
        agentsByChat: { chat_parent: 'not-an-agent-list' },
      },
      current,
    );

    expect(merged.modesByChat).toEqual({});
    expect(merged.planSafeApprovalsByChat).toEqual({});
    expect(merged.agentsByChat).toEqual({});
    expect(merged.modeForChat).toBe(current.modeForChat);
    expect(merged.updateAgent).toBe(current.updateAgent);
  });

  it('sanitizes malformed rendered fields and array members in current-version agents', () => {
    const current = useJarvisInteractionStore.getInitialState();
    const malformed = {
      ...agent('done', 'done'),
      currentStep: { text: 'not safe to render' },
      filesRead: ['safe/read.ts', 17, null],
      filesEditing: ['safe/edit.ts', { path: 'unsafe' }],
      diffSummary: { addedLines: 'many', removedLines: 2 },
      filesTouched: ['safe/touched.ts', false],
      lockedFiles: [null, 'safe/locked.ts'],
      summary: ['not', 'a', 'string'],
      error: { message: 'not a string' },
      modelSelection: { mode: 'single', providerId: 'ollama', modelId: '' },
    };

    const merged = mergeJarvisInteractionState(
      {
        modesByChat: { chat_parent: 'agent' },
        agentsByChat: { chat_parent: [malformed] },
      },
      current,
    );
    const expectedAgent = agent('done', 'done');
    delete expectedAgent.currentStep;

    expect(merged.agentsByChat.chat_parent).toEqual([
      {
        ...expectedAgent,
        filesRead: ['safe/read.ts'],
        filesEditing: ['safe/edit.ts'],
        filesTouched: ['safe/touched.ts'],
        lockedFiles: ['safe/locked.ts'],
      },
    ]);
  });

  it('preserves only structurally valid persisted model-selection provenance', () => {
    const current = useJarvisInteractionStore.getInitialState();
    const validSelectionAgent = {
      ...agent('valid-selection', 'done'),
      modelSelection: {
        mode: 'single',
        providerId: 'ollama',
        modelId: '  llama3.2:latest  ',
      },
    };
    const malformedSelectionAgent = {
      ...agent('malformed-selection', 'failed'),
      modelSelection: {
        mode: 'single',
        providerId: 'ollama',
        modelId: '',
      },
    };
    const objectProviderAgent = {
      ...agent('object-provider', 'done'),
      modelSelection: {
        mode: 'single',
        providerId: { id: 'ollama' },
        modelId: 'llama3.2:latest',
      },
    };
    const arrayProviderAgent = {
      ...agent('array-provider', 'done'),
      modelSelection: {
        mode: 'single',
        providerId: ['ollama'],
        modelId: 'llama3.2:latest',
      },
    };

    const merged = mergeJarvisInteractionState(
      {
        agentsByChat: {
          chat_parent: [
            validSelectionAgent,
            malformedSelectionAgent,
            objectProviderAgent,
            arrayProviderAgent,
          ],
        },
      },
      current,
    );

    expect(merged.agentsByChat.chat_parent?.[0]?.modelSelection).toEqual({
      mode: 'single',
      providerId: 'ollama',
      modelId: 'llama3.2:latest',
    });
    expect(merged.agentsByChat.chat_parent?.[1]).not.toHaveProperty('modelSelection');
    expect(merged.agentsByChat.chat_parent?.[2]).not.toHaveProperty('modelSelection');
    expect(merged.agentsByChat.chat_parent?.[3]).not.toHaveProperty('modelSelection');
  });

  it('preserves only string OpenCode session bindings on persisted agent cards', () => {
    const current = useJarvisInteractionStore.getInitialState();
    const valid = {
      ...agent('valid-harness', 'done'),
      harnessSessionId: 'oc-child',
      harnessParentSessionId: 'oc-parent',
    };
    const malformed = {
      ...agent('malformed-harness', 'failed'),
      harnessSessionId: { id: 'oc-child' },
      harnessParentSessionId: ['oc-parent'],
    };

    const merged = mergeJarvisInteractionState(
      { agentsByChat: { chat_parent: [valid, malformed] } },
      current,
    );

    expect(merged.agentsByChat.chat_parent?.[0]).toMatchObject({
      harnessSessionId: 'oc-child',
      harnessParentSessionId: 'oc-parent',
    });
    expect(merged.agentsByChat.chat_parent?.[1]).not.toHaveProperty('harnessSessionId');
    expect(merged.agentsByChat.chat_parent?.[1]).not.toHaveProperty('harnessParentSessionId');
  });
});
