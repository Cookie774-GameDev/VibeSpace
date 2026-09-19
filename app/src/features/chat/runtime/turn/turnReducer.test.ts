import { describe, expect, it } from 'vitest';
import { reduceTurn } from './turnReducer';
import type { TurnIdentity } from './turnTypes';

const identity: TurnIdentity = {
  accountId: 'account-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  chatId: 'chat-1',
  runId: 'run-1',
  requestId: 'request-1',
  attempt: 1,
};

describe('canonical turn reducer', () => {
  it('keeps one monotonic terminal state and interrupts pending tools atomically', () => {
    let state = reduceTurn(undefined, { type: 'turn.accepted', identity, at: 1 });
    state = reduceTurn(state, { type: 'turn.running', at: 2 });
    state = reduceTurn(state, {
      type: 'public.snapshot',
      at: 3,
      snapshot: {
        text: 'Working',
        updatedAt: 3,
        segments: [
          { kind: 'text', id: 'text-1', text: 'Working' },
          { kind: 'tool', id: 'call-1', name: 'read', status: 'started' },
        ],
      },
    });
    state = reduceTurn(state, {
      type: 'provider.error',
      at: 4,
      error: {
        message: 'Provider is busy.',
        code: 'rate_limit',
        providerId: 'openai',
        modelId: 'gpt-test',
        retryable: true,
      },
    });

    expect(state.status).toBe('failed');
    expect(state.reasoning).toBe('');
    expect(state.error?.message).toBe('Provider is busy.');
    expect(state.public.segments[1]).toMatchObject({ status: 'interrupted' });

    const late = reduceTurn(state, {
      type: 'public.snapshot',
      at: 5,
      snapshot: { text: 'late', segments: [], updatedAt: 5 },
    });
    expect(late).toBe(state);
  });

  it('binds provider and context plan once without changing model quality settings', () => {
    let state = reduceTurn(undefined, { type: 'turn.accepted', identity, at: 1 });
    state = reduceTurn(state, {
      type: 'provider.bound',
      at: 2,
      provider: {
        connectionId: 'opencode-go',
        providerId: 'opencode-go',
        modelId: 'deepseek-v4-flash-vision-exp',
        sessionId: 'session-1',
      },
    });
    state = reduceTurn(state, {
      type: 'turn.context_planned',
      at: 3,
      plan: {
        mode: 'rlm',
        rlmEnabled: true,
        citationsRequired: true,
        recursiveChildCallsAllowed: true,
        activePaths: ['src'],
      },
    });

    expect(state.provider).toMatchObject({
      connectionId: 'opencode-go',
      modelId: 'deepseek-v4-flash-vision-exp',
    });
    expect(state.contextPlan).toMatchObject({
      mode: 'rlm',
      rlmEnabled: true,
      citationsRequired: true,
    });
    expect(Object.isFrozen(state.contextPlan?.activePaths)).toBe(true);
  });

  it('rejects rebinding one run to a different request', () => {
    const state = reduceTurn(undefined, { type: 'turn.accepted', identity, at: 1 });
    expect(() =>
      reduceTurn(state, {
        type: 'turn.accepted',
        identity: { ...identity, requestId: 'request-2' },
        at: 2,
      }),
    ).toThrow('turn_identity_rebind_rejected');
  });
});
