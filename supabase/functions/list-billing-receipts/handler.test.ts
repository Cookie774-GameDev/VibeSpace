import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleBillingReceipts } from './handler.ts';

const invoice = {
  id: 'in_demo',
  customer: 'cus_owner',
  number: 'VS-0001',
  currency: 'usd',
  total: 1234,
  amount_paid: 1234,
  status: 'paid',
  created: 1700000000,
  period_start: 1697000000,
  period_end: 1700000000,
  hosted_invoice_url: 'https://invoice.stripe.com/i/demo',
};
const request = (token = 'unit-token') =>
  new Request('https://example.test/receipts', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ customer: 'cus_attacker' }),
  });
function fixture(overrides = {}) {
  const calls: string[] = [];
  return {
    calls,
    authenticate: async () => ({ id: 'owner' }),
    getProfile: async (id: string) => {
      calls.push(id);
      return { stripe_customer_id: 'cus_owner' };
    },
    listInvoices: async (id: string) => {
      calls.push(id);
      return { data: [invoice] };
    },
    ...overrides,
  };
}
test('authenticates and derives customer only from the server profile', async () => {
  const deps = fixture();
  const result = await handleBillingReceipts(request(), deps);
  assert.equal(result.status, 200);
  assert.deepEqual(deps.calls, ['owner', 'cus_owner']);
  assert.equal((await result.json()).receipts[0].total, 1234);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('denies unsigned requests before reading a profile', async () => {
  const deps = fixture();
  assert.equal((await handleBillingReceipts(request(''), deps)).status, 401);
  assert.deepEqual(deps.calls, []);
});
test('excludes draft invoices, foreign invoices and unsafe links', async () => {
  const deps = fixture({
    listInvoices: async () => ({
      data: [
        { ...invoice, status: 'draft' },
        { ...invoice, customer: 'cus_other' },
        { ...invoice, hosted_invoice_url: 'https://evil.test/' },
      ],
    }),
  });
  const payload = await (await handleBillingReceipts(request(), deps)).json();
  assert.equal(payload.receipts.length, 1);
  assert.equal(payload.receipts[0].url, null);
  assert.equal('customer' in payload.receipts[0], false);
});
test('returns no invented bill for an account without a customer', async () => {
  const deps = fixture({ getProfile: async () => null });
  assert.deepEqual(await (await handleBillingReceipts(request(), deps)).json(), { receipts: [] });
});
test('fails closed on provider errors without returning provider secrets', async () => {
  const deps = fixture({
    listInvoices: async () => {
      throw Error('private diagnostic');
    },
  });
  const result = await handleBillingReceipts(request(), deps);
  assert.equal(result.status, 502);
  assert.equal((await result.text()).includes('private'), false);
});
