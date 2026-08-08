import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTelemetryConsent } from './index.ts';

const POLICY = 'telemetry-reward-2026-08-03';
const CLASSES = ['product_usage', 'diagnostics', 'tool_outcomes'];

function deps() {
  const writes: unknown[] = [];
  return {
    writes,
    config: {
      policyVersion: POLICY,
      noticeUrl: 'https://vibespaceos.com/privacy/financial-incentive',
    },
    authenticate: async () => ({ id: 'user_123' }),
    getConsent: async () => ({
      enabled: false,
      policyVersion: null,
      dataClasses: [],
      eligible: false,
    }),
    setConsent: async (...args: unknown[]) => {
      writes.push(args);
      return {
        enabled: Boolean(args[1]),
        policyVersion: args[2],
        dataClasses: args[3],
        eligible: Boolean(args[1]),
      };
    },
  };
}

describe('telemetry consent', () => {
  it('authenticates before returning account reward state', async () => {
    const d = deps();
    d.authenticate = async () => null as never;
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', { headers: { authorization: 'Bearer bad' } }),
      d,
    );
    assert.equal(response.status, 401);
  });

  it('requires current policy and every disclosed class for reward enrollment', async () => {
    const d = deps();
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          policyVersion: POLICY,
          dataClasses: CLASSES.slice(0, 2),
        }),
      }),
      d,
    );
    assert.equal(response.status, 400);
    assert.equal(d.writes.length, 0);
  });

  it('records exact opt-in and allows immediate withdrawal', async () => {
    const d = deps();
    const optIn = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, policyVersion: POLICY, dataClasses: CLASSES }),
      }),
      d,
    );
    assert.equal(optIn.status, 200);
    assert.deepEqual(d.writes[0], ['user_123', true, POLICY, CLASSES]);

    const withdrawal = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, policyVersion: POLICY, dataClasses: [] }),
      }),
      d,
    );
    assert.equal(withdrawal.status, 200);
    assert.deepEqual(d.writes[1], ['user_123', false, POLICY, []]);
  });
});
