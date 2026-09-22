// @ts-nocheck
// Account-bound optional telemetry consent. Billing eligibility is derived
// server-side from this state; the renderer cannot award a discount.

import {
  reconcileTelemetryWithdrawal,
  type TelemetryBillingReconcileDependencies,
} from '../_shared/telemetryBillingReconcile.ts';

const MAX_BODY_BYTES = 8 * 1024;
const REQUIRED_CLASSES = Object.freeze(['product_usage', 'diagnostics', 'tool_outcomes']);
const WITHDRAWAL_NOT_REQUESTED = Object.freeze({ status: 'not_requested' });
const ALLOWED_ORIGINS = new Set([
  'https://vibespaceos.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://vibespaceos.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'apikey, x-client-info, authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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

function validConfig(config: any): boolean {
  if (typeof config?.policyVersion !== 'string' || !config.policyVersion.trim()) return false;
  try {
    const notice = new URL(config.noticeUrl);
    return notice.protocol === 'https:' && !notice.username && !notice.password;
  } catch {
    return false;
  }
}

function exactClasses(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
  const normalized = [...new Set(value)];
  return (
    value.length === REQUIRED_CLASSES.length &&
    normalized.length === REQUIRED_CLASSES.length &&
    REQUIRED_CLASSES.every((item) => normalized.includes(item))
  );
}

async function readBodyBounded(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('payload_too_large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeWithdrawalStatus(value: unknown): any {
  if (!value || typeof value !== 'object') return WITHDRAWAL_NOT_REQUESTED;
  const status = value.status;
  if (status !== 'pending' && status !== 'reconciled' && status !== 'failed') {
    return WITHDRAWAL_NOT_REQUESTED;
  }
  return {
    status,
    ...(Number.isSafeInteger(value.attemptCount) ? { attemptCount: value.attemptCount } : {}),
    ...(typeof value.requestRevision === 'string'
      ? { requestRevision: value.requestRevision }
      : {}),
    ...(typeof value.errorCode === 'string' ? { errorCode: value.errorCode } : {}),
    ...(typeof value.requestedAt === 'string' ? { requestedAt: value.requestedAt } : {}),
    ...(typeof value.nextAttemptAt === 'string' ? { nextAttemptAt: value.nextAttemptAt } : {}),
    ...(typeof value.reconciledAt === 'string' ? { reconciledAt: value.reconciledAt } : {}),
  };
}

/**
 * Stripe has returned expanded subscription discounts as either a plain array
 * or an ApiList-shaped `{ data: [...] }` value across SDK/API versions. Keep
 * promotion-code identity ahead of the underlying coupon: a promotion-code
 * discount also carries its coupon, and replacing it with the coupon would
 * silently change what the next subscription update preserves.
 */
export function normalizeStripeDiscounts(value: unknown): Array<{
  type: 'coupon' | 'promotion_code' | 'unknown';
  id: string;
}> {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as any).data)
      ? (value as any).data
      : value == null
        ? []
        : null;
  if (!entries) return [{ type: 'unknown', id: '' }];

  const referenceId = (candidate: unknown): string => {
    if (typeof candidate === 'string') return candidate;
    if (candidate && typeof candidate === 'object' && typeof (candidate as any).id === 'string') {
      return (candidate as any).id;
    }
    return '';
  };

  return entries.map((discount: any) => {
    if (!discount || typeof discount !== 'object') return { type: 'unknown', id: '' };
    const hasPromotionCode = Object.prototype.hasOwnProperty.call(discount, 'promotion_code');
    const promotionCodeId = referenceId(discount.promotion_code);
    if (promotionCodeId) return { type: 'promotion_code', id: promotionCodeId };
    if (hasPromotionCode && discount.promotion_code != null) {
      return { type: 'unknown', id: String(discount.id ?? '') };
    }

    const couponId = referenceId(discount.coupon);
    if (couponId) return { type: 'coupon', id: couponId };
    return { type: 'unknown', id: String(discount.id ?? '') };
  });
}

async function reconcileIfNeeded(userId: string, deps: any, state: any): Promise<any> {
  if (state?.enabled === true || !deps.reconcileWithdrawal)
    return safeWithdrawalStatus(state?.withdrawal);
  const current = safeWithdrawalStatus(state?.withdrawal);
  if (current.status !== 'pending' && current.status !== 'failed') return current;
  try {
    return safeWithdrawalStatus(await deps.reconcileWithdrawal(userId, current.requestRevision));
  } catch {
    return { status: 'pending', errorCode: 'withdrawal_reconcile_pending' };
  }
}

export async function handleTelemetryConsent(req: Request, deps: any): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }
  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401, origin);
  if (!validConfig(deps.config))
    return json({ error: 'telemetry_reward_unconfigured' }, 503, origin);

  if (req.method === 'GET') {
    const state = await deps.getConsent(user.id);
    const withdrawal = await reconcileIfNeeded(user.id, deps, state);
    return json(
      {
        ...state,
        withdrawal,
        policyVersion: deps.config.policyVersion,
        noticeUrl: deps.config.noticeUrl,
        discountPercent: 10,
        requiredDataClasses: REQUIRED_CLASSES,
      },
      200,
      origin,
    );
  }

  const contentLength = req.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return json({ error: 'payload_too_large' }, 413, origin);
  }
  let body: any;
  try {
    const raw = await readBodyBounded(req, MAX_BODY_BYTES);
    body = JSON.parse(raw);
  } catch (error) {
    if (error?.message === 'payload_too_large') {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
    return json({ error: 'bad_request' }, 400, origin);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.enabled !== 'boolean' ||
    body.policyVersion !== deps.config.policyVersion ||
    !Array.isArray(body.dataClasses) ||
    (body.enabled ? !exactClasses(body.dataClasses) : body.dataClasses.length !== 0)
  ) {
    return json({ error: 'invalid_consent' }, 400, origin);
  }
  const state = await deps.setConsent(
    user.id,
    body.enabled,
    deps.config.policyVersion,
    body.enabled ? [...REQUIRED_CLASSES] : [],
  );
  let withdrawal = safeWithdrawalStatus(state?.withdrawal);
  if (body.enabled) {
    if (deps.atomicWithdrawal) {
      withdrawal = safeWithdrawalStatus(state?.withdrawal);
    }
    if (deps.cancelWithdrawal && !deps.atomicWithdrawal) {
      try {
        await deps.cancelWithdrawal(user.id);
      } catch {
        // The profile is already enabled, so local upload remains gated by
        // current consent. The old revision check prevents stale billing work.
      }
    }
    withdrawal = WITHDRAWAL_NOT_REQUESTED;
  } else if (deps.atomicWithdrawal) {
    withdrawal = safeWithdrawalStatus(state?.withdrawal);
    withdrawal = await reconcileIfNeeded(user.id, deps, { ...state, withdrawal });
  } else {
    // The profile/RPC update above is authoritative and happens first. Queue
    // reconciliation durably before attempting any Stripe mutation.
    let queued: any = null;
    if (deps.enqueueWithdrawal) {
      try {
        queued = await deps.enqueueWithdrawal(user.id);
        withdrawal = {
          status: 'pending',
          ...(typeof queued?.requestRevision === 'string'
            ? { requestRevision: queued.requestRevision }
            : {}),
        };
      } catch {
        withdrawal = { status: 'pending', errorCode: 'withdrawal_enqueue_pending' };
      }
    }
    if (withdrawal.status !== 'pending' || withdrawal.errorCode !== 'withdrawal_enqueue_pending') {
      withdrawal = await reconcileIfNeeded(user.id, deps, { ...state, withdrawal });
    }
  }
  return json(
    {
      ...state,
      withdrawal,
      policyVersion: deps.config.policyVersion,
      noticeUrl: deps.config.noticeUrl,
      discountPercent: 10,
      requiredDataClasses: REQUIRED_CLASSES,
    },
    200,
    origin,
  );
}

if (import.meta.main) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.46.2');
  const env = Deno.env;
  const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
  const SUPABASE_ANON_KEY = env.get('SUPABASE_ANON_KEY') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = {
    atomicWithdrawal: true,
    config: {
      policyVersion: env.get('TELEMETRY_REWARD_POLICY_VERSION') ?? '',
      noticeUrl: env.get('TELEMETRY_FINANCIAL_INCENTIVE_NOTICE_URL') ?? '',
    },
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data, error } = await client.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    getConsent: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('telemetry_opt_in, telemetry_policy_version, telemetry_data_classes')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      const enabled = data?.telemetry_opt_in === true;
      const { data: withdrawalRow, error: withdrawalError } = await admin
        .from('telemetry_withdrawal_outbox')
        .select(
          'state, request_revision, attempt_count, last_error, requested_at, next_attempt_at, reconciled_at',
        )
        .eq('user_id', userId)
        .maybeSingle();
      if (withdrawalError) throw withdrawalError;
      return {
        enabled,
        policyVersion: data?.telemetry_policy_version ?? null,
        dataClasses: data?.telemetry_data_classes ?? [],
        eligible:
          enabled &&
          data?.telemetry_policy_version === deps.config.policyVersion &&
          exactClasses(data?.telemetry_data_classes),
        withdrawal: withdrawalRow
          ? {
              status: withdrawalRow.state,
              requestRevision: withdrawalRow.request_revision,
              attemptCount: withdrawalRow.attempt_count,
              errorCode: withdrawalRow.last_error ?? undefined,
              requestedAt: withdrawalRow.requested_at,
              nextAttemptAt: withdrawalRow.next_attempt_at,
              reconciledAt: withdrawalRow.reconciled_at,
            }
          : WITHDRAWAL_NOT_REQUESTED,
      };
    },
    setConsent: async (
      userId: string,
      enabled: boolean,
      policyVersion: string,
      dataClasses: string[],
    ) => {
      const { data, error } = await admin.rpc('set_telemetry_reward_consent_atomic', {
        p_user_id: userId,
        p_enabled: enabled,
        p_policy_version: policyVersion,
        p_data_classes: dataClasses,
      });
      if (error) throw error;
      return data;
    },
    enqueueWithdrawal: async (userId: string) => {
      const { data, error } = await admin.rpc('enqueue_telemetry_withdrawal', {
        p_user_id: userId,
      });
      if (error) throw error;
      return data;
    },
    cancelWithdrawal: async (userId: string) => {
      const { error } = await admin.rpc('cancel_telemetry_withdrawal', {
        p_user_id: userId,
      });
      if (error) throw error;
    },
    reconcileWithdrawal: async (userId: string, requestRevision: string) => {
      if (!requestRevision) return { status: 'pending', errorCode: 'withdrawal_revision_missing' };
      const knownTelemetryCouponIds = (env.get('TELEMETRY_REWARD_COUPON_IDS') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const stripeSecretKey = env.get('STRIPE_SECRET_KEY') ?? '';
      if (!stripeSecretKey || knownTelemetryCouponIds.length === 0) {
        return {
          status: 'failed',
          errorCode: 'telemetry_coupon_configuration_missing',
        };
      }
      const { default: Stripe } = await import('https://esm.sh/stripe@14.21.0?target=deno');
      const stripe = new Stripe(stripeSecretKey, { apiVersion: '2024-12-18.acacia' });
      const rows = await admin
        .from('subscriptions')
        .select('id, status, plan')
        .eq('user_id', userId)
        .in('status', ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'])
        .in('plan', ['starter', 'pro', 'ultra', 'apex']);
      if (rows.error) throw rows.error;
      const subscriptions = [];
      for (const row of rows.data ?? []) {
        const subscription = await stripe.subscriptions.retrieve(row.id, { expand: ['discounts'] });
        const discounts = normalizeStripeDiscounts(subscription.discounts);
        if (discounts.some((discount) => discount.type === 'unknown')) {
          throw new Error('unsupported Stripe discount shape');
        }
        subscriptions.push({ id: row.id, status: row.status, plan: row.plan, discounts });
      }
      const billingDependencies: TelemetryBillingReconcileDependencies = {
        listFeatureSubscriptions: async () => subscriptions,
        assertWithdrawalCurrent: async (currentUserId, currentRevision) => {
          const { data, error } = await admin
            .from('telemetry_withdrawal_outbox')
            .select('request_revision')
            .eq('user_id', currentUserId)
            .eq('request_revision', currentRevision)
            .in('state', ['pending', 'failed'])
            .maybeSingle();
          if (error) throw error;
          if (!data) return false;
          const { data: profile, error: profileError } = await admin
            .from('profiles')
            .select('telemetry_opt_in')
            .eq('id', currentUserId)
            .maybeSingle();
          if (profileError) throw profileError;
          return profile?.telemetry_opt_in !== true;
        },
        updateSubscription: async (subscriptionId, patch) => {
          if (patch.discounts.some((discount) => discount.type === 'unknown')) {
            throw new Error('unknown Stripe discount shape');
          }
          await stripe.subscriptions.update(subscriptionId, {
            discounts: patch.discounts.map((discount) =>
              discount.type === 'coupon'
                ? { coupon: discount.id }
                : { promotion_code: discount.id },
            ),
            proration_behavior: 'none',
          });
        },
        markOutbox: async (update) => {
          if (!update.requestRevision) throw new Error('withdrawal revision required');
          const { error } = await admin.rpc('record_telemetry_withdrawal_attempt', {
            p_user_id: update.userId,
            p_request_revision: update.requestRevision,
            p_state: update.state,
            p_error_code: update.errorCode ?? null,
            p_reconciled: update.state === 'reconciled',
          });
          if (error) throw error;
        },
      };
      return reconcileTelemetryWithdrawal({
        userId,
        knownTelemetryCouponIds,
        dependencies: billingDependencies,
        requestRevision,
      });
    },
  };
  Deno.serve((req: Request) =>
    handleTelemetryConsent(req, deps).catch(() =>
      json({ error: 'internal_error' }, 500, req.headers.get('origin')),
    ),
  );
}
