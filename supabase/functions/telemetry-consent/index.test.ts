import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTelemetryConsent, normalizeStripeDiscounts } from './index.ts';

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
  it('normalizes array and ApiList discount shapes while preserving promotion codes', () => {
    const promotion = {
      id: 'di_promotion',
      coupon: { id: 'coupon_under_promotion' },
      promotion_code: 'promo_123',
    };
    assert.deepEqual(normalizeStripeDiscounts({ data: [promotion, { coupon: 'coupon_123' }] }), [
      { type: 'promotion_code', id: 'promo_123' },
      { type: 'coupon', id: 'coupon_123' },
    ]);
    assert.deepEqual(normalizeStripeDiscounts([{ promotion_code: { id: 'promo_456' } }]), [
      { type: 'promotion_code', id: 'promo_456' },
    ]);
    assert.deepEqual(normalizeStripeDiscounts({ object: 'list', data: [] }), []);
    assert.equal(normalizeStripeDiscounts({ object: 'unexpected' })[0].type, 'unknown');
  });

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

  it('queues withdrawal after the authoritative profile update and exposes reconciliation state', async () => {
    const order: string[] = [];
    const d = deps();
    d.setConsent = async (...args: unknown[]) => {
      order.push(`set:${String(args[1])}`);
      return { enabled: false, policyVersion: POLICY, dataClasses: [], eligible: false };
    };
    d.enqueueWithdrawal = async () => {
      order.push('enqueue');
      return { status: 'pending' };
    };
    d.reconcileWithdrawal = async () => {
      order.push('reconcile');
      return { status: 'reconciled', updatedSubscriptionIds: ['sub_1'] };
    };
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, policyVersion: POLICY, dataClasses: [] }),
      }),
      d,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['set:false', 'enqueue', 'reconcile']);
    assert.equal((await response.json()).withdrawal.status, 'reconciled');
  });

  it('keeps withdrawal visibly pending when durable enqueue fails', async () => {
    const d = deps();
    d.enqueueWithdrawal = async () => {
      throw new Error('database unavailable');
    };
    d.reconcileWithdrawal = async () => {
      throw new Error('must not reconcile before enqueue');
    };
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, policyVersion: POLICY, dataClasses: [] }),
      }),
      d,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).withdrawal, {
      status: 'pending',
      errorCode: 'withdrawal_enqueue_pending',
    });
  });

  it('retries an existing pending withdrawal on account state reads', async () => {
    const d = deps();
    d.getConsent = async () => ({
      enabled: false,
      policyVersion: POLICY,
      dataClasses: [],
      eligible: false,
      withdrawal: { status: 'pending', attemptCount: 1 },
    });
    let retries = 0;
    d.reconcileWithdrawal = async () => {
      retries += 1;
      return { status: 'reconciled', updatedSubscriptionIds: [] };
    };
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', { headers: { authorization: 'Bearer jwt' } }),
      d,
    );
    assert.equal(response.status, 200);
    assert.equal(retries, 1);
    assert.equal((await response.json()).withdrawal.status, 'reconciled');
  });

  it('uses an atomic consent/outbox result when the production dependency provides it', async () => {
    const d = deps();
    const order: string[] = [];
    d.atomicWithdrawal = true;
    d.setConsent = async () => {
      order.push('atomic-set');
      return {
        enabled: false,
        policyVersion: POLICY,
        dataClasses: [],
        eligible: false,
        withdrawal: { status: 'pending', requestRevision: 'revision-1' },
      };
    };
    d.enqueueWithdrawal = async () => {
      order.push('wrong-non-atomic-enqueue');
      return { status: 'pending' };
    };
    d.reconcileWithdrawal = async (userId: string, revision: string) => {
      order.push(`${userId}:${revision}`);
      return { status: 'reconciled' };
    };
    const response = await handleTelemetryConsent(
      new Request('https://edge.test', {
        method: 'PUT',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, policyVersion: POLICY, dataClasses: [] }),
      }),
      d,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(order, ['atomic-set', 'user_123:revision-1']);
  });
});

const EXPANDED_POLICY = 'telemetry-app-diagnostics-2026-10-05-v1';
const EXPANDED_SCOPE = 'app-diagnostics-v1';
const getRequest = () =>
  new Request('https://edge.test', { headers: { authorization: 'Bearer jwt' } });
const putRequest = (body: unknown) =>
  new Request('https://edge.test', {
    method: 'PUT',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const expandedBody = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  policyVersion: EXPANDED_POLICY,
  dataClasses: CLASSES,
  diagnosticsScope: EXPANDED_SCOPE,
  ...extra,
});
const expandedDeps = () => {
  const d = deps();
  d.config = { ...d.config, policyVersion: EXPANDED_POLICY, appDiagnosticsScope: EXPANDED_SCOPE };
  return d;
};
describe('explicit expanded diagnostics consent', () => {
  it('does not advertise expanded capability by default or infer accepted policy from its offer', async () => {
    const state = await (await handleTelemetryConsent(getRequest(), deps())).json();
    assert.equal(state.policyVersion, POLICY);
    assert.equal(state.acceptedPolicyVersion, null);
    assert.equal(state.diagnosticsScope, null);
    assert.equal(state.acceptedDiagnosticsScope, null);
    assert.deepEqual(state.supportedSchemaVersions, [1]);
  });
  it('keeps an old enrollment distinct from the newly offered policy', async () => {
    const d = expandedDeps();
    d.getConsent = async () => ({
      enabled: true,
      eligible: true,
      policyVersion: POLICY,
      dataClasses: CLASSES,
    });
    const state = await (await handleTelemetryConsent(getRequest(), d)).json();
    assert.equal(state.policyVersion, EXPANDED_POLICY);
    assert.equal(state.acceptedPolicyVersion, POLICY);
    assert.equal(state.diagnosticsScope, EXPANDED_SCOPE);
    assert.equal(state.acceptedDiagnosticsScope, null);
    assert.deepEqual(state.supportedSchemaVersions, [1, 2]);
  });
  it('requires the explicit expanded marker from a fresh client before mutation', async () => {
    for (const marker of [undefined, null, '', 'PRIVATE_SENTINEL']) {
      const d = expandedDeps();
      const response = await handleTelemetryConsent(
        putRequest(expandedBody({ diagnosticsScope: marker })),
        d,
      );
      assert.equal(response.status, 400);
      assert.equal(d.writes.length, 0);
      assert.equal(JSON.stringify(await response.json()).includes('PRIVATE_SENTINEL'), false);
    }
  });
  it('does not activate a reserved new policy without explicit capability or relabel an old policy', async () => {
    for (const config of [
      { policyVersion: EXPANDED_POLICY },
      { policyVersion: EXPANDED_POLICY, appDiagnosticsScope: 'unknown-scope' },
      { policyVersion: POLICY, appDiagnosticsScope: EXPANDED_SCOPE },
    ]) {
      const d = deps();
      d.config = { ...d.config, ...config };
      const response = await handleTelemetryConsent(
        putRequest(expandedBody({ policyVersion: config.policyVersion })),
        d,
      );
      assert.equal(response.status, 400);
      assert.equal(d.writes.length, 0);
      const state = await (await handleTelemetryConsent(getRequest(), d)).json();
      assert.equal(state.diagnosticsScope, null);
      assert.deepEqual(state.supportedSchemaVersions, [1]);
    }
  });
  it('persists fresh explicit expanded consent through the existing atomic writer', async () => {
    const d = expandedDeps();
    d.atomicWithdrawal = true;
    d.enqueueWithdrawal = async () => {
      assert.fail('must not create another withdrawal');
    };
    d.reconcileWithdrawal = async () => {
      assert.fail('opt-in must not reconcile billing');
    };
    const response = await handleTelemetryConsent(putRequest(expandedBody()), d);
    assert.equal(response.status, 200);
    assert.deepEqual(d.writes, [['user_123', true, EXPANDED_POLICY, CLASSES]]);
    const state = await response.json();
    assert.equal(state.acceptedPolicyVersion, EXPANDED_POLICY);
    assert.equal(state.acceptedDiagnosticsScope, EXPANDED_SCOPE);
  });
  it('allows a marker-free withdrawal even when the expanded capability has been disabled', async () => {
    const d = deps();
    d.config.policyVersion = EXPANDED_POLICY;
    const response = await handleTelemetryConsent(
      putRequest({ enabled: false, policyVersion: EXPANDED_POLICY, dataClasses: [] }),
      d,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(d.writes, [['user_123', false, EXPANDED_POLICY, []]]);
    assert.equal((await response.json()).acceptedDiagnosticsScope, null);
  });
  it('rejects private or unknown consent fields without persisting them', async () => {
    const d = expandedDeps();
    const response = await handleTelemetryConsent(
      putRequest(expandedBody({ rawError: 'PRIVATE_SENTINEL' })),
      d,
    );
    assert.equal(response.status, 400);
    assert.equal(d.writes.length, 0);
    assert.equal(JSON.stringify(await response.json()).includes('PRIVATE_SENTINEL'), false);
  });
});

it('allows a previously enrolled client to withdraw after the offered policy changes', async () => {
  const d = expandedDeps();
  const response = await handleTelemetryConsent(
    putRequest({ enabled: false, policyVersion: POLICY, dataClasses: [] }),
    d,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(d.writes, [['user_123', false, EXPANDED_POLICY, []]]);
  assert.equal((await response.json()).acceptedDiagnosticsScope, null);
});
