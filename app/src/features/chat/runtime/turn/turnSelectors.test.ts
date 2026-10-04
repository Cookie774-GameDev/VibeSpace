import { describe, expect, it } from 'vitest';
import { reduceTurn } from './turnReducer';
import { selectAgenticSessionEvidence } from './turnSelectors';
import { summarizeAgenticSession } from '../../agentic-console/projection';

describe('canonical turn session evidence', () => {
  const accepted = () => reduceTurn(undefined, {
    type: 'turn.accepted', at: 1,
    identity: { accountId: 'test', chatId: 'chat', runId: 'run', requestId: 'request', attempt: 1 },
  });

  it('preserves unknown completion after a renderer loses the live owner', () => {
    const turn = reduceTurn(accepted(), { type: 'turn.interrupted', at: 2, reason: 'restored_without_live_owner' });
    const evidence = selectAgenticSessionEvidence(turn);
    expect(evidence).toMatchObject({ status: 'partial', currentOperation: 'Interrupted · outcome unknown' });
    expect(summarizeAgenticSession([], [], evidence).status).toBe('partial');
  });

  it.each(['codex', 'opencode'])('keeps a genuine %s provider error failed', (providerId) => {
    const turn = reduceTurn(accepted(), {
      type: 'provider.error', at: 2,
      error: { message: 'Provider rejected the request.', code: 'provider_rejected', providerId, modelId: 'test-model' },
    });
    const evidence = selectAgenticSessionEvidence(turn);
    expect(evidence).toMatchObject({ status: 'error', currentOperation: 'Provider rejected the request.' });
    expect(summarizeAgenticSession([], [], evidence).status).toBe('error');
  });

  it.each(['codex', 'opencode'])('requires terminal completion evidence for %s', (providerId) => {
    const bound = reduceTurn(accepted(), { type: 'provider.bound', at: 2, provider: { providerId, modelId: 'test-model' } });
    const turn = reduceTurn(bound, { type: 'turn.completed', at: 3 });
    const evidence = selectAgenticSessionEvidence(turn);
    expect(evidence).toMatchObject({ status: 'completed', model: 'test-model' });
    expect(summarizeAgenticSession([], [], evidence).status).toBe('done');
  });
});
