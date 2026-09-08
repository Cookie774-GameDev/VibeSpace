import { describe, expect, it, vi } from 'vitest';
const invoke = vi.fn();
vi.mock('@/lib/supabase/client', () => ({ getSupabaseClient: () => ({ functions: { invoke } }) }));
import { fetchBillingReceipts, formatReceiptMoney } from './receipts';

describe('billing receipts', () => {
  it('formats Stripe minor units including zero-decimal currencies', () => {
    expect(formatReceiptMoney(1234, 'usd', 'en-US')).toBe('$12.34');
    expect(formatReceiptMoney(1234, 'jpy', 'en-US')).toBe('¥1,234');
    expect(formatReceiptMoney(12300, 'isk', 'en-US')).toBe('ISK 123');
  });
  it('rejects malformed data and arbitrary outbound URLs', async () => {
    invoke.mockResolvedValue({
      data: {
        receipts: [
          {
            id: 'in_test',
            status: 'paid',
            total: 1,
            paid: 1,
            currency: 'usd',
            created: 1,
            periodStart: 1,
            periodEnd: 2,
            number: '1',
            url: 'https://evil.test',
          },
        ],
      },
      error: null,
    });
    await expect(fetchBillingReceipts()).rejects.toThrow('invalid');
  });
  it('never sends a customer identity from the frontend', async () => {
    invoke.mockResolvedValue({ data: { receipts: [] }, error: null });
    expect(await fetchBillingReceipts()).toEqual([]);
    expect(invoke).toHaveBeenLastCalledWith('list-billing-receipts', { body: {} });
  });
});
