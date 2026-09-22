import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planTelemetryDiscountRemoval,
  reconcileTelemetryWithdrawal,
  type TelemetrySubscription,
} from './telemetryBillingReconcile.ts';

const familyCoupon = { type: 'coupon' as const, id: 'coupon_family' };
const telemetryCoupon = { type: 'coupon' as const, id: 'coupon_telemetry_10' };
const promotion = { type: 'promotion_code' as const, id: 'promo_family' };

function subscription(overrides: Partial<TelemetrySubscription> = {}): TelemetrySubscription {
  return {
    id: 'sub_feature',
    status: 'active',
    plan: 'pro',
    discounts: [familyCoupon, telemetryCoupon, promotion],
    ...overrides,
  };
}

describe('telemetry withdrawal billing reconciliation', () => {
  it('removes only the known telemetry coupon and preserves family/promotion discounts', () => {
    const plans = planTelemetryDiscountRemoval([subscription()], ['coupon_telemetry_10']);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0].removedDiscountIds, ['coupon_telemetry_10']);
    assert.deepEqual(plans[0].remainingDiscounts, [familyCoupon, promotion]);
    assert.equal(plans[0].prorationBehavior, 'none');
  });

  it('ignores free, inactive, and unknown-discount subscriptions', () => {
    const plans = planTelemetryDiscountRemoval(
      [
        subscription({ id: 'sub_free', plan: 'free' }),
        subscription({ id: 'sub_canceled', status: 'canceled' }),
        subscription({
          id: 'sub_unknown',
          discounts: [{ type: 'unknown', id: 'coupon_telemetry_10' }],
        }),
      ],
      ['coupon_telemetry_10'],
    );
    assert.deepEqual(plans, []);
  });

  it('is retry-safe when a second run sees the already-reconciled subscription', async () => {
    const updated: string[] = [];
    const outbox: string[] = [];
    const dependencies = {
      listFeatureSubscriptions: async () => [subscription()],
      updateSubscription: async (id: string) => updated.push(id),
      markOutbox: async ({ state }: { state: string }) => outbox.push(state),
    };
    const first = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      knownTelemetryCouponIds: ['coupon_telemetry_10'],
      dependencies,
      nowMs: 100,
    });
    const second = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      knownTelemetryCouponIds: ['coupon_telemetry_10'],
      dependencies: {
        ...dependencies,
        listFeatureSubscriptions: async () => [
          subscription({ discounts: [familyCoupon, promotion] }),
        ],
      },
      nowMs: 101,
    });
    assert.equal(first.state, 'reconciled');
    assert.equal(second.state, 'reconciled');
    assert.deepEqual(updated, ['sub_feature']);
    assert.deepEqual(outbox, ['reconciled', 'reconciled']);
  });

  it('records a failed outbox state when a subscription update fails', async () => {
    const outbox: Array<{ state: string; errorCode?: string }> = [];
    const result = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      knownTelemetryCouponIds: ['coupon_telemetry_10'],
      dependencies: {
        listFeatureSubscriptions: async () => [subscription()],
        updateSubscription: async () => {
          throw new Error('stripe unavailable');
        },
        markOutbox: async (update) => outbox.push(update),
      },
      nowMs: 100,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'subscription_reconcile_failed');
    assert.deepEqual(outbox, [
      {
        state: 'failed',
        errorCode: 'subscription_reconcile_failed',
        updatedSubscriptionIds: [],
        attemptedAt: 100,
        userId: 'user-1',
      },
    ]);
  });

  it('reports missing coupon configuration without touching billing', async () => {
    let updates = 0;
    const states: string[] = [];
    const result = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      knownTelemetryCouponIds: [],
      dependencies: {
        listFeatureSubscriptions: async () => [subscription()],
        updateSubscription: async () => {
          updates += 1;
        },
        markOutbox: async ({ state }) => states.push(state),
      },
      nowMs: 100,
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.errorCode, 'telemetry_coupon_configuration_missing');
    assert.equal(updates, 0);
    assert.deepEqual(states, ['failed']);
  });

  it('does not apply a stale withdrawal after consent has been re-enrolled', async () => {
    let updates = 0;
    let receipts = 0;
    const result = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      requestRevision: 'old-revision',
      knownTelemetryCouponIds: ['coupon_telemetry_10'],
      dependencies: {
        listFeatureSubscriptions: async () => [subscription()],
        assertWithdrawalCurrent: async () => false,
        updateSubscription: async () => {
          updates += 1;
        },
        markOutbox: async () => {
          receipts += 1;
        },
      },
      nowMs: 100,
    });
    assert.equal(result.state, 'pending');
    assert.equal(result.errorCode, 'stale_withdrawal_revision');
    assert.equal(updates, 0);
    assert.equal(receipts, 0);
  });

  it('forwards the durable request revision to the reconciled outbox receipt', async () => {
    const receipts: Array<{ state: string; requestRevision?: string }> = [];
    const result = await reconcileTelemetryWithdrawal({
      userId: 'user-1',
      requestRevision: 'revision-1',
      knownTelemetryCouponIds: ['coupon_telemetry_10'],
      dependencies: {
        listFeatureSubscriptions: async () => [subscription()],
        updateSubscription: async () => undefined,
        markOutbox: async (update) => receipts.push(update),
      },
      nowMs: 100,
    });
    assert.equal(result.state, 'reconciled');
    assert.deepEqual(receipts, [
      {
        state: 'reconciled',
        requestRevision: 'revision-1',
        updatedSubscriptionIds: ['sub_feature'],
        attemptedAt: 100,
        userId: 'user-1',
      },
    ]);
  });
});
