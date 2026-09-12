import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleCustomerPortal } from './handler.ts';

function request(token = 'jwt') {
  return new Request('https://functions.test/create-customer-portal', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function deps(overrides: Record<string, unknown> = {}) {
  const calls = { profiles: [] as string[], portals: [] as unknown[] };
  return {
    calls,
    config: {
      stripeSecretKey: 'sk_test_unit',
      appBaseUrl: 'https://vibespaceos.com',
    },
    authenticate: async () => ({ id: 'user_123' }),
    getProfile: async (userId: string) => {
      calls.profiles.push(userId);
      return { stripe_customer_id: 'cus_123' };
    },
    createPortal: async (input: unknown) => {
      calls.portals.push(input);
      return { url: 'https://billing.stripe.com/p/session_123' };
    },
    ...overrides,
  };
}

describe('create customer portal', () => {
  it('resolves the customer by authenticated user and returns a validated Stripe URL', async () => {
    const harness = deps();
    const response = await handleCustomerPortal(request(), harness);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: 'https://billing.stripe.com/p/session_123',
    });
    assert.deepEqual(harness.calls.profiles, ['user_123']);
    assert.deepEqual(harness.calls.portals, [
      { customer: 'cus_123', return_url: 'https://vibespaceos.com/account' },
    ]);
  });

  it('returns no_customer without creating a portal for a never-subscribed user', async () => {
    const harness = deps({ getProfile: async () => null });
    const response = await handleCustomerPortal(request(), harness);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'no_customer' });
    assert.equal(harness.calls.portals.length, 0);
  });

  it('authenticates before revealing billing configuration state', async () => {
    const harness = deps({
      config: { stripeSecretKey: '', appBaseUrl: '' },
    });
    const response = await handleCustomerPortal(request(''), harness);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
    assert.equal(harness.calls.profiles.length, 0);
    assert.equal(harness.calls.portals.length, 0);
  });

  it('fails closed on missing auth, invalid return origin, or non-Stripe portal URL', async () => {
    const unauthenticated = deps();
    assert.equal((await handleCustomerPortal(request(''), unauthenticated)).status, 401);
    assert.equal(unauthenticated.calls.profiles.length, 0);

    const invalidOrigin = deps({
      config: { stripeSecretKey: 'sk_test_unit', appBaseUrl: 'https://attacker.example' },
    });
    assert.equal((await handleCustomerPortal(request(), invalidOrigin)).status, 500);
    assert.equal(invalidOrigin.calls.portals.length, 0);

    const invalidPortal = deps({
      createPortal: async () => ({ url: 'https://attacker.example/steal' }),
    });
    const response = await handleCustomerPortal(request(), invalidPortal);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'portal_unavailable' });

    for (const url of [
      'https://billing.stripe.com:444/p/session_123',
      'https://user:pass@billing.stripe.com/p/session_123',
    ]) {
      const malformedPortal = deps({ createPortal: async () => ({ url }) });
      const malformedResponse = await handleCustomerPortal(request(), malformedPortal);
      assert.equal(malformedResponse.status, 502);
      assert.deepEqual(await malformedResponse.json(), { error: 'portal_unavailable' });
    }
  });
});
