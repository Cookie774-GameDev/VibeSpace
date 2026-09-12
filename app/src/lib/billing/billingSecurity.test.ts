import { describe, expect, it, vi } from 'vitest';

import {
  buildCheckoutIdempotencyKey,
  buildSubscriptionRpcArgs,
  buildUsageIdempotencyKey,
  hasUniqueConfiguredPrices,
  planForPriceMapping,
} from '../../../../supabase/functions/_shared/billingSecurity';
import {
  buildMessageReservationEstimate,
  reserveBoundedCallUsage,
  reserveMeteredUsage,
  settleMeteredUsage,
} from '../../../../supabase/functions/_shared/metering';
import { PLAN_LIMITS } from '../../../../supabase/functions/_shared/budget';
import { PLAN_BUDGET_USD } from '../../../../supabase/functions/_shared/voice';

describe('billing Edge Function security helpers', () => {
  it('fails closed when Stripe price configuration is ambiguous', () => {
    const duplicatePrices = {
      starter: 'price_shared',
      pro: 'price_shared',
      ultra: 'price_ultra',
      apex: 'price_apex',
    } as const;
    expect(hasUniqueConfiguredPrices(duplicatePrices)).toBe(false);
    expect(planForPriceMapping('price_shared', duplicatePrices)).toBeNull();

    const uniquePrices = { ...duplicatePrices, pro: 'price_pro' } as const;
    expect(hasUniqueConfiguredPrices(uniquePrices)).toBe(true);
    expect(planForPriceMapping('price_pro', uniquePrices)).toBe('pro');
  });

  it('normalizes a Stripe subscription into the transactional RPC shape', () => {
    expect(buildSubscriptionRpcArgs({
      eventId: 'evt_123',
      eventType: 'customer.subscription.updated',
      eventCreated: 1_725_000_000,
      customerId: 'cus_123',
      plan: 'pro',
      subscription: {
        id: 'sub_123',
        status: 'active',
        current_period_start: 1_724_000_000,
        current_period_end: 1_726_000_000,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_pro' } }] },
      },
    })).toEqual({
      p_event_id: 'evt_123',
      p_event_type: 'customer.subscription.updated',
      p_event_created_at: '2024-08-30T06:40:00.000Z',
      p_customer_id: 'cus_123',
      p_subscription_id: 'sub_123',
      p_status: 'active',
      p_plan: 'pro',
      p_price_id: 'price_pro',
      p_period_start: '2024-08-18T16:53:20.000Z',
      p_period_end: '2024-09-10T20:26:40.000Z',
      p_cancel_at_period_end: false,
    });
  });

  it('accepts a bounded safe request idempotency key', () => {
    expect(buildCheckoutIdempotencyKey(
      'checkout-request_123456',
      'user-1',
      'starter',
      1_725_000_000_000,
    )).toBe('checkout:user-1:starter:checkout-request_123456');
  });

  it('isolates Stripe idempotency keys by account and plan', () => {
    const candidate = 'checkout-request_123456';
    const userA = buildCheckoutIdempotencyKey(candidate, 'user-a', 'starter');
    const userB = buildCheckoutIdempotencyKey(candidate, 'user-b', 'starter');
    const otherPlan = buildCheckoutIdempotencyKey(candidate, 'user-a', 'pro');
    expect(new Set([userA, userB, otherPlan]).size).toBe(3);
    expect(userA.length).toBeLessThanOrEqual(255);
  });

  it('replaces control sequences and malformed keys with a stable time bucket', () => {
    const fallback = buildCheckoutIdempotencyKey(
      'unsafe\r\nstripe-header',
      'user-1',
      'starter',
      1_725_000_000_000,
    );
    expect(fallback).toBe('checkout:user-1:starter:5750000');
    expect(fallback).not.toContain('\r');
    expect(fallback).not.toContain('\n');
  });

  it('namespaces safe usage keys and rejects control-sequence candidates', () => {
    expect(buildUsageIdempotencyKey('sms', 'usage-request_123456'))
      .toBe('sms:usage-request_123456');
    const generated = buildUsageIdempotencyKey('sms', 'unsafe\r\nrequest');
    expect(generated).toMatch(/^sms:[A-Za-z0-9-]+$/);
    expect(generated).not.toContain('\r');
    expect(generated).not.toContain('\n');
  });

  it('reserves and settles through the idempotent ledger RPCs', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: { ok: true, reservation_id: 'res-1', remaining_usd: 1 },
        error: null,
      })
      .mockResolvedValueOnce({ data: { ok: true, status: 'settled' }, error: null });
    const client = { rpc };

    await expect(reserveMeteredUsage(client, {
      userId: 'user-1',
      kind: 'message',
      estimateUsd: 0.1,
      idempotencyKey: 'message:req-1',
      context: { provider: 'deepseek', model: 'deepseek-chat' },
    })).resolves.toMatchObject({ ok: true, reservationId: 'res-1' });
    await expect(settleMeteredUsage(client, {
      userId: 'user-1',
      reservationId: 'res-1',
      actualUsd: 0.08,
      status: 'settled',
    })).resolves.toBe(true);
    expect(rpc.mock.calls[0]?.[0]).toBe('reserve_usage_budget');
    expect(rpc.mock.calls[1]?.[0]).toBe('settle_usage_budget');
  });

  it('fails closed when the metering database call fails', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'db' } }) };
    await expect(reserveMeteredUsage(client, {
      userId: 'user-1', kind: 'sms', estimateUsd: 0.01, idempotencyKey: 'sms:req-1',
    })).resolves.toEqual({ ok: false, reason: 'usage_unavailable' });
  });

  it('caps provider call time to the largest duration atomically reserved by the server', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { limited: false, count: 1 }, error: null })
      .mockResolvedValueOnce({
        data: { ok: false, reason: 'window_5h_exceeded', remaining_usd: 0.25 },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          reservation_id: 'res-2',
          reserved_usd: 0.25,
          reserved_count: 150,
          duplicate: false,
        },
        error: null,
      });

    await expect(reserveBoundedCallUsage({ rpc }, {
      userId: 'user-1',
      idempotencyKey: 'call:req-1',
      maxSeconds: 1_800,
      minSeconds: 60,
      costPerSecondUsd: 0.1 / 60,
      rateLimitWindowStart: '2026-07-13T13:00:00.000Z',
      rateLimitMaxRequests: 3,
      context: { provider: 'twilio' },
    })).resolves.toMatchObject({
      ok: true,
      reservationId: 'res-2',
      reservedCount: 150,
    });

    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]?.[0]).toBe('voice_rate_limit_hit');
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_count: 1_800, p_estimate_usd: 3 });
    expect(rpc.mock.calls[2]?.[1].p_count).toBe(150);
    expect(rpc.mock.calls[2]?.[1].p_estimate_usd).toBeCloseTo(0.25, 8);
  });

  it('fails closed before reserving when the call request rate is exceeded', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { limited: true, count: 4 }, error: null });
    await expect(reserveBoundedCallUsage({ rpc }, {
      userId: 'user-1',
      idempotencyKey: 'call:req-rate-limit',
      maxSeconds: 1_800,
      minSeconds: 60,
      costPerSecondUsd: 0.1 / 60,
      rateLimitWindowStart: '2026-07-13T13:00:00.000Z',
      rateLimitMaxRequests: 3,
    })).resolves.toEqual({ ok: false, reason: 'rate_limited' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('caps completion tokens to the exact amount included in a reservation', () => {
    expect(buildMessageReservationEstimate(4_000, 9_999, 1_200, 2_048)).toEqual({
      promptTokens: 1_000,
      completionTokens: 2_048,
      estimatedCostUsd: (1_000 * 0.14 / 1_000_000) + (2_048 * 0.28 / 1_000_000),
    });
    expect(buildMessageReservationEstimate(4_000, undefined, 800, 800).completionTokens)
      .toBe(800);
  });

  it('keeps the server fallback mirrors aligned with the canonical plan table', () => {
    expect(PLAN_LIMITS.ultra).toEqual({
      messageBudgetUsd: 14.85,
      callBudgetUsd: 14.025,
      smsBudgetUsd: 4.125,
      messageCredits: 14850,
      callMinutes: 140,
      smsCount: 412,
    });
    expect(PLAN_BUDGET_USD.apex).toBe(40);
  });
});
