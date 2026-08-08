import { beforeEach, describe, expect, it } from 'vitest';
import { useBrowserStore } from './browserStore';
import type { BrowserReviewedAction } from './browserTypes';

function record(index = 1): BrowserReviewedAction {
  return {
    id: `action-${index}`,
    accountId: 'account-a',
    requester: {
      kind: 'agent',
      agent: { id: 'agent-1' as never, slug: 'jarvis', builtin: true },
      runId: 'run-1',
    },
    kind: 'browser.click',
    actionVersion: 1,
    origin: 'https://example.test',
    tabId: 'tab-1',
    frameId: 'frame-1',
    target: {
      currentUrl: 'https://example.test/start',
      selector: '#continue',
      coordinates: { x: 10, y: 20 },
    },
    parameters: { selector: '#continue', x: 10, y: 20 },
    parametersHash: 'a'.repeat(64),
    reviewedHash: 'b'.repeat(64),
    expectedEffect: 'Interact with the selected page control.',
    risk: 'confirm',
    safeSummary: 'Browser click requires review.',
    status: 'pending',
    requestedAt: 100,
    expiresAt: 200,
  };
}

describe('browser reviewed-action store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useBrowserStore.setState({ agentActions: [], agentArmed: false });
  });

  it('stores the complete reviewed record without reconstructing fields', () => {
    const action = record();
    expect(useBrowserStore.getState().enqueueAgentAction(action)).toBe(action.id);
    expect(useBrowserStore.getState().agentActions).toEqual([action]);
  });

  it('allows only pending records to settle once', () => {
    useBrowserStore.getState().enqueueAgentAction(record(1));
    useBrowserStore.getState().resolveAgentAction('action-1', 'denied', 'Denied by user.');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'denied',
      result: 'Denied by user.',
    });

    useBrowserStore
      .getState()
      .resolveAgentAction('action-1', 'unavailable', 'Must not overwrite terminal state.');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'denied',
      result: 'Denied by user.',
    });

    useBrowserStore.getState().enqueueAgentAction(record(2));
    useBrowserStore.getState().resolveAgentAction('action-2', 'expired');
    expect(useBrowserStore.getState().agentActions[0]?.status).toBe('expired');

    useBrowserStore.getState().enqueueAgentAction(record(3));
    useBrowserStore.getState().resolveAgentAction('action-3', 'unavailable');
    expect(useBrowserStore.getState().agentActions[0]?.status).toBe('unavailable');

    useBrowserStore.getState().enqueueAgentAction(record(4));
    useBrowserStore.getState().resolveAgentAction('action-4', 'completed');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'completed',
      result: 'Approved browser operation completed and was observed.',
    });

    useBrowserStore.getState().enqueueAgentAction(record(5));
    useBrowserStore.getState().resolveAgentAction('action-5', 'failed');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'failed',
      result: 'Canonical browser operation failed before verified settlement.',
    });

    useBrowserStore.getState().enqueueAgentAction(record(6));
    useBrowserStore.getState().resolveAgentAction('action-6', 'cancelled');
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      status: 'cancelled',
      result: 'Browser operation was cancelled before verified settlement.',
    });
  });

  it('does not resurrect a terminal record when its ID is re-enqueued', () => {
    useBrowserStore.getState().enqueueAgentAction(record(1));
    useBrowserStore.getState().resolveAgentAction('action-1', 'denied', 'Denied by user.');
    useBrowserStore.getState().setAgentArmed(false);

    useBrowserStore.getState().enqueueAgentAction({
      ...record(1),
      parameters: { selector: '#changed' },
      parametersHash: 'c'.repeat(64),
      reviewedHash: 'd'.repeat(64),
    });

    expect(useBrowserStore.getState().agentActions).toHaveLength(1);
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({
      id: 'action-1',
      status: 'denied',
      result: 'Denied by user.',
      parameters: { selector: '#continue', x: 10, y: 20 },
    });
    expect(useBrowserStore.getState().agentArmed).toBe(false);
  });

  it('denies pending records when local browser agent work is stopped', () => {
    useBrowserStore.getState().enqueueAgentAction(record(1));
    useBrowserStore.getState().abortAgentActions();
    expect(useBrowserStore.getState().agentActions[0]).toMatchObject({ status: 'denied' });
    expect(useBrowserStore.getState().agentArmed).toBe(false);
  });

  it('bounds reviewed records to the newest 100', () => {
    for (let index = 0; index < 105; index += 1) {
      useBrowserStore.getState().enqueueAgentAction(record(index));
    }
    const actions = useBrowserStore.getState().agentActions;
    expect(actions).toHaveLength(100);
    expect(actions[0]?.id).toBe('action-104');
    expect(actions.at(-1)?.id).toBe('action-5');
  });

  it('excludes reviewed records from persistence', () => {
    useBrowserStore.getState().enqueueAgentAction(record());
    const partialize = useBrowserStore.persist.getOptions().partialize;
    const persisted = partialize?.(useBrowserStore.getState()) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('agentActions');
    expect(JSON.stringify(persisted)).not.toContain('action-1');
  });
});
