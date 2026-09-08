import { getSupabaseClient } from '@/lib/supabase/client';
export type BillingReceipt = Readonly<{
  id: string;
  number: string | null;
  currency: string;
  total: number;
  paid: number;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
  created: number;
  periodStart: number;
  periodEnd: number;
  url: string | null;
}>;
export function formatReceiptMoney(amount: number, currency: string, locale?: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
  // Stripe retains two-decimal API amounts for ISK/UGX after their currency transition.
  const digits = ['isk', 'ugx'].includes(currency.toLowerCase())
    ? 2
    : formatter.resolvedOptions().maximumFractionDigits;
  return formatter.format(amount / 10 ** (digits ?? 2));
}
export async function fetchBillingReceipts(
  signal?: AbortSignal,
): Promise<readonly BillingReceipt[]> {
  const client = getSupabaseClient();
  if (!client) throw Error('Billing is not configured.');
  const { data, error } = await client.functions.invoke('list-billing-receipts', {
    body: {},
    ...(signal ? { signal } : {}),
  });
  if (error) throw Error('Invoices could not be loaded. Try again or use Manage subscription.');
  if (!data || !Array.isArray(data.receipts) || data.receipts.length > 24)
    throw Error('Billing returned invalid invoice data.');
  return data.receipts.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw Error('Billing returned invalid invoice data.');
    const r = item as Record<string, unknown>;
    let validUrl = r.url === null;
    if (typeof r.url === 'string') {
      try {
        const u = new URL(r.url);
        validUrl =
          u.protocol === 'https:' &&
          u.hostname === 'invoice.stripe.com' &&
          !u.port &&
          !u.username &&
          !u.password;
      } catch {
        /* reject */
      }
    }
    if (
      typeof r.id !== 'string' ||
      !/^in_[a-zA-Z0-9_]{1,120}$/.test(r.id) ||
      !(r.number === null || (typeof r.number === 'string' && r.number.length <= 120)) ||
      typeof r.currency !== 'string' ||
      !/^[a-z]{3}$/.test(r.currency) ||
      !['paid', 'open', 'void', 'uncollectible'].includes(String(r.status)) ||
      ![r.total, r.paid, r.created, r.periodStart, r.periodEnd].every(
        (v) => typeof v === 'number' && Number.isSafeInteger(v),
      ) ||
      Number(r.created) <= 0 ||
      Number(r.periodStart) <= 0 ||
      Number(r.periodEnd) < Number(r.periodStart) ||
      !validUrl
    )
      throw Error('Billing returned invalid invoice data.');
    return r as BillingReceipt;
  });
}
