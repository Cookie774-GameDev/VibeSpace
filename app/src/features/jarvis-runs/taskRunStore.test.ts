import { beforeEach, describe, expect, it } from 'vitest';

import type { ChatActivityEvent } from '@/features/chat/activity/types';
import type { JarvisTaskRunProjection } from '@/lib/jarvis/executionJournal/legacyTaskRunAdapter';

import { type JarvisTaskRun, useJarvisTaskRunStore } from './taskRunStore';

const NOW = '2026-07-19T07:00:00.000Z';

function legacyRun(id: string, goal = 'Historical task'): JarvisTaskRun {
  return {
    id,
    chatId: 'chat-alpha',
    goal,
    status: 'waiting-for-input',
    steps: [
      {
        id: 'step-one',
        action: 'status.read',
        label: 'Read status',
        input: {},
        recoverable: true,
        status: 'waiting',
      },
    ],
    progress: 50,
    activeAgents: ['stale-agent'],
    activeTerminals: ['stale-terminal'],
    userVisibleSummary: 'Historical summary',
    startedAt: NOW,
    updatedAt: NOW,
  };
}

function canonicalProjection(
  runId: string,
  overrides: Partial<JarvisTaskRunProjection> = {},
): JarvisTaskRunProjection {
  return {
    canonical: true,
    runId,
    chatId: 'chat-alpha',
    status: 'running',
    goal: 'Canonical task',
    userVisibleSummary: 'Canonical summary',
    progress: 40,
    activeAgents: ['agent-alpha'],
    activeTerminals: [],
    updatedAt: NOW,
    cancellable: true,
    transportRetryAvailable: false,
    ...overrides,
  };
}

function activity(id: string): ChatActivityEvent {
  return {
    id,
    chatId: 'chat-alpha',
    kind: 'agent',
    status: 'running',
    title: 'Jarvis activity',
    detail: 'Safe activity',
    ts: Date.parse(NOW),
  };
}

describe('Jarvis task run read-only view store', () => {
  beforeEach(() => useJarvisTaskRunStore.getState().clearForTests());

  it('exposes only account-scoped presentation and test-clearing actions', () => {
    expect(Object.keys(useJarvisTaskRunStore.getState()).sort()).toEqual([
      'accountScope',
      'activityByChat',
      'clearForTests',
      'manualRecoveryByRun',
      'recordManualRecovery',
      'replaceCanonicalForAccount',
      'replaceLegacyForAccount',
      'runs',
      'setAccountScope',
    ]);
    for (const forbidden of [
      'addRun',
      'patchRun',
      'updateStep',
      'removeRun',
      'recoverInterruptedRuns',
      'cancelRun',
    ]) {
      expect(useJarvisTaskRunStore.getState()).not.toHaveProperty(forbidden);
    }
  });

  it('clears prior projections synchronously when the account scope changes', () => {
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceCanonicalForAccount('scope-alpha', [canonicalProjection('jrun-alpha')], {
      'chat-alpha': [activity('event-alpha')],
    });

    useJarvisTaskRunStore.getState().setAccountScope('scope-beta');

    expect(useJarvisTaskRunStore.getState()).toMatchObject({
      accountScope: 'scope-beta',
      runs: {},
      activityByChat: {},
    });
  });

  it('ignores stale account replacements and makes legacy rows detached and non-executable', () => {
    const legacy = legacyRun('legacy-alpha');
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceLegacyForAccount('scope-beta', [legacy]);
    expect(useJarvisTaskRunStore.getState().runs).toEqual({});

    store.replaceLegacyForAccount('scope-alpha', [legacy]);
    legacy.goal = 'mutated after replacement';
    legacy.activeAgents.push('mutated-agent');

    expect(useJarvisTaskRunStore.getState().runs['legacy-alpha']).toEqual({
      canonical: false,
      runId: 'legacy-alpha',
      chatId: 'chat-alpha',
      status: 'waiting-for-input',
      goal: 'Historical task',
      userVisibleSummary: 'Historical summary',
      progress: 50,
      activeAgents: [],
      activeTerminals: [],
      updatedAt: NOW,
      cancellable: false,
      transportRetryAvailable: false,
    });
  });

  it('lets canonical rows win ID collisions while retaining unrelated legacy history', () => {
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceLegacyForAccount('scope-alpha', [
      legacyRun('shared-id', 'Legacy collision'),
      legacyRun('legacy-only', 'Legacy only'),
    ]);
    store.replaceCanonicalForAccount(
      'scope-alpha',
      [canonicalProjection('shared-id'), canonicalProjection('canonical-only')],
      { 'chat-alpha': [activity('event-alpha')] },
    );

    const state = useJarvisTaskRunStore.getState();
    expect(Object.keys(state.runs).sort()).toEqual(['canonical-only', 'legacy-only', 'shared-id']);
    expect(state.runs['shared-id']).toMatchObject({ canonical: true, goal: 'Canonical task' });
    expect(state.runs['legacy-only']).toMatchObject({ canonical: false, goal: 'Legacy only' });
    expect(state.activityByChat['chat-alpha']?.map((item) => item.id)).toEqual(['event-alpha']);
  });

  it('replaces canonical projections and activity atomically without retaining stale rows', () => {
    const store = useJarvisTaskRunStore.getState();
    store.setAccountScope('scope-alpha');
    store.replaceCanonicalForAccount('scope-alpha', [canonicalProjection('first')], {
      'chat-alpha': [activity('first-event')],
    });
    store.replaceCanonicalForAccount(
      'scope-alpha',
      [canonicalProjection('second', { chatId: 'chat-beta' })],
      { 'chat-beta': [{ ...activity('second-event'), chatId: 'chat-beta' }] },
    );

    const state = useJarvisTaskRunStore.getState();
    expect(Object.keys(state.runs)).toEqual(['second']);
    expect(state.activityByChat).toEqual({
      'chat-beta': [expect.objectContaining({ id: 'second-event' })],
    });
  });
});


describe('manual recovery presentation ownership', () => {
  beforeEach(() => useJarvisTaskRunStore.getState().clearForTests());

  it('retains an interrupted outcome across canonical refresh without changing lifecycle truth', () => {
    const state = useJarvisTaskRunStore.getState();
    state.setAccountScope('scope-a');
    state.recordManualRecovery('scope-a', 'account-a', 'run-a');
    state.replaceCanonicalForAccount('scope-a', [canonicalProjection('run-a')], {});
    expect(useJarvisTaskRunStore.getState().manualRecoveryByRun['run-a']).toEqual({ accountId: 'account-a', runId: 'run-a' });
    expect(useJarvisTaskRunStore.getState().runs['run-a'].status).toBe('running');
    state.setAccountScope('scope-b');
    state.recordManualRecovery('scope-a', 'account-a', 'run-a');
    expect(useJarvisTaskRunStore.getState().manualRecoveryByRun).toEqual({});
  });
});
