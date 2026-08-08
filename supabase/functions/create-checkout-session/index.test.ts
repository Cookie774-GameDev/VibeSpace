import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handlePlanCheckout } from './index.ts';

function makeDeps(): any {
  const sessions: unknown[] = [];
  return {
    sessions,
    config: {
      stripeSecretKey: 'sk_test_unit',
      appBaseUrl: 'https://vibespaceos.com',
      addonPriceIds: {
        starter: 'price_orbit',
        pro: 'price_nova',
        ultra: 'price_singularity',
        apex: 'price_supernova',
      },
    },
    authenticate: async () => ({ id: 'user_123', email: 'user@example.com' }),
    getActiveFeatureSubscription: async () => null,
    getProfile: async () => ({ stripe_customer_id: 'cus_123' }),
    getFamilyDiscount: async () => null,
    retrieveCoupon: async (id: string) => ({
      id,
      valid: true,
      duration: 'forever',
      percent_off: 10,
    }),
    setProfileCustomer: async () => undefined,
    createCustomer: async () => ({ id: 'cus_new' }),
    createSession: async (params: unknown, options: unknown) => {
      sessions.push({ params, options });
      return { url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
    },
  };
}

describe('create plan checkout', () => {
  it('rejects Access-only Spark because Access has its own checkout', async () => {
    const deps = makeDeps();
    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'free' }),
      }),
      deps,
    );
    assert.equal(response.status, 400);
    assert.equal(deps.sessions.length, 0);
  });

  it('creates exactly one server-selected feature-plan subscription', async () => {
    const deps = makeDeps();
    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro', price: 'price_attacker', amount: 1 }),
      }),
      deps,
    );
    assert.equal(response.status, 200);
    const call = deps.sessions[0] as any;
    assert.deepEqual(call.params.line_items, [{ price: 'price_nova', quantity: 1 }]);
    assert.equal(call.params.metadata.plan, 'pro');
    assert.equal(call.params.metadata.product_family, 'feature_plan');
    assert.equal(call.params.metadata.access_product, undefined);
    assert.equal(call.params.metadata.monthly_credits, '27500');
    assert.match(call.options.idempotencyKey, /^plan_checkout:user_123:pro:/);
    assert.doesNotMatch(JSON.stringify(call), /price_attacker/);
  });

  it('applies exactly one verified 10 percent coupon from account consent', async () => {
    const deps = makeDeps();
    deps.config.telemetryCouponId = 'coupon_telemetry_10';
    deps.config.telemetryPolicyVersion = 'telemetry-reward-2026-08-03';
    deps.getProfile = async () => ({
      stripe_customer_id: 'cus_123',
      telemetry_opt_in: true,
      telemetry_policy_version: 'telemetry-reward-2026-08-03',
    });

    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro', coupon: 'coupon_attacker', discount: 99 }),
      }),
      deps,
    );

    assert.equal(response.status, 200);
    const call = deps.sessions[0] as any;
    assert.deepEqual(call.params.discounts, [{ coupon: 'coupon_telemetry_10' }]);
    assert.equal(call.params.allow_promotion_codes, false);
    assert.equal(call.params.metadata.telemetry_reward_percent, '10');
    assert.doesNotMatch(JSON.stringify(call), /coupon_attacker|99/);
  });

  it('fails before Stripe Session creation when the telemetry coupon is not exactly 10 percent forever', async () => {
    const deps = makeDeps();
    deps.config.telemetryCouponId = 'coupon_bad';
    deps.config.telemetryPolicyVersion = 'telemetry-reward-2026-08-03';
    deps.getProfile = async () => ({
      stripe_customer_id: 'cus_123',
      telemetry_opt_in: true,
      telemetry_policy_version: 'telemetry-reward-2026-08-03',
    });
    deps.retrieveCoupon = async () => ({
      id: 'coupon_bad',
      valid: true,
      duration: 'once',
      percent_off: 9,
    });

    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      deps,
    );
    assert.equal(response.status, 503);
    assert.equal(deps.sessions.length, 0);
  });

  it('allows only an authoritative family combined coupon to stack with telemetry', async () => {
    const deps = makeDeps();
    deps.config.telemetryCouponId = 'coupon_telemetry_10';
    deps.config.telemetryPolicyVersion = 'telemetry-reward-2026-08-03';
    deps.getProfile = async () => ({
      stripe_customer_id: 'cus_123',
      telemetry_opt_in: true,
      telemetry_policy_version: 'telemetry-reward-2026-08-03',
    });
    deps.getFamilyDiscount = async () => ({
      familyPercentOff: 20,
      familyCouponId: 'coupon_family_20',
      combinedCouponId: 'coupon_family20_telemetry10',
    });
    deps.retrieveCoupon = async (id: string) => ({
      id,
      valid: true,
      duration: 'forever',
      percent_off: id === 'coupon_family20_telemetry10' ? 28 : 20,
    });

    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      deps,
    );
    assert.equal(response.status, 200);
    assert.deepEqual((deps.sessions[0] as any).params.discounts, [
      { coupon: 'coupon_family20_telemetry10' },
    ]);
  });

  it('authenticates before exposing configuration and never trusts a client idempotency key', async () => {
    const deps = makeDeps();
    deps.config.stripeSecretKey = '';
    const unauthenticated = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      deps,
    );
    assert.equal(unauthenticated.status, 401);

    deps.config.stripeSecretKey = 'sk_test_unit';
    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: {
          authorization: 'Bearer jwt',
          'content-type': 'application/json',
          'idempotency-key': 'attacker-controlled-key',
        },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      deps,
    );
    assert.equal(response.status, 200);
    const call = deps.sessions[0] as any;
    assert.match(call.options.idempotencyKey, /^plan_checkout:user_123:pro:/);
    assert.notEqual(call.options.idempotencyKey, 'attacker-controlled-key');
  });

  it('fails closed on unsafe redirect configuration or a non-Stripe checkout URL', async () => {
    const unsafeRedirect = makeDeps();
    unsafeRedirect.config.appBaseUrl = 'https://attacker.example';
    const redirectResponse = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      unsafeRedirect,
    );
    assert.equal(redirectResponse.status, 500);
    assert.equal(unsafeRedirect.sessions.length, 0);

    const unsafeCheckout = makeDeps();
    unsafeCheckout.createSession = async () => ({ url: 'https://attacker.example/session' });
    const checkoutResponse = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      unsafeCheckout,
    );
    assert.equal(checkoutResponse.status, 502);
    assert.deepEqual(await checkoutResponse.json(), { error: 'checkout_unavailable' });
  });

  it('refuses to create a second feature subscription and directs existing subscribers to portal', async () => {
    const deps = makeDeps();
    deps.getActiveFeatureSubscription = async () => ({
      id: 'sub_existing',
      status: 'active',
      plan: 'starter',
    });

    const response = await handlePlanCheckout(
      new Request('https://edge.test', {
        method: 'POST',
        headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'pro' }),
      }),
      deps,
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'subscription_exists',
      action: 'open_portal',
    });
    assert.equal(deps.sessions.length, 0);
  });

  it('fails closed before Stripe side effects when auth, plan, or config is invalid', async () => {
    const invalidPlan = makeDeps();
    assert.equal(
      (
        await handlePlanCheckout(
          new Request('https://edge.test', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
            body: JSON.stringify({ plan: 'enterprise' }),
          }),
          invalidPlan,
        )
      ).status,
      400,
    );
    assert.equal(invalidPlan.sessions.length, 0);

    const missing = makeDeps();
    missing.config.addonPriceIds.pro = '';
    assert.equal(
      (
        await handlePlanCheckout(
          new Request('https://edge.test', {
            method: 'POST',
            headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
            body: JSON.stringify({ plan: 'pro' }),
          }),
          missing,
        )
      ).status,
      500,
    );
    assert.equal(missing.sessions.length, 0);
  });
});
