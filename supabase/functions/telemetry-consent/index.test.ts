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
