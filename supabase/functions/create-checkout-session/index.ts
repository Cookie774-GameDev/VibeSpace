// @ts-nocheck
// Server-authoritative VibeSpace feature-plan checkout. VibeSpace Access uses
// the independent create-access-checkout flow and is never granted here.

import { resolveCheckoutLineItems } from '../_shared/billingCatalog.ts';

const MAX_BODY_BYTES = 16 * 1024;
const ALLOWED_ORIGINS = new Set([
  'https://vibespaceos.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://vibespaceos.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
    'Content-Type': 'application/json',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

function bearer(req: Request): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function appBaseOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (
      !ALLOWED_ORIGINS.has(url.origin) ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function safeCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      !url.port &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const TELEMETRY_REWARD_PERCENT = 10;

function telemetryEligible(profile: any, policyVersion: unknown): boolean {
  return Boolean(
    profile?.telemetry_opt_in === true &&
    typeof policyVersion === 'string' &&
    policyVersion.length > 0 &&
    profile?.telemetry_policy_version === policyVersion,
  );
}

function combinedDiscountPercent(familyPercent: number): number {
  return 100 - (100 - familyPercent) * (1 - TELEMETRY_REWARD_PERCENT / 100);
}

async function resolveAuthoritativeDiscount(
  deps: any,
  profile: any,
  userId: string,
): Promise<
  | { ok: true; couponId: string | null; percent: number; telemetry: boolean; family: boolean }
  | { ok: false }
> {
  const telemetry = telemetryEligible(profile, deps.config?.telemetryPolicyVersion);
  const family = await deps.getFamilyDiscount?.(userId);
  const familyPercent = Number(family?.familyPercentOff ?? 0);
  const hasFamily =
    Boolean(family) && Number.isFinite(familyPercent) && familyPercent > 0 && familyPercent < 100;

  let couponId: unknown = null;
  let expectedPercent = 0;
  if (telemetry && hasFamily) {
    couponId = family.combinedCouponId;
    expectedPercent = combinedDiscountPercent(familyPercent);
  } else if (telemetry) {
    couponId = deps.config?.telemetryCouponId;
    expectedPercent = TELEMETRY_REWARD_PERCENT;
  } else if (hasFamily) {
    couponId = family.familyCouponId;
    expectedPercent = familyPercent;
  }

  if (!telemetry && !hasFamily) {
    return { ok: true, couponId: null, percent: 0, telemetry: false, family: false };
  }
  if (
    typeof couponId !== 'string' ||
    !/^coupon_[A-Za-z0-9_]{1,180}$/.test(couponId) ||
    typeof deps.retrieveCoupon !== 'function'
  ) {
    return { ok: false };
  }

  const coupon = await deps.retrieveCoupon(couponId).catch(() => null);
  const actualPercent = Number(coupon?.percent_off);
  if (
    coupon?.id !== couponId ||
    coupon?.valid !== true ||
    coupon?.duration !== 'forever' ||
    !Number.isFinite(actualPercent) ||
    Math.abs(actualPercent - expectedPercent) > 0.0001
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    couponId,
    percent: expectedPercent,
    telemetry,
    family: hasFamily,
  };
}

export async function handlePlanCheckout(req: Request, deps: any): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401, origin);

  const appBaseUrl = appBaseOrigin(deps.config?.appBaseUrl);
  if (!deps.config?.stripeSecretKey || !appBaseUrl) {
    return json({ error: 'billing_unconfigured' }, 500, origin);
  }

  const contentLength = req.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return json({ error: 'bad_request' }, 400, origin);
    if (Number(contentLength) > MAX_BODY_BYTES) {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
  }

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'bad_request' }, 400, origin);
    }
    body = parsed;
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  const resolution = resolveCheckoutLineItems(String(body.plan ?? ''), {
    addonPriceIds: deps.config.addonPriceIds,
  });
  if (!resolution.ok) {
    return json(
      { error: resolution.error },
      resolution.error === 'invalid_plan' ? 400 : 500,
      origin,
    );
  }

  const activeSubscription = await deps.getActiveFeatureSubscription(user.id);
  if (activeSubscription) {
    return json({ error: 'subscription_exists', action: 'open_portal' }, 409, origin);
  }

  const profile = await deps.getProfile(user.id);
  const discount = await resolveAuthoritativeDiscount(deps, profile, user.id);
  if (!discount.ok) {
    return json({ error: 'subscription_discount_unavailable' }, 503, origin);
  }
  let customerId = profile?.stripe_customer_id as string | undefined;
  if (customerId && !/^cus_[A-Za-z0-9]{1,120}$/.test(customerId)) {
    return json({ error: 'billing_state_invalid' }, 502, origin);
  }
  if (!customerId) {
    const customer = await deps.createCustomer(
      { email: user.email ?? undefined, metadata: { supabase_user_id: user.id } },
      { idempotencyKey: `billing_customer:${user.id}` },
    );
    customerId = customer.id;
    if (typeof customerId !== 'string' || !/^cus_[A-Za-z0-9]{1,120}$/.test(customerId)) {
      return json({ error: 'checkout_unavailable' }, 502, origin);
    }
    await deps.setProfileCustomer(user.id, customerId);
  }

  const timeBucket = Math.floor((deps.now?.() ?? Date.now()) / 600_000);
  const rewardFingerprint = discount.couponId ?? 'none';
  const idempotencyKey = `plan_checkout:${user.id}:${resolution.plan.id}:${rewardFingerprint}:${timeBucket}`;
  const metadata = {
    supabase_user_id: user.id,
    plan: resolution.plan.id,
    product_family: 'feature_plan',
    monthly_credits: String(resolution.plan.monthlyCredits),
    usage_budget_usd: resolution.plan.usageBudgetUsd.toFixed(2),
    telemetry_reward_percent: discount.telemetry ? String(TELEMETRY_REWARD_PERCENT) : '0',
    telemetry_policy_version: discount.telemetry ? String(deps.config.telemetryPolicyVersion) : '',
    family_discount_applied: discount.family ? 'true' : 'false',
  };
  const session = await deps.createSession(
    {
      mode: 'subscription',
      customer: customerId,
      line_items: resolution.lineItems,
      success_url: `${appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appBaseUrl}/billing/cancel`,
      client_reference_id: user.id,
      metadata,
      subscription_data: { metadata },
      allow_promotion_codes: false,
      ...(discount.couponId ? { discounts: [{ coupon: discount.couponId }] } : {}),
    },
    { idempotencyKey },
  );
  const checkoutUrl = safeCheckoutUrl(session?.url);
  if (!checkoutUrl) return json({ error: 'checkout_unavailable' }, 502, origin);
  return json({ url: checkoutUrl }, 200, origin);
}

if (import.meta.main) {
  const [{ createClient }, stripeMod] = await Promise.all([
    import('https://esm.sh/@supabase/supabase-js@2.46.2'),
    import('https://esm.sh/stripe@14.21.0?target=deno'),
  ]);
  const Stripe = stripeMod.default;
  const env = Deno.env;
  const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
  const SUPABASE_ANON_KEY = env.get('SUPABASE_ANON_KEY') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const STRIPE_SECRET_KEY = env.get('STRIPE_SECRET_KEY') ?? '';
  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = {
    config: {
      stripeSecretKey: STRIPE_SECRET_KEY,
      appBaseUrl: env.get('APP_BASE_URL') ?? 'https://vibespaceos.com',
      telemetryCouponId: env.get('STRIPE_TELEMETRY_REWARD_COUPON_ID') ?? '',
      telemetryPolicyVersion: env.get('TELEMETRY_REWARD_POLICY_VERSION') ?? '',
      addonPriceIds: {
        starter: env.get('STRIPE_STARTER_PRICE_ID') ?? '',
        pro: env.get('STRIPE_PRO_PRICE_ID') ?? '',
        ultra: env.get('STRIPE_ULTRA_PRICE_ID') ?? '',
        apex: env.get('STRIPE_APEX_PRICE_ID') ?? '',
      },
    },
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await client.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    getActiveFeatureSubscription: async (userId: string) => {
      const { data, error } = await admin
        .from('subscriptions')
        .select('id, status, plan')
        .eq('user_id', userId)
        .in('status', ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    getProfile: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('stripe_customer_id, telemetry_opt_in, telemetry_policy_version')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    getFamilyDiscount: async (userId: string) => {
      const { data, error } = await admin
        .from('family_discount_entitlements')
        .select('family_percent_off, family_coupon_id, combined_telemetry_coupon_id')
        .eq('user_id', userId)
        .eq('active', true)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        familyPercentOff: Number(data.family_percent_off),
        familyCouponId: data.family_coupon_id,
        combinedCouponId: data.combined_telemetry_coupon_id,
      };
    },
    setProfileCustomer: async (userId: string, customerId: string) => {
      const { error } = await admin
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId);
      if (error) throw error;
    },
    createCustomer: (params: unknown, options: unknown) => stripe.customers.create(params, options),
    retrieveCoupon: (couponId: string) => stripe.coupons.retrieve(couponId),
    createSession: (params: unknown, options: unknown) =>
      stripe.checkout.sessions.create(params, options),
  };
  Deno.serve((req: Request) =>
    handlePlanCheckout(req, deps).catch(() =>
      json({ error: 'internal_error' }, 500, req.headers.get('origin')),
    ),
  );
}
