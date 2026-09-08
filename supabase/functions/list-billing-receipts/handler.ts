type Invoice = Record<string, unknown>;
type Dependencies = {
  authenticate(jwt: string): Promise<{ id: string } | null>;
  getProfile(userId: string): Promise<{ stripe_customer_id?: string } | null>;
  listInvoices(customerId: string): Promise<{ data: Invoice[] }>;
};
const origins = new Set([
  'https://vibespaceos.com',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
  'http://localhost:5174',
]);
const statuses = new Set(['paid', 'open', 'void', 'uncollectible']);
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
function invoiceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'invoice.stripe.com' &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export async function handleBillingReceipts(req: Request, deps: Dependencies): Promise<Response> {
  const origin = req.headers.get('origin');
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin':
      origin && origins.has(origin) ? origin : 'https://vibespaceos.com',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const jwt = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401);
  try {
    const profile = await deps.getProfile(user.id);
    const customerId = profile?.stripe_customer_id;
    if (!customerId) return json({ receipts: [] });
    if (!/^cus_[a-zA-Z0-9_]{1,120}$/.test(customerId))
      return json({ error: 'billing_unavailable' }, 502);
    const result = await deps.listInvoices(customerId);
    if (!Array.isArray(result.data)) throw Error('invalid_response');
    const receipts = result.data
      .slice(0, 24)
      .filter(
        (item) =>
          item.customer === customerId &&
          typeof item.id === 'string' &&
          /^in_[a-zA-Z0-9_]{1,120}$/.test(item.id) &&
          statuses.has(String(item.status)) &&
          typeof item.currency === 'string' &&
          /^[a-z]{3}$/.test(item.currency) &&
          [item.total, item.amount_paid, item.created, item.period_start, item.period_end].every(
            integer,
          ) &&
          Number(item.created) > 0 &&
          Number(item.period_start) > 0 &&
          Number(item.period_end) >= Number(item.period_start),
      )
      .map((item) => ({
        id: item.id,
        number: typeof item.number === 'string' ? item.number.slice(0, 120) : null,
        currency: item.currency,
        total: item.total,
        paid: item.amount_paid,
        status: item.status,
        created: item.created,
        periodStart: item.period_start,
        periodEnd: item.period_end,
        url: invoiceUrl(item.hosted_invoice_url),
      }));
    return json({ receipts });
  } catch {
    return json({ error: 'billing_unavailable' }, 502);
  }
}
