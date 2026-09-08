import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BillingReceipts } from './BillingReceipts';
import type { BillingReceipt } from '@/lib/billing/receipts';
const receipt: BillingReceipt = {
  id: 'in_test',
  number: 'VS-0001',
  currency: 'usd',
  total: 1234,
  paid: 1234,
  status: 'paid',
  created: 1700000000,
  periodStart: 1697000000,
  periodEnd: 1700000000,
  url: null,
};
describe('billing receipt printer', () => {
  it('requires cloud sign-in and does not invent a receipt', () => {
    const load = vi.fn();
    render(<BillingReceipts accountId={null} load={load} />);
    expect(screen.getByText(/Sign in to view/)).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
  });
  it('renders actual totals and offers the completed period bill', async () => {
    render(<BillingReceipts accountId="owner" load={async () => [receipt]} />);
    expect(await screen.findByText('VS-0001')).toBeTruthy();
    expect(screen.getAllByText('$12.34')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'View final bill' }));
    expect(screen.getByRole('article', { name: 'Invoice VS-0001' })).toBeTruthy();
  });
  it('does not show a previous account response after switching accounts', async () => {
    let resolve!: (value: readonly BillingReceipt[]) => void;
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      )
      .mockResolvedValue([]);
    const { rerender } = render(<BillingReceipts accountId="first" load={load} />);
    rerender(<BillingReceipts accountId="second" load={load} />);
    await act(async () => {
      resolve([receipt]);
    });
    await waitFor(() => expect(screen.getByText(/No finalized invoices/)).toBeTruthy());
    expect(screen.queryByText('VS-0001')).toBeNull();
  });
  it('refreshes payment status on an existing invoice', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ ...receipt, status: 'open', paid: 0 }])
      .mockResolvedValue([receipt]);
    render(<BillingReceipts accountId="owner" load={load} />);
    expect(await screen.findByText('INVOICE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh invoices' }));
    expect(await screen.findByText('PAYMENT RECEIPT')).toBeTruthy();
  });
});
