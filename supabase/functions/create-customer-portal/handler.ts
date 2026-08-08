const ALLOWED_APP_ORIGINS = new Set([
  'https://vibespaceos.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_APP_ORIGINS.has(origin) ? origin : 'https://vibespaceos.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
}

function json(value: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(value), { status, headers: cors(origin) });
}

function bearer(req: Request): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function accountReturnUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (
      !ALLOWED_APP_ORIGINS.has(url.origin) ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return `${url.origin}/account`;
  } catch {
    return null;
  }
}

function trustedPortalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'billing.stripe.com' &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function handleCustomerPortal(req: Request, deps: any): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401, origin);

  if (!deps.config?.stripeSecretKey) {
    return json({ error: 'billing_unconfigured' }, 500, origin);
  }
  const returnUrl = accountReturnUrl(deps.config.appBaseUrl);
  if (!returnUrl) return json({ error: 'billing_unconfigured' }, 500, origin);

  const profile = await deps.getProfile(user.id);
  const customerId = profile?.stripe_customer_id;
  if (typeof customerId !== 'string' || !/^cus_[A-Za-z0-9_]{1,120}$/.test(customerId)) {
    return json({ error: 'no_customer' }, 404, origin);
  }

  const portal = await deps.createPortal({ customer: customerId, return_url: returnUrl });
  const portalUrl = trustedPortalUrl(portal?.url);
  if (!portalUrl) return json({ error: 'portal_unavailable' }, 502, origin);
  return json({ url: portalUrl }, 200, origin);
}
