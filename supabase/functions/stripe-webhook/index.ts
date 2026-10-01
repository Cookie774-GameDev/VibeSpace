// @ts-nocheck
// stripe-webhook: verifies Stripe signatures over the RAW request body, then
// routes events server-side. Dedicated VibeSpace Access (app-access) events are
// reconciled through the committed pure boundary ./appAccess.ts into the
// app_access_entitlements/app_access_events tables; all other events keep the
// legacy voice/feature-tier reconciliation (profiles.tier + subscriptions).
//
// Security:
//   - Deploy with verify_jwt=false (Stripe sends stripe-signature, not a JWT).
//   - Bound declared and streamed bodies before signature verification.
//   - Signature verified against the RAW request body before any parsing/routing.
//   - Invalid/modified signatures -> bounded 400 (no upstream detail exposed).
//   - Durable idempotency via subscription_events.event_id unique constraint:
//     processed duplicates short-circuit; failed/unprocessed rows retry so Stripe
//     retry delivery can recover.
//   - App-access provider_event_id dedupe + entitlement revision preconditions
//     make duplicate/out-of-order/concurrent deliveries unable to regress state.
//   - Plan/price/status are ALWAYS derived server-side (Stripe price id + the
//     app-access price allowlist), never from the client.
//   - Responses/logs use bounded safe codes only: no secrets, raw payloads,
//     customer identifiers, stack traces, or signing-error detail.
//
// Tests import `handleStripeWebhook(req, deps)` with injected mocks and never
// touch the network. The esm.sh SDK imports and Deno.serve live behind
// `import.meta.main` (as dynamic imports) so importing this module for tests
// performs no fetch and touches no Deno globals.

import { planForPriceId } from '../_shared/voice.ts';
import { resolveStripeEntitlement } from '../_shared/billingCatalog.ts';
import {
  invoicePaymentFailedForcesFree,
  subscriptionKeepsPaidAccess,
  subscriptionRevokesToFree,
} from '../_shared/subscriptionStatus.ts';
import { reconcileAppAccessEvent } from './appAccess.ts';

const ACCESS_PRODUCT = 'vibespace_access';
// Stripe webhook event JSON is normally far smaller than 1 MiB. This generous
// body ceiling is 256x below the hosted Edge memory cap while leaving headroom
// for expanded event objects.
const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1024 * 1024;
const INITIAL_WEBHOOK_BODY_BUFFER_BYTES = 8 * 1024;

// Production database adapters are exported only so deterministic tests can
// prove their error semantics without importing SDKs or touching Supabase.
export async function claimSubscriptionEvent(db, eventId, eventType, payload) {
  const { error: insertErr } = await db.from('subscription_events').insert({
    event_id: eventId,
    event_type: eventType,
    payload,
    processed: false,
  });
  if (!insertErr) return 'claimed';
  // Only a unique event-id collision is a retry/duplicate. Treating permission,
  // transport, or schema failures as collisions would process without a claim.
  if (insertErr.code !== '23505') throw insertErr;

  const { data: existing, error: lookupErr } = await db
    .from('subscription_events')
    .select('processed')
    .eq('event_id', eventId)
    .maybeSingle();
  if (lookupErr) throw lookupErr;
  if (!existing) throw new Error('claim_collision_missing');
  if (existing.processed) return 'already_processed';

  const { data: refreshed, error: updateErr } = await db
    .from('subscription_events')
    .update({ event_type: eventType, payload })
    .eq('event_id', eventId)
    .eq('processed', false)
    .select('event_id')
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!refreshed) throw new Error('claim_retry_conflict');
  return 'retry';
}

export async function applyLegacyPlanToDb(db, customerId, plan, sub, updatedAt) {
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile?.id) return;

  const { data: updatedProfile, error: updateErr } = await db
    .from('profiles')
    .update({ tier: plan, updated_at: updatedAt })
    .eq('id', profile.id)
    .select('id')
    .maybeSingle();
  if (updateErr) throw updateErr;
  if (!updatedProfile) throw new Error('legacy_profile_update_conflict');

  if (sub) {
    const { error: subscriptionErr } = await db.from('subscriptions').upsert({
      id: sub.id,
      user_id: profile.id,
      stripe_customer_id: customerId,
      status: sub.status,
      plan,
      price_id: sub.items?.data?.[0]?.price?.id ?? null,
      current_period_start: sub.current_period_start
        ? new Date(sub.current_period_start * 1000).toISOString()
        : null,
      current_period_end: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      updated_at: updatedAt,
    });
    if (subscriptionErr) throw subscriptionErr;
  }
}

export async function reconcileAppAccessWithRpc(db, { eventId, entitlement, events }) {
  const { data, error } = await db.rpc('app_access_reconcile_event', {
    p_event_id: eventId,
    p_user_id: entitlement.key.user_id,
    p_expected_revision: entitlement.expected_revision ?? null,
    p_expected_provider_status_updated_at: entitlement.expected_provider_status_updated_at ?? null,
    p_entitlement: entitlement.set,
    p_events: events.map((event) => event.set),
  });
  if (error) return { ok: false, reason: 'error' };
  if (data === 'applied' || data === 'duplicate') return { ok: true, reason: data };
  if (data === 'conflict') return { ok: false, reason: 'conflict' };
  return { ok: false, reason: 'error' };
}

function customerOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const c = obj.customer;
  if (typeof c === 'string' && c !== '') return c;
  if (c && typeof c === 'object' && typeof c.id === 'string' && c.id !== '') return c.id;
  return null;
}
function subscriptionPriceIds(sub) {
  const out = [];
  for (const item of (sub && sub.items && sub.items.data) || []) {
    const id = item && item.price && item.price.id;
    if (typeof id === 'string' && id !== '') out.push(id);
  }
  return out;
}
function invoicePriceIds(invoice) {
  const out = [];
  for (const line of (invoice && invoice.lines && invoice.lines.data) || []) {
    const id = line && line.price && line.price.id;
    if (typeof id === 'string' && id !== '') out.push(id);
  }
  return out;
}
function eventMetadata(event) {
  const obj = event && event.data && event.data.object;
  const md = obj && obj.metadata;
  return md && typeof md === 'object' && !Array.isArray(md) ? md : null;
}
// Server-side price ids used ONLY to classify app-access vs legacy routing.
// checkout prices come from the retrieved subscription (not the session body).
function classifyPriceIds(event) {
  const obj = event && event.data && event.data.object;
  if (!obj || typeof obj !== 'object') return [];
  const t = event.type;
  if (t === 'invoice.payment_succeeded' || t === 'invoice.payment_failed')
    return invoicePriceIds(obj);
  if (t === 'checkout.session.completed') return [];
  return subscriptionPriceIds(obj);
}
function mapSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  return {
    status: sub.status,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    currentPeriodStart:
      typeof sub.current_period_start === 'number' ? sub.current_period_start : null,
    currentPeriodEnd: typeof sub.current_period_end === 'number' ? sub.current_period_end : null,
    trialStart: typeof sub.trial_start === 'number' ? sub.trial_start : null,
    trialEnd: typeof sub.trial_end === 'number' ? sub.trial_end : null,
    endedAt: typeof sub.ended_at === 'number' ? sub.ended_at : null,
  };
}
// Map a snake_case app_access_entitlements row to the reconciler's `current`.
function mapEntitlementRow(row) {
  return {
    userId: row.user_id,
    status: row.status,
    providerStatus: row.provider_status ?? null,
    providerStatusUpdatedAt: row.provider_status_updated_at ?? null,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
    stripePriceId: row.stripe_price_id ?? null,
    currentPeriodStart: row.current_period_start ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    lastPaymentStatus: row.last_payment_status ?? null,
    accessEndedAt: row.access_ended_at ?? null,
    trialStartedAt: row.trial_started_at ?? null,
    trialEndsAt: row.trial_ends_at ?? null,
    graceStartedAt: row.grace_started_at ?? null,
    graceEndsAt: row.grace_ends_at ?? null,
    lockedAt: row.locked_at ?? null,
    revision: Number.isSafeInteger(row.revision) ? row.revision : 0,
  };
}
// Build the bounded, signature-verified projection the pure reconciler accepts.
// Server-owned fields only: price ids come from the authoritative subscription
// (retrieved for checkout; best-effort for invoices), never from the client.
async function buildAppAccessProjection(event, metadata, deps, checkoutSubscription = null) {
  const obj = (event && event.data && event.data.object) || {};
  const t = event.type;
  const projection = {
    eventId: event.id,
    eventType: t,
    eventCreated: event.created,
    priceIds: [],
    metadata: metadata,
    userId:
      (metadata && typeof metadata.supabase_user_id === 'string' && metadata.supabase_user_id) ||
      null,
    subscriptionId: null,
    customerId: customerOf(obj),
    subscription: null,
    invoice: null,
  };

  if (t === 'checkout.session.completed') {
    const subRef = obj.subscription;
    projection.subscriptionId = typeof subRef === 'string' ? subRef : (subRef && subRef.id) || null;
    if (!projection.subscriptionId) return projection; // reconciler -> no_subscription
    // A checkout cannot be reconciled without its subscription; a retrieval
    // failure here propagates and yields a retryable 500.
    const sub =
      checkoutSubscription || (await deps.retrieveSubscription(String(projection.subscriptionId)));
    projection.subscription = mapSubscription(sub);
    projection.priceIds = subscriptionPriceIds(sub);
    if (!projection.customerId) projection.customerId = customerOf(sub);
    return projection;
  }

  if (t === 'invoice.payment_succeeded' || t === 'invoice.payment_failed') {
    const subRef = obj.subscription;
    projection.subscriptionId = typeof subRef === 'string' ? subRef : (subRef && subRef.id) || null;
    projection.priceIds = invoicePriceIds(obj);
    projection.invoice = {
      paid: obj.paid === true,
      status: typeof obj.status === 'string' ? obj.status : '',
    };
    // Best-effort subscription context for period bounds; invoice reconciliation
    // can proceed from the current entitlement, so a retrieval failure is not fatal.
    if (projection.subscriptionId) {
      try {
        const sub = await deps.retrieveSubscription(String(projection.subscriptionId));
        projection.subscription = mapSubscription(sub);
        if (projection.priceIds.length === 0) projection.priceIds = subscriptionPriceIds(sub);
        if (!projection.customerId) projection.customerId = customerOf(sub);
      } catch (_err) {
        // non-fatal: reconciler uses `current` for invoice events
      }
    }
    return projection;
  }

  // customer.subscription.* (created/updated/deleted/trial_will_end)
  projection.subscriptionId = typeof obj.id === 'string' ? obj.id : null;
  projection.subscription = mapSubscription(obj);
  projection.priceIds = subscriptionPriceIds(obj);
  return projection;
}

// Non-mutating app-access results and legacy writes complete the claim here.
// Mutating app-access results complete it inside the transactional RPC.
async function markProcessed(deps, eventId) {
  await deps.markEventProcessed(eventId);
}

// Route an app-access-classified event through the committed pure reconciler and
// apply the returned commands with durable idempotency + concurrency preconditions.
async function handleAppAccess(event, metadata, deps, checkoutSubscription = null) {
  let projection;
  try {
    projection = await buildAppAccessProjection(event, metadata, deps, checkoutSubscription);
  } catch (_err) {
    return new Response('handler_error', { status: 500 });
  }

  let current = null;
  try {
    const row = await deps.getCurrentEntitlement({
      userId: projection.userId || null,
      subscriptionId: projection.subscriptionId || null,
      customerId: projection.customerId || null,
    });
    current = row ? mapEntitlementRow(row) : null;
  } catch (_err) {
    return new Response('handler_error', { status: 500 });
  }

  const result = reconcileAppAccessEvent({
    projection,
    current,
    config: deps.config.appAccess,
    // The transactional RPC owns provider-event replay detection under the
    // durable claim lock. A separate pre-read would reintroduce a race.
    eventAlreadyProcessed: false,
  });

  if (result.kind === 'apply') {
    let res;
    try {
      res = await deps.reconcileAppAccessAtomically({
        eventId: event.id,
        entitlement: result.entitlement,
        events: result.events,
      });
    } catch (_err) {
      return new Response('handler_error', { status: 500 });
    }
    if (res && res.ok === true) {
      return new Response('ok', { status: 200 });
    }
    if (res && res.reason === 'conflict') {
      // A concurrent writer advanced the row. Ask Stripe to retry so this event
      // re-reconciles against the newer state; a 2xx would suppress that retry.
      return new Response('handler_error', { status: 500 });
    }
    return new Response('handler_error', { status: 500 });
  }

  // duplicate / stale / noop / ignored / invalid: no mutation. These are
  // permanent, informational, or ordering results; mark processed so Stripe does
  // not keep retrying a payload that will never mutate (fail closed).
  await markProcessed(deps, event.id);
  return new Response('ok', { status: 200 });
}
// --- legacy voice/feature-tier reconciliation (unchanged semantics) ---------
// Feature plan is derived server-side from the Stripe price id (deps.planForPriceId
// wraps the shared allowlist), never from the client. This path NEVER writes
// app_access tables; app-access events never reach here.
function planFromSubscription(deps, sub) {
  if (deps.config && deps.config.billingPrices) {
    const entitlement = resolveStripeEntitlement(
      subscriptionPriceIds(sub),
      deps.config.billingPrices,
    );
    return entitlement.ok ? entitlement.plan.id : null;
  }
  for (const item of (sub && sub.items && sub.items.data) || []) {
    const p = deps.planForPriceId(item && item.price && item.price.id);
    if (p) return p;
  }
  return null;
}
async function applyLegacySubscriptionEvent(deps, customerId, sub) {
  if (subscriptionKeepsPaidAccess(sub.status)) {
    const plan = planFromSubscription(deps, sub);
    if (plan) await deps.applyLegacyPlan({ customerId, plan, sub });
    return;
  }
  if (subscriptionRevokesToFree(sub.status)) {
    await deps.applyLegacyPlan({ customerId, plan: 'free', sub });
  }
  // Other statuses (incomplete, paused, etc.): leave tier alone until Stripe resolves.
}
async function handleLegacy(event, deps, checkoutSubscription = null) {
  const obj = (event && event.data && event.data.object) || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = customerOf(obj);
      const subRef = obj.subscription;
      const subId = typeof subRef === 'string' ? subRef : (subRef && subRef.id) || null;
      if (customerId && subId) {
        const sub = checkoutSubscription || (await deps.retrieveSubscription(String(subId)));
        await applyLegacySubscriptionEvent(deps, customerId, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const customerId = customerOf(obj);
      if (customerId) await applyLegacySubscriptionEvent(deps, customerId, obj);
      break;
    }
    case 'customer.subscription.deleted': {
      const customerId = customerOf(obj);
      if (customerId) await deps.applyLegacyPlan({ customerId, plan: 'free', sub: obj });
      break;
    }
    case 'invoice.payment_failed': {
      // Do not thrash tier on a single failed charge. Sync subscription status if
      // Stripe still considers the sub past_due/active so the row reflects dunning,
      // but keep paid plan until revoke statuses.
      if (invoicePaymentFailedForcesFree()) {
        const customerId = customerOf(obj);
        if (customerId) await deps.applyLegacyPlan({ customerId, plan: 'free', sub: null });
        break;
      }
      const customerId = customerOf(obj);
      const subRef = obj.subscription;
      const subId = typeof subRef === 'string' ? subRef : (subRef && subRef.id) || null;
      if (customerId && subId) {
        const sub = await deps.retrieveSubscription(String(subId));
        await applyLegacySubscriptionEvent(deps, customerId, sub);
      }
      break;
    }
    case 'invoice.payment_succeeded':
      // Period renewal: reserve_voice_seconds resets usage lazily on next call.
      // If payment recovers from past_due, subscription.updated also fires.
      break;
    default:
      break;
  }
}

// Exported handler with injected dependencies (tests never touch the network).
function contentLengthError(req) {
  const rawLength = req.headers.get('content-length');
  if (rawLength === null) return null;
  const normalized = rawLength.trim();
  if (!/^\d+$/.test(normalized)) {
    return new Response('invalid_content_length', { status: 400 });
  }
  const declaredLength = Number(normalized);
  if (!Number.isFinite(declaredLength) || declaredLength > MAX_STRIPE_WEBHOOK_BODY_BYTES) {
    return new Response('payload_too_large', { status: 413 });
  }
  return null;
}

async function cancelOversizedBody(reader) {
  try {
    await reader.cancel('payload_too_large');
  } catch (_err) {
    // The request is already rejected; cancellation is best-effort cleanup.
  }
}

async function readBoundedWebhookBody(req) {
  if (!req.body) return { ok: true, rawBody: '' };
  const reader = req.body.getReader();
  let length = 0;
  let buffer = new Uint8Array(INITIAL_WEBHOOK_BODY_BUFFER_BYTES);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return {
          ok: true,
          rawBody: new TextDecoder().decode(buffer.subarray(0, length)),
        };
      }
      if (value.byteLength > MAX_STRIPE_WEBHOOK_BODY_BYTES - length) {
        await cancelOversizedBody(reader);
        return { ok: false, code: 'payload_too_large', status: 413 };
      }
      const nextLength = length + value.byteLength;
      if (nextLength > buffer.byteLength) {
        const nextCapacity = Math.min(
          MAX_STRIPE_WEBHOOK_BODY_BYTES,
          Math.max(nextLength, buffer.byteLength * 2),
        );
        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(buffer.subarray(0, length));
        buffer = nextBuffer;
      }
      buffer.set(value, length);
      length = nextLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function handleStripeWebhook(req, deps) {
  if (req.method === 'GET') return new Response('Jarvis Stripe webhook up.\n', { status: 200 });
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!deps.config || deps.config.configured !== true) {
    return new Response('not_configured', { status: 500 });
  }

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing_signature', { status: 400 });

  const lengthError = contentLengthError(req);
  if (lengthError) return lengthError;

  const body = await readBoundedWebhookBody(req);
  if (!body.ok) return new Response(body.code, { status: body.status });
  const rawBody = body.rawBody; // exact raw UTF-8 text required for signature verification
  let event;
  try {
    event = await deps.verifySignature(rawBody, sig);
  } catch (_err) {
    return new Response('invalid_signature', { status: 400 });
  }
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string'
  ) {
    return new Response('invalid_signature', { status: 400 });
  }

  // Durable idempotency claim (applies to every event). Processed duplicates
  // short-circuit; failed/unprocessed rows are retried so Stripe retries recover.
  let claim;
  try {
    claim = await deps.claimEvent(event.id, event.type, event);
  } catch (_err) {
    return new Response('handler_error', { status: 500 });
  }
  if (claim === 'already_processed') return new Response('duplicate', { status: 200 });

  // Server-side classification: app-access (dedicated price allowlist / access
  // product metadata) vs legacy feature tier. Client input is never authority.
  const metadata = eventMetadata(event);
  let checkoutSubscription = null;
  let priceIds = classifyPriceIds(event);
  if (event.type === 'checkout.session.completed') {
    const obj = (event.data && event.data.object) || {};
    const subRef = obj.subscription;
    const subId = typeof subRef === 'string' ? subRef : (subRef && subRef.id) || null;
    if (subId) {
      try {
        checkoutSubscription = await deps.retrieveSubscription(String(subId));
        priceIds = subscriptionPriceIds(checkoutSubscription);
      } catch (_err) {
        return new Response('handler_error', { status: 500 });
      }
    }
  }
  const known = new Set((deps.config.appAccess && deps.config.appAccess.knownPriceIds) || []);
  const isAppAccess =
    (metadata && metadata.access_product === ACCESS_PRODUCT) || priceIds.some((p) => known.has(p));

  try {
    if (isAppAccess) return await handleAppAccess(event, metadata, deps, checkoutSubscription);
    await handleLegacy(event, deps, checkoutSubscription);
    await markProcessed(deps, event.id);
    return new Response('ok', { status: 200 });
  } catch (_err) {
    // 500 -> Stripe retries with backoff; the claim stays unprocessed.
    return new Response('handler_error', { status: 500 });
  }
}
// Production wiring (Supabase Edge Function entrypoint). Dynamic imports keep the
// SDK fetch out of test runs: import.meta.main is false when this module is
// imported (e.g. by index.test.ts), true only when executed as the entrypoint.
if (import.meta.main) {
  const [supabaseMod, stripeMod] = await Promise.all([
    import('https://esm.sh/@supabase/supabase-js@2.46.2'),
    import('https://esm.sh/stripe@14.21.0?target=deno'),
  ]);
  const createClient = supabaseMod.createClient;
  const Stripe = stripeMod.default;

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';
  const APP_ACCESS_GRACE_DAYS = Number(Deno.env.get('APP_ACCESS_GRACE_DAYS') ?? '3');
  const knownPriceIds = (Deno.env.get('STRIPE_APP_ACCESS_PRICE_IDS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const singleAccessPrice = Deno.env.get('STRIPE_APP_ACCESS_PRICE_ID') ?? '';
  if (singleAccessPrice && knownPriceIds.indexOf(singleAccessPrice) === -1) {
    knownPriceIds.unshift(singleAccessPrice);
  }

  function admin() {
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  const stripe = new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-12-18.acacia',
    httpClient: Stripe.createFetchHttpClient(),
  });

  // Legacy feature-tier write: profiles.tier change fires the voice_usage sync
  // trigger; subscriptions row mirrors the Stripe subscription.
  async function applyPlan(customerId, plan, sub) {
    await applyLegacyPlanToDb(admin(), customerId, plan, sub, new Date().toISOString());
  }

  const deps = {
    config: {
      configured: !!STRIPE_WEBHOOK_SECRET && !!STRIPE_SECRET_KEY,
      appAccess: {
        graceDays:
          Number.isSafeInteger(APP_ACCESS_GRACE_DAYS) && APP_ACCESS_GRACE_DAYS >= 0
            ? APP_ACCESS_GRACE_DAYS
            : 3,
        knownPriceIds,
      },
      billingPrices: {
        addonPriceIds: {
          starter: Deno.env.get('STRIPE_STARTER_PRICE_ID') ?? '',
          pro: Deno.env.get('STRIPE_PRO_PRICE_ID') ?? '',
          ultra: Deno.env.get('STRIPE_ULTRA_PRICE_ID') ?? '',
          apex: Deno.env.get('STRIPE_APEX_PRICE_ID') ?? '',
        },
      },
    },
    async verifySignature(rawBody, sig) {
      return await stripe.webhooks.constructEventAsync(rawBody, sig, STRIPE_WEBHOOK_SECRET);
    },
    async retrieveSubscription(subId) {
      return await stripe.subscriptions.retrieve(subId);
    },
    planForPriceId,
    now() {
      return new Date();
    },
    async claimEvent(eventId, eventType, payload) {
      return await claimSubscriptionEvent(admin(), eventId, eventType, payload);
    },
    async markEventProcessed(eventId) {
      const { data, error } = await admin()
        .from('subscription_events')
        .update({ processed: true })
        .eq('event_id', eventId)
        .select('event_id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('processed_mark_missing');
    },
    async getProfileIdByCustomer(customerId) {
      const { data, error } = await admin()
        .from('profiles')
        .select('id')
        .eq('stripe_customer_id', customerId)
        .maybeSingle();
      if (error) throw error;
      return data?.id ?? null;
    },
    async applyLegacyPlan({ customerId, plan, sub }) {
      await applyPlan(customerId, plan, sub);
    },
    async getCurrentEntitlement(lookup) {
      const db = admin();
      let q = db.from('app_access_entitlements').select('*');
      if (lookup.userId) q = q.eq('user_id', lookup.userId);
      else if (lookup.subscriptionId) q = q.eq('stripe_subscription_id', lookup.subscriptionId);
      else if (lookup.customerId) q = q.eq('stripe_customer_id', lookup.customerId);
      else return null;
      const { data, error } = await q.maybeSingle();
      if (error) throw error;
      return data || null;
    },
    async reconcileAppAccessAtomically({ eventId, entitlement, events }) {
      return await reconcileAppAccessWithRpc(admin(), { eventId, entitlement, events });
    },
  };

  Deno.serve(async (req: Request): Promise<Response> => await handleStripeWebhook(req, deps));
}
