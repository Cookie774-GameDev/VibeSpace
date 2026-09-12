// @ts-nocheck
// index.test.ts - focused, network-free integration tests for the stripe-webhook
// Edge Function handler (./index.ts) wiring the committed pure app-access
// reconciler (./appAccess.ts) into the real signature-verifying webhook.
//
// These tests exercise the exported `handleStripeWebhook(req, deps)` handler with
// fully injected/mocked dependencies, so they NEVER touch the network and never
// call live Stripe/Supabase. Production wiring (esm.sh SDK imports + Deno.serve)
// lives behind an `import.meta.main` guard in index.ts and is not loaded here.
//
// A minimal Deno.test shim lets this suite run under both Deno (if installed) and
// a Node >=23 type-stripping harness (Deno is absent in this environment;
// `node --test <file>` executes it through the shim).
//
// Run (Node, no network): node --test supabase/functions/stripe-webhook/index.test.ts
// Run (Deno, if present):  deno test --allow-env supabase/functions/stripe-webhook/index.test.ts

import { test as __nodeTest } from 'node:test';
import {
  applyLegacyPlanToDb,
  claimSubscriptionEvent,
  handleStripeWebhook,
  reconcileAppAccessWithRpc,
} from './index.ts';

if (typeof globalThis.Deno === 'undefined') {
  globalThis.Deno = {
    test(name, fn) {
      return __nodeTest(name, fn);
    },
  };
}

// --- assertion helpers (self-contained; no external deps) -------------------
class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}
function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg || 'expected condition to be true');
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}
function assertEquals(actual, expected, msg) {
  if (!deepEqual(actual, expected)) {
    throw new AssertionError(
      (msg ? msg + ': ' : '') +
        'expected ' +
        JSON.stringify(expected) +
        ' but got ' +
        JSON.stringify(actual),
    );
  }
}
function assertStringIncludes(haystack, needle, msg) {
  if (typeof haystack !== 'string' || haystack.indexOf(needle) === -1) {
    throw new AssertionError(
      (msg ? msg + ': ' : '') + 'expected string to include ' + JSON.stringify(needle),
    );
  }
}
function assertNotIncludes(haystack, needle, msg) {
  if (typeof haystack === 'string' && haystack.indexOf(needle) !== -1) {
    throw new AssertionError(
      (msg ? msg + ': ' : '') + 'expected string NOT to include ' + JSON.stringify(needle),
    );
  }
}
async function assertRejects(fn, msg) {
  let rejected = false;
  try {
    await fn();
  } catch (_err) {
    rejected = true;
  }
  if (!rejected) throw new AssertionError(msg || 'expected promise to reject');
}
// Every response body must be a bounded safe code: no secret material, no raw
// payload, no customer/subscription identifiers, no stack traces, no upstream
// signing/handler error detail.
const SAFE_BODIES = new Set([
  'Jarvis Stripe webhook up.\n',
  'method_not_allowed',
  'not_configured',
  'missing_signature',
  'invalid_content_length',
  'payload_too_large',
  'invalid_signature',
  'duplicate',
  'ok',
  'handler_error',
  'invalid_line_items',
]);
async function assertSafeBody(res) {
  const body = await res.text();
  assert(
    SAFE_BODIES.has(body),
    'response body is a bounded safe code, got: ' + JSON.stringify(body),
  );
  assertNotIncludes(body, 'sk_', 'no secret material in response');
  assertNotIncludes(body, 'cus_', 'no customer identifier in response');
  assertNotIncludes(body, 'sub_', 'no subscription identifier in response');
  assertNotIncludes(body, 'Error', 'no error class/message in response');
  assertNotIncludes(body, 'LEAK', 'no upstream secret in response');
  return body;
}

// --- fixtures ---------------------------------------------------------------
const KNOWN = ['price_access_usd_20', 'price_access_promo'];
const UID = '11111111-1111-4111-8111-111111111111';
const CUS = 'cus_A';
const SUB = 'sub_A';
const T0 = 1750000000; // unix seconds baseline
const DAY = 86400;
// Stripe event JSON is normally far smaller; 1 MiB leaves generous headroom
// while keeping unauthenticated request buffering far below the Edge memory cap.
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
function iso(unix) {
  return new Date(unix * 1000).toISOString();
}
function makeAppConfig(over) {
  return Object.assign({ knownPriceIds: KNOWN.slice(), graceDays: 3 }, over || {});
}
// --- mock dependency factory ------------------------------------------------
// Records every call so tests can assert behavior and ordering. No network, no
// real SDKs. The subscription_events claim mock mirrors the legacy unique
// event_id + processed semantics; the app-access mocks mirror migration
// 0032_app_access (entitlement revision precondition + unique provider_event_id).
function makeDeps(opts) {
  opts = opts || {};
  const calls = {
    verifySignature: [],
    retrieveSubscription: [],
    planForPriceId: [],
    claimEvent: [],
    markEventProcessed: [],
    getProfileIdByCustomer: [],
    applyLegacyPlan: [],
    getCurrentEntitlement: [],
    isAppAccessEventProcessed: [],
    applyAppAccess: [],
    order: [],
  };

  // Legacy durable-claim store: event_id -> { processed }.
  const claimStore = new Map();
  if (opts.preexistingClaim) {
    claimStore.set(opts.preexistingClaim.eventId, { processed: !!opts.preexistingClaim.processed });
  }

  const config = {
    configured: opts.configured === undefined ? true : opts.configured,
    appAccess: opts.appAccess || makeAppConfig(),
    billingPrices: opts.billingPrices,
  };

  const featurePlans = opts.featurePlans || { price_pro: 'pro', price_starter: 'starter' };

  const deps = {
    config,
    async verifySignature(rawBody, sig) {
      calls.verifySignature.push({ rawBody, sig });
      calls.order.push('verify');
      if (opts.invalidSignature) throw new Error('signature mismatch secret=sk_live_LEAK');
      if (opts.throwVerify) throw new Error('verify backend unavailable');
      if (opts.event !== undefined) return opts.event;
      throw new Error('no event configured');
    },
    async retrieveSubscription(subId) {
      calls.retrieveSubscription.push(subId);
      calls.order.push('subscription.retrieve');
      if (opts.throwRetrieveSubscription) throw new Error('stripe retrieve unavailable');
      if (opts.subscription !== undefined) return opts.subscription;
      return {
        id: SUB,
        customer: CUS,
        status: 'active',
        cancel_at_period_end: false,
        current_period_start: T0 - DAY,
        current_period_end: T0 + 30 * DAY,
        trial_start: null,
        trial_end: null,
        ended_at: null,
        items: { data: [{ price: { id: KNOWN[0] } }] },
      };
    },
    planForPriceId(priceId) {
      calls.planForPriceId.push(priceId);
      return Object.prototype.hasOwnProperty.call(featurePlans, priceId)
        ? featurePlans[priceId]
        : null;
    },
    now() {
      return opts.now ? opts.now() : new Date('2026-07-28T00:00:00.000Z');
    },
    async claimEvent(eventId, eventType, payload) {
      calls.claimEvent.push({ eventId, eventType });
      calls.order.push('claim');
      if (opts.throwClaim) throw new Error('claim backend unavailable secret=sk_live_LEAK');
      if (opts.claim !== undefined) return opts.claim;
      const existing = claimStore.get(eventId);
      if (existing) {
        if (existing.processed) return 'already_processed';
        return 'retry';
      }
      claimStore.set(eventId, { processed: false });
      return 'claimed';
    },
    async markEventProcessed(eventId) {
      calls.markEventProcessed.push(eventId);
      calls.order.push('mark_processed');
      if (opts.throwMarkProcessed) throw new Error('mark processed unavailable');
      const row = claimStore.get(eventId) || { processed: false };
      row.processed = true;
      claimStore.set(eventId, row);
    },
    async getProfileIdByCustomer(customerId) {
      calls.getProfileIdByCustomer.push(customerId);
      if (opts.throwGetProfile) throw new Error('profile lookup unavailable');
      if (opts.profileId !== undefined) return opts.profileId;
      return 'profile_' + customerId;
    },
    async applyLegacyPlan(input) {
      calls.applyLegacyPlan.push(input);
      calls.order.push('legacy.apply');
      if (opts.throwApplyLegacyPlan) throw new Error('legacy apply unavailable');
    },
    async getCurrentEntitlement(lookup) {
      calls.getCurrentEntitlement.push(lookup);
      calls.order.push('entitlement.read');
      if (opts.throwGetCurrentEntitlement) throw new Error('entitlement read unavailable');
      if (opts.currentRow !== undefined) return opts.currentRow;
      return null;
    },
    async isAppAccessEventProcessed(providerEventId) {
      calls.isAppAccessEventProcessed.push(providerEventId);
      if (opts.throwIsAppAccessEventProcessed) throw new Error('dedupe lookup unavailable');
      return opts.appEventProcessed === true;
    },
    async reconcileAppAccessAtomically(command) {
      calls.applyAppAccess.push(command);
      calls.order.push('appaccess.atomic');
      if (opts.throwApplyAppAccess)
        throw new Error('app-access apply unavailable secret=sk_live_LEAK');
      if (opts.applyResult !== undefined) return opts.applyResult;
      return { ok: true };
    },
  };

  return { deps, calls, claimStore };
}

Deno.test(
  'feature-plan subscription reconciles the exact hosted tier and never app access',
  async () => {
    const billingPrices = {
      addonPriceIds: {
        starter: 'price_orbit',
        pro: 'price_nova',
        ultra: 'price_singularity',
        apex: 'price_supernova',
      },
    };
    const subscription = {
      id: SUB,
      customer: CUS,
      status: 'active',
      current_period_start: T0,
      current_period_end: T0 + 30 * DAY,
      metadata: { supabase_user_id: UID, product_family: 'feature_plan', plan: 'pro' },
      items: { data: [{ price: { id: 'price_nova' } }] },
    };
    const event = {
      id: 'evt_combined_catalog',
      type: 'customer.subscription.updated',
      created: T0,
      data: { object: subscription },
    };
    const { deps, calls } = makeDeps({
      event,
      subscription,
      billingPrices,
      featurePlans: { price_nova: 'pro' },
    });
    const response = await handleStripeWebhook(
      makeReq('POST', { body: JSON.stringify(event) }),
      deps,
    );
    assertEquals(response.status, 200);
    assertEquals(calls.applyLegacyPlan.length, 1, 'hosted tier reconciled');
    assertEquals(calls.applyLegacyPlan[0].plan, 'pro');
    assertEquals(calls.applyAppAccess.length, 0, 'feature plan never grants Access');
  },
);

Deno.test('Access subscription never reconciles a feature tier', async () => {
  const billingPrices = {
    accessPriceId: KNOWN[0],
    addonPriceIds: {
      starter: 'price_orbit',
      pro: 'price_nova',
      ultra: 'price_singularity',
      apex: 'price_supernova',
    },
  };
  const event = {
    id: 'evt_access_separate',
    type: 'customer.subscription.updated',
    created: T0,
    data: {
      object: {
        id: SUB,
        customer: CUS,
        status: 'active',
        metadata: { supabase_user_id: UID, access_product: 'vibespace_access' },
        items: { data: [{ price: { id: KNOWN[0] } }] },
      },
    },
  };
  const { deps, calls } = makeDeps({ event, billingPrices, currentRow: currentRow() });
  const response = await handleStripeWebhook(
    makeReq('POST', { body: JSON.stringify(event) }),
    deps,
  );
  assertEquals(response.status, 200);
  assertEquals(calls.applyLegacyPlan.length, 0);
  assertEquals(calls.applyAppAccess.length, 1);
});

// --- verified-event builders (shape returned by deps.verifySignature) --------
function checkoutEvent(over) {
  const base = {
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    created: T0,
    data: {
      object: {
        customer: CUS,
        subscription: SUB,
        metadata: { supabase_user_id: UID, access_product: 'vibespace_access' },
      },
    },
  };
  return Object.assign(base, over || {});
}
function subscriptionEvent(type, over) {
  const base = {
    id: 'evt_sub_1',
    type: type || 'customer.subscription.updated',
    created: T0,
    data: {
      object: {
        id: SUB,
        customer: CUS,
        status: 'active',
        cancel_at_period_end: false,
        current_period_start: T0 - DAY,
        current_period_end: T0 + 30 * DAY,
        trial_start: null,
        trial_end: null,
        ended_at: null,
        metadata: null,
        items: { data: [{ price: { id: KNOWN[0] } }] },
      },
    },
  };
  const merged = Object.assign(base, over || {});
  if (over && over.object) merged.data = { object: Object.assign(base.data.object, over.object) };
  return merged;
}
function invoiceEvent(type, over) {
  const failed = type === 'invoice.payment_failed';
  const base = {
    id: 'evt_inv_1',
    type: type || 'invoice.payment_succeeded',
    created: T0,
    data: {
      object: {
        customer: CUS,
        subscription: SUB,
        paid: !failed,
        status: failed ? 'open' : 'paid',
        metadata: null,
        lines: { data: [{ price: { id: KNOWN[0] } }] },
      },
    },
  };
  const merged = Object.assign(base, over || {});
  if (over && over.object) merged.data = { object: Object.assign(base.data.object, over.object) };
  return merged;
}
// A current app_access_entitlements row in snake_case (as deps.getCurrentEntitlement
// returns it), active and owned by UID, last provider update one day before T0.
function currentRow(over) {
  return Object.assign(
    {
      user_id: UID,
      status: 'active',
      provider_status: 'active',
      provider_status_updated_at: iso(T0 - DAY),
      stripe_customer_id: CUS,
      stripe_subscription_id: SUB,
      stripe_price_id: KNOWN[0],
      current_period_start: iso(T0 - DAY),
      current_period_end: iso(T0 + 29 * DAY),
      cancel_at_period_end: false,
      last_payment_status: 'succeeded',
      access_ended_at: null,
      trial_started_at: null,
      trial_ends_at: null,
      grace_started_at: null,
      grace_ends_at: null,
      locked_at: null,
      revision: 1,
    },
    over || {},
  );
}

// --- request builder --------------------------------------------------------
function makeReq(method, o) {
  o = o || {};
  const headers = {};
  if (o.sig === undefined || o.sig !== null)
    headers['stripe-signature'] = o.sig === undefined ? 'sig_test' : o.sig;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = o.body === undefined ? '{}' : o.body;
  return new Request('https://fn.vibespace.local/stripe-webhook', init);
}

function makeTrackedBodyReq({ chunks, sig = 'sig_test', contentLength }) {
  const headers = new Headers();
  if (sig !== null) headers.set('stripe-signature', sig);
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  const state = { readCalls: 0, cancelCalls: 0, textCalls: 0 };
  let chunkIndex = 0;
  const reader = {
    async read() {
      state.readCalls += 1;
      if (chunkIndex >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[chunkIndex++] };
    },
    async cancel() {
      state.cancelCalls += 1;
    },
    releaseLock() {},
  };
  const body = {
    getReader() {
      return reader;
    },
  };
  const req = {
    method: 'POST',
    headers,
    body,
    async text() {
      state.textCalls += 1;
      const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(joined);
    },
  };
  return { req, state };
}
// ===========================================================================
// Method / configuration / signature gates
// ===========================================================================
Deno.test('GET health check returns 200 without touching any dependency', async () => {
  const { deps, calls } = makeDeps();
  const res = await handleStripeWebhook(makeReq('GET'), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), 'Jarvis Stripe webhook up.\n');
  assertEquals(calls.verifySignature.length, 0, 'no signature work for GET');
  assertEquals(calls.claimEvent.length, 0, 'no claim for GET');
});

Deno.test('rejects non-POST methods with 405 bounded code', async () => {
  const { deps } = makeDeps();
  const res = await handleStripeWebhook(makeReq('PUT'), deps);
  assertEquals(res.status, 405);
  assertEquals(await assertSafeBody(res), 'method_not_allowed');
});

Deno.test('returns 500 not_configured when webhook secrets are absent', async () => {
  const { deps, calls } = makeDeps({ configured: false, event: checkoutEvent() });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500);
  assertEquals(await assertSafeBody(res), 'not_configured');
  assertEquals(calls.verifySignature.length, 0, 'never verifies when unconfigured');
});

Deno.test('rejects a missing stripe-signature header with 400', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent() });
  const { req, state } = makeTrackedBodyReq({
    chunks: [new TextEncoder().encode('{}')],
    sig: null,
  });
  const res = await handleStripeWebhook(req, deps);
  assertEquals(res.status, 400);
  assertEquals(await assertSafeBody(res), 'missing_signature');
  assertEquals(state.textCalls, 0, 'missing signature is rejected before body consumption');
  assertEquals(state.readCalls, 0, 'missing signature never opens the body reader');
  assertEquals(calls.verifySignature.length, 0, 'no verification attempt without a signature');
});

Deno.test('rejects an oversized declared body before pulling request bytes', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent() });
  const { req, state } = makeTrackedBodyReq({
    chunks: [new TextEncoder().encode('{}')],
    contentLength: String(MAX_WEBHOOK_BODY_BYTES + 1),
  });

  const res = await handleStripeWebhook(req, deps);

  assertEquals(res.status, 413);
  assertEquals(await assertSafeBody(res), 'payload_too_large');
  assertEquals(state.textCalls, 0, 'declared oversize bypasses whole-body text allocation');
  assertEquals(state.readCalls, 0, 'declared oversize is rejected before opening the stream');
  assertEquals(calls.verifySignature.length, 0, 'oversize is rejected before Stripe verification');
  assertEquals(calls.claimEvent.length, 0, 'oversize performs no database work');
});

Deno.test(
  'rejects malformed, negative, and conflicting content lengths before reading',
  async () => {
    for (const contentLength of ['not-a-number', '-1', '12, 13']) {
      const { deps, calls } = makeDeps({ event: checkoutEvent() });
      const { req, state } = makeTrackedBodyReq({
        chunks: [new TextEncoder().encode('{}')],
        contentLength,
      });

      const res = await handleStripeWebhook(req, deps);

      assertEquals(res.status, 400, contentLength);
      assertEquals(await assertSafeBody(res), 'invalid_content_length');
      assertEquals(state.textCalls, 0, contentLength);
      assertEquals(state.readCalls, 0, contentLength);
      assertEquals(calls.verifySignature.length, 0, contentLength);
    }
  },
);

Deno.test('cancels an undeclared streamed body as soon as it crosses the byte bound', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent() });
  const { req, state } = makeTrackedBodyReq({
    chunks: [
      new Uint8Array(Math.floor(MAX_WEBHOOK_BODY_BYTES * 0.75)),
      new Uint8Array(Math.floor(MAX_WEBHOOK_BODY_BYTES * 0.5)),
      new TextEncoder().encode('must not be read'),
    ],
  });

  const res = await handleStripeWebhook(req, deps);

  assertEquals(res.status, 413);
  assertEquals(await assertSafeBody(res), 'payload_too_large');
  assertEquals(state.readCalls, 2, 'reader stops on the chunk that crosses the bound');
  assertEquals(state.cancelCalls, 1, 'overflow cancels the remaining request stream');
  assertEquals(calls.verifySignature.length, 0, 'stream overflow precedes Stripe verification');
  assertEquals(calls.claimEvent.length, 0, 'stream overflow performs no database work');
});

Deno.test('accepts an exact-bound body and preserves its raw signed text', async () => {
  const raw = 'x'.repeat(MAX_WEBHOOK_BODY_BYTES);
  const { deps, calls } = makeDeps({
    event: { id: 'evt_exact_bound', type: 'unsupported.event', data: { object: {} } },
  });

  const res = await handleStripeWebhook(makeReq('POST', { body: raw }), deps);

  assertEquals(res.status, 200);
  assertEquals(calls.verifySignature[0].rawBody, raw);
  assertEquals(calls.claimEvent.length, 1);
});

Deno.test('rejects an invalid signature with a bounded 400 and no upstream detail', async () => {
  const { deps, calls } = makeDeps({ invalidSignature: true, event: checkoutEvent() });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 400);
  const body = await assertSafeBody(res);
  assertEquals(body, 'invalid_signature');
  assertEquals(calls.verifySignature.length, 1, 'verification attempted over the raw body');
  assertEquals(calls.claimEvent.length, 0, 'no durable work before signature is verified');
});

Deno.test('verifies the signature over the raw request body bytes', async () => {
  const raw = '{"id":"evt_raw"}';
  const { deps, calls } = makeDeps({ event: checkoutEvent() });
  await handleStripeWebhook(makeReq('POST', { body: raw, sig: 'sig_abc' }), deps);
  assertEquals(calls.verifySignature[0].rawBody, raw, 'raw body passed to verifier');
  assertEquals(calls.verifySignature[0].sig, 'sig_abc', 'signature header passed to verifier');
});

// ===========================================================================
// Durable idempotency / retry semantics (subscription_events claim)
// ===========================================================================
Deno.test('processed duplicate event ids short-circuit before any reconciliation', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent(), claim: 'already_processed' });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'duplicate');
  assertEquals(calls.claimEvent.length, 1);
  assertEquals(calls.applyAppAccess.length, 0, 'no app-access write for processed duplicate');
  assertEquals(calls.applyLegacyPlan.length, 0, 'no legacy write for processed duplicate');
  assertEquals(
    calls.getCurrentEntitlement.length,
    0,
    'no entitlement read for processed duplicate',
  );
  assertEquals(calls.markEventProcessed.length, 0, 'already processed; nothing to mark');
});

Deno.test('failed/unprocessed duplicate event ids are retried and can apply', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent(), claim: 'retry' });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 1, 'retry reprocesses the app-access event');
  assertEquals(
    calls.markEventProcessed.length,
    0,
    'atomic app-access RPC completes the durable event claim',
  );
});

// ===========================================================================
// App-access events routed through the committed reconciler
// ===========================================================================
Deno.test(
  'checkout.session.completed (app access, paid) applies an active entitlement',
  async () => {
    const { deps, calls } = makeDeps({ event: checkoutEvent() });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.applyAppAccess.length, 1, 'routed through the app-access reconciler');
    const cmd = calls.applyAppAccess[0];
    assertEquals(cmd.entitlement.table, 'app_access_entitlements');
    assertEquals(cmd.entitlement.op, 'upsert');
    assertEquals(cmd.entitlement.key, { user_id: UID });
    assertEquals(cmd.entitlement.set.status, 'active');
    assertEquals(cmd.entitlement.set.provider_status, 'active');
    assertEquals(cmd.entitlement.set.stripe_price_id, KNOWN[0]);
    assertEquals(cmd.entitlement.set.stripe_subscription_id, SUB);
    assertEquals(cmd.events.length, 1);
    assertEquals(cmd.events[0].set.event_type, 'payment_succeeded');
    assertEquals(cmd.events[0].set.provider_event_id, 'evt_checkout_1');
    assertEquals(cmd.events[0].set.user_id, UID);
    assertEquals(cmd.eventId, 'evt_checkout_1');
    assertEquals(calls.applyLegacyPlan.length, 0, 'app-access never writes feature tier');
    assertEquals(calls.markEventProcessed.length, 0, 'no separate completion write');
  },
);

Deno.test(
  'checkout resolves the user from session metadata and reads no prior entitlement',
  async () => {
    const { deps, calls } = makeDeps({ event: checkoutEvent() });
    await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(calls.getCurrentEntitlement.length, 1, 'current entitlement read for app-access');
    assertEquals(
      calls.getCurrentEntitlement[0].userId,
      UID,
      'lookup keyed by metadata supabase_user_id',
    );
    assertEquals(
      calls.applyAppAccess[0].entitlement.expected_revision,
      undefined,
      'no precondition for a brand-new entitlement',
    );
  },
);

Deno.test('checkout.session.completed with a trial applies a trialing entitlement', async () => {
  const trialing = {
    id: SUB,
    customer: CUS,
    status: 'trialing',
    cancel_at_period_end: false,
    current_period_start: T0,
    current_period_end: T0 + 30 * DAY,
    trial_start: T0,
    trial_end: T0 + 14 * DAY,
    ended_at: null,
    items: { data: [{ price: { id: KNOWN[0] } }] },
  };
  const { deps, calls } = makeDeps({ event: checkoutEvent(), subscription: trialing });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(calls.applyAppAccess[0].entitlement.set.status, 'trialing');
  assertEquals(calls.applyAppAccess[0].entitlement.set.trial_ends_at, iso(T0 + 14 * DAY));
  assertEquals(calls.applyAppAccess[0].events[0].set.event_type, 'trial_started');
});

Deno.test(
  'customer.subscription.updated applies against the current owner with a revision precondition',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.updated'),
      currentRow: currentRow(),
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.applyAppAccess.length, 1);
    const cmd = calls.applyAppAccess[0];
    assertEquals(cmd.entitlement.key, { user_id: UID });
    assertEquals(
      cmd.entitlement.expected_revision,
      1,
      'optimistic revision precondition forwarded',
    );
    assertEquals(cmd.entitlement.expected_provider_status_updated_at, iso(T0 - DAY));
    assertEquals(cmd.entitlement.set.provider_status, 'active');
    assertEquals(calls.applyLegacyPlan.length, 0, 'app-access never writes feature tier');
  },
);

Deno.test(
  'customer.subscription.updated with cancel_at_period_end keeps access and marks it',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.updated', {
        object: { cancel_at_period_end: true },
      }),
      currentRow: currentRow(),
    });
    await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(calls.applyAppAccess[0].entitlement.set.status, 'cancel_at_period_end');
    assertEquals(calls.applyAppAccess[0].entitlement.set.cancel_at_period_end, true);
  },
);

Deno.test(
  'customer.subscription.deleted (terminal) applies a grace entitlement with end-state audits',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.deleted', {
        object: { status: 'canceled', ended_at: T0 },
      }),
      currentRow: currentRow(),
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    const cmd = calls.applyAppAccess[0];
    assertEquals(cmd.entitlement.set.status, 'grace');
    assertEquals(cmd.entitlement.set.access_ended_at, iso(T0));
    const types = cmd.events.map((e) => e.set.event_type);
    assert(types.indexOf('subscription_cancelled') !== -1, 'has subscription_cancelled audit');
    assert(types.indexOf('grace_started') !== -1, 'has grace_started audit');
  },
);

Deno.test('invoice.payment_failed against an active entitlement applies past_due', async () => {
  const { deps, calls } = makeDeps({
    event: invoiceEvent('invoice.payment_failed'),
    currentRow: currentRow(),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  const cmd = calls.applyAppAccess[0];
  assertEquals(cmd.entitlement.set.status, 'past_due');
  assertEquals(cmd.entitlement.set.last_payment_status, 'failed');
  assertEquals(cmd.events[0].set.event_type, 'payment_failed');
});

Deno.test('invoice.payment_succeeded recovers a past_due entitlement to active', async () => {
  const { deps, calls } = makeDeps({
    event: invoiceEvent('invoice.payment_succeeded'),
    currentRow: currentRow({ status: 'past_due', provider_status: 'past_due' }),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  const cmd = calls.applyAppAccess[0];
  assertEquals(cmd.entitlement.set.status, 'active');
  assertEquals(cmd.entitlement.set.last_payment_status, 'succeeded');
  assertEquals(cmd.events[0].set.event_type, 'access_restored');
});
// ===========================================================================
// Duplicate / retry / ordering safety for app-access events
// ===========================================================================
Deno.test(
  'provider_event_id replay is resolved by the atomic reconciliation boundary',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.updated'),
      currentRow: currentRow(),
      claim: 'claimed',
      applyResult: { ok: true, reason: 'duplicate' },
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.isAppAccessEventProcessed.length, 0, 'no separate dedupe read');
    assertEquals(calls.applyAppAccess.length, 1, 'atomic RPC resolves replay under claim lock');
    assertEquals(calls.markEventProcessed.length, 0, 'atomic RPC completes the durable claim');
  },
);

Deno.test(
  'out-of-order (older) app-access event is ignored without regressing entitlement',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.updated'),
      currentRow: currentRow({ provider_status_updated_at: iso(T0 + DAY) }),
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.applyAppAccess.length, 0, 'stale event never writes');
    assertEquals(calls.applyLegacyPlan.length, 0, 'stale event never touches feature tier');
  },
);

Deno.test('equal-time active update cannot broaden a locked entitlement', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated'),
    currentRow: currentRow({
      status: 'locked',
      provider_status: 'canceled',
      provider_status_updated_at: iso(T0),
      access_ended_at: iso(T0),
      grace_started_at: iso(T0),
      grace_ends_at: iso(T0),
      locked_at: iso(T0),
    }),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0, 'equal-time broadening never reaches atomic RPC');
  assertEquals(calls.markEventProcessed[0], 'evt_sub_1', 'permanent stale event is completed');
  assertEquals(calls.applyLegacyPlan.length, 0, 'app-access stale event remains isolated');
});

Deno.test('terminal entitlement cannot be resurrected by a later invoice delivery', async () => {
  const { deps, calls } = makeDeps({
    event: invoiceEvent('invoice.payment_succeeded'),
    currentRow: currentRow({ status: 'locked', provider_status: 'canceled' }),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(calls.applyAppAccess.length, 0, 'terminal subscription invoice is stale');
});

Deno.test('ambiguous multiple app-access prices fail closed with no mutation', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated', {
      object: { items: { data: [{ price: { id: KNOWN[0] } }, { price: { id: KNOWN[1] } }] } },
    }),
    currentRow: currentRow(),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0, 'ambiguous prices never write');
  assertEquals(calls.applyLegacyPlan.length, 0, 'ambiguous prices never grant feature tier');
});

Deno.test(
  'access-product event with an unknown price is ignored and grants no feature tier',
  async () => {
    const mystery = {
      id: SUB,
      customer: CUS,
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: T0 - DAY,
      current_period_end: T0 + 30 * DAY,
      trial_start: null,
      trial_end: null,
      ended_at: null,
      items: { data: [{ price: { id: 'price_mystery' } }] },
    };
    const { deps, calls } = makeDeps({ event: checkoutEvent(), subscription: mystery });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.applyAppAccess.length, 0, 'unknown price never writes app-access');
    assertEquals(
      calls.applyLegacyPlan.length,
      0,
      'unknown app-access price never grants feature tier',
    );
  },
);

Deno.test('customer.subscription.trial_will_end is a harmless no-op', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.trial_will_end', {
      object: { status: 'trialing', trial_start: T0, trial_end: T0 + 3 * DAY },
    }),
    currentRow: currentRow({ status: 'trialing', provider_status: 'trialing' }),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0, 'informational event never writes');
  assertEquals(calls.markEventProcessed[0], 'evt_sub_1');
});

// ===========================================================================
// Malformed / unsupported payloads are harmlessly acknowledged
// ===========================================================================
Deno.test('a subscription event with a null object is acknowledged without crashing', async () => {
  const { deps, calls } = makeDeps({
    event: {
      id: 'evt_bad',
      type: 'customer.subscription.updated',
      created: T0,
      data: { object: null },
    },
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0);
  assertEquals(calls.applyLegacyPlan.length, 0);
});

Deno.test('an unsupported event type is harmlessly acknowledged', async () => {
  const { deps, calls } = makeDeps({
    event: { id: 'evt_x', type: 'customer.discount.created', created: T0, data: { object: {} } },
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0);
  assertEquals(calls.applyLegacyPlan.length, 0);
});

Deno.test('a checkout without a subscription is acknowledged without mutation', async () => {
  const { deps, calls } = makeDeps({
    event: {
      id: 'evt_co_nosub',
      type: 'checkout.session.completed',
      created: T0,
      data: { object: { customer: CUS, subscription: null, metadata: null } },
    },
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 0);
  assertEquals(calls.applyLegacyPlan.length, 0);
});

// ===========================================================================
// Legacy voice/subscription reconciliation coexists and stays separate
// ===========================================================================
Deno.test(
  'feature subscription.updated grants feature tier and never touches app-access',
  async () => {
    const { deps, calls } = makeDeps({
      event: subscriptionEvent('customer.subscription.updated', {
        object: { items: { data: [{ price: { id: 'price_pro' } }] } },
      }),
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(await assertSafeBody(res), 'ok');
    assertEquals(calls.applyLegacyPlan.length, 1, 'legacy reconciliation runs for feature tier');
    assertEquals(calls.applyLegacyPlan[0].plan, 'pro');
    assertEquals(calls.applyLegacyPlan[0].customerId, CUS);
    assertEquals(calls.applyAppAccess.length, 0, 'feature event never writes app-access');
    assertEquals(
      calls.getCurrentEntitlement.length,
      0,
      'feature event never reads app-access entitlement',
    );
    assertEquals(calls.markEventProcessed[0], 'evt_sub_1');
  },
);

Deno.test('feature subscription.deleted revokes to free tier', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.deleted', {
      object: {
        status: 'canceled',
        ended_at: T0,
        items: { data: [{ price: { id: 'price_pro' } }] },
      },
    }),
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(calls.applyLegacyPlan.length, 1);
  assertEquals(calls.applyLegacyPlan[0].plan, 'free');
  assertEquals(calls.applyAppAccess.length, 0);
});

Deno.test(
  'feature invoice.payment_failed keeps paid access during dunning (does not free)',
  async () => {
    const featureActive = {
      id: SUB,
      customer: CUS,
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: T0 - DAY,
      current_period_end: T0 + 30 * DAY,
      trial_start: null,
      trial_end: null,
      ended_at: null,
      items: { data: [{ price: { id: 'price_pro' } }] },
    };
    const { deps, calls } = makeDeps({
      event: invoiceEvent('invoice.payment_failed', {
        object: { lines: { data: [{ price: { id: 'price_pro' } }] } },
      }),
      subscription: featureActive,
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(calls.applyLegacyPlan.length, 1, 'dunning syncs the subscription but keeps paid');
    assertEquals(calls.applyLegacyPlan[0].plan, 'pro', 'paid plan retained during past_due');
    assertEquals(calls.applyAppAccess.length, 0);
  },
);

Deno.test(
  'feature checkout.session.completed grants feature tier and never app-access',
  async () => {
    const featureActive = {
      id: SUB,
      customer: CUS,
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: T0 - DAY,
      current_period_end: T0 + 30 * DAY,
      trial_start: null,
      trial_end: null,
      ended_at: null,
      items: { data: [{ price: { id: 'price_pro' } }] },
    };
    const { deps, calls } = makeDeps({
      event: {
        id: 'evt_co_feature',
        type: 'checkout.session.completed',
        created: T0,
        data: { object: { customer: CUS, subscription: SUB, metadata: null } },
      },
      subscription: featureActive,
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(calls.applyLegacyPlan.length, 1);
    assertEquals(calls.applyLegacyPlan[0].plan, 'pro');
    assertEquals(calls.applyAppAccess.length, 0);
  },
);

Deno.test(
  'checkout without routing metadata uses the authoritative subscription price for app-access',
  async () => {
    const { deps, calls } = makeDeps({
      event: {
        id: 'evt_co_access_no_metadata',
        type: 'checkout.session.completed',
        created: T0,
        data: {
          object: {
            customer: CUS,
            subscription: SUB,
            metadata: { supabase_user_id: UID },
          },
        },
      },
    });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    assertEquals(calls.applyAppAccess.length, 1, 'known server-side price routes to app-access');
    assertEquals(calls.applyLegacyPlan.length, 0, 'access price never reaches feature-tier writes');
  },
);
// ===========================================================================
// Database error handling, concurrency, and bounded-error guarantees
// ===========================================================================
Deno.test('a durable-claim database error returns a bounded 500 and does no work', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent(), throwClaim: true });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500);
  assertEquals(await assertSafeBody(res), 'handler_error');
  assertEquals(calls.applyAppAccess.length, 0);
  assertEquals(calls.markEventProcessed.length, 0, 'left unprocessed so Stripe retries');
});

Deno.test('an app-access apply error returns a bounded 500 and stays unprocessed', async () => {
  const { deps, calls } = makeDeps({
    event: checkoutEvent(),
    applyResult: { ok: false, reason: 'error' },
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500);
  assertEquals(await assertSafeBody(res), 'handler_error');
  assertEquals(calls.markEventProcessed.length, 0, 'failed apply remains retryable');
});

Deno.test(
  'an app-access apply exception returns a bounded 500 without leaking secrets',
  async () => {
    const { deps, calls } = makeDeps({ event: checkoutEvent(), throwApplyAppAccess: true });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 500);
    assertEquals(await assertSafeBody(res), 'handler_error');
    assertEquals(calls.markEventProcessed.length, 0);
  },
);

Deno.test('a concurrent revision conflict refuses the write and requests a retry', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated'),
    currentRow: currentRow(),
    applyResult: { ok: false, reason: 'conflict' },
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500, 'conflict requests a retry against the newer row');
  assertEquals(await assertSafeBody(res), 'handler_error');
  assertEquals(calls.applyAppAccess.length, 1);
  assertEquals(
    calls.applyAppAccess[0].entitlement.expected_revision,
    1,
    'write carried the revision precondition',
  );
  assertEquals(
    calls.markEventProcessed.length,
    0,
    'left unprocessed so a redelivery re-reconciles',
  );
  assertEquals(calls.applyLegacyPlan.length, 0, 'conflict never touches feature tier');
});

Deno.test('concurrent equal-time retry converges on the restrictive state', async () => {
  const event = subscriptionEvent('customer.subscription.updated');
  const first = makeDeps({
    event,
    currentRow: currentRow({
      provider_status_updated_at: iso(T0),
      current_period_end: iso(T0 + 30 * DAY),
    }),
    applyResult: { ok: false, reason: 'conflict' },
  });
  const firstResponse = await handleStripeWebhook(makeReq('POST'), first.deps);
  assertEquals(firstResponse.status, 500, 'concurrent revision advance requests retry');
  assertEquals(first.calls.applyAppAccess.length, 1);

  const retry = makeDeps({
    event,
    claim: 'retry',
    currentRow: currentRow({
      status: 'past_due',
      provider_status: 'past_due',
      provider_status_updated_at: iso(T0),
      current_period_end: iso(T0 + 30 * DAY),
      last_payment_status: 'failed',
      revision: 2,
    }),
  });
  const retryResponse = await handleStripeWebhook(makeReq('POST'), retry.deps);
  assertEquals(retryResponse.status, 200);
  assertEquals(await assertSafeBody(retryResponse), 'ok');
  assertEquals(retry.calls.applyAppAccess.length, 0, 'equal-time retry cannot restore active');
  assertEquals(retry.calls.markEventProcessed[0], 'evt_sub_1', 'stale retry is completed');
});

Deno.test('app-access success does not depend on a separate processed-mark write', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent(), throwMarkProcessed: true });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.applyAppAccess.length, 1, 'one atomic reconciliation completed');
  assertEquals(calls.markEventProcessed.length, 0, 'separate processed mark was never attempted');
});

Deno.test('a legacy processed-mark failure returns 500 so Stripe retries', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated', {
      object: { items: { data: [{ price: { id: 'price_pro' } }] } },
    }),
    throwMarkProcessed: true,
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500);
  assertEquals(await assertSafeBody(res), 'handler_error');
  assertEquals(
    calls.applyLegacyPlan.length,
    1,
    'idempotent legacy write completed before mark failed',
  );
});

Deno.test('durable claim rejects a non-unique insert failure', async () => {
  const db = {
    from() {
      return {
        async insert() {
          return { error: { code: '42501', message: 'permission denied' } };
        },
      };
    },
  };
  await assertRejects(
    () => claimSubscriptionEvent(db, 'evt_claim', 'customer.subscription.updated', {}),
    'non-duplicate insert failures must not process without a durable claim',
  );
});

Deno.test('durable retry claim checks the refresh update result', async () => {
  let call = 0;
  const db = {
    from() {
      call += 1;
      if (call === 1) {
        return {
          async insert() {
            return { error: { code: '23505', message: 'duplicate' } };
          },
        };
      }
      if (call === 2) {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: { processed: false }, error: null };
          },
        };
      }
      return {
        update() {
          return this;
        },
        eq() {
          return this;
        },
        select() {
          return this;
        },
        async maybeSingle() {
          return { data: null, error: { code: 'XX000', message: 'write failed' } };
        },
      };
    },
  };
  await assertRejects(
    () => claimSubscriptionEvent(db, 'evt_retry', 'customer.subscription.updated', {}),
    'failed retry refresh must stay retryable',
  );
});

Deno.test('legacy database adapter checks profile update failures', async () => {
  let call = 0;
  const db = {
    from() {
      call += 1;
      if (call === 1) {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: { id: UID }, error: null };
          },
        };
      }
      return {
        update() {
          return this;
        },
        eq() {
          return this;
        },
        select() {
          return this;
        },
        async maybeSingle() {
          return { data: null, error: { code: 'XX000', message: 'write failed' } };
        },
      };
    },
  };
  await assertRejects(
    () => applyLegacyPlanToDb(db, CUS, 'pro', null, iso(T0)),
    'legacy profile mutation errors must propagate',
  );
});

Deno.test('production app-access adapter makes one bounded atomic RPC call', async () => {
  const calls = [];
  const db = {
    async rpc(name, params) {
      calls.push({ name, params });
      return { data: 'applied', error: null };
    },
  };
  const result = await reconcileAppAccessWithRpc(db, {
    eventId: 'evt_atomic_adapter',
    entitlement: {
      key: { user_id: UID },
      expected_revision: 7,
      expected_provider_status_updated_at: iso(T0 - DAY),
      set: { status: 'active' },
    },
    events: [{ set: { event_type: 'payment_succeeded' } }],
  });
  assertEquals(result, { ok: true, reason: 'applied' });
  assertEquals(calls.length, 1, 'exactly one database RPC call');
  assertEquals(calls[0].name, 'app_access_reconcile_event');
  assertEquals(calls[0].params.p_event_id, 'evt_atomic_adapter');
  assertEquals(calls[0].params.p_expected_revision, 7);
  assertEquals(calls[0].params.p_entitlement, { status: 'active' });
  assertEquals(calls[0].params.p_events, [{ event_type: 'payment_succeeded' }]);
});

Deno.test('production atomic RPC adapter maps conflict and errors to bounded results', async () => {
  const command = {
    eventId: 'evt_atomic_adapter',
    entitlement: { key: { user_id: UID }, set: {} },
    events: [],
  };
  const conflict = await reconcileAppAccessWithRpc(
    {
      async rpc() {
        return { data: 'conflict', error: null };
      },
    },
    command,
  );
  assertEquals(conflict, { ok: false, reason: 'conflict' });
  const failed = await reconcileAppAccessWithRpc(
    {
      async rpc() {
        return { data: null, error: { message: 'secret backend detail' } };
      },
    },
    command,
  );
  assertEquals(failed, { ok: false, reason: 'error' });
});

Deno.test('an entitlement-read database error returns a bounded 500', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated'),
    throwGetCurrentEntitlement: true,
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 500);
  assertEquals(await assertSafeBody(res), 'handler_error');
  assertEquals(calls.applyAppAccess.length, 0);
});

Deno.test(
  'a subscription-retrieval failure during app-access checkout returns a bounded 500',
  async () => {
    const { deps, calls } = makeDeps({ event: checkoutEvent(), throwRetrieveSubscription: true });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 500);
    assertEquals(await assertSafeBody(res), 'handler_error');
    assertEquals(calls.applyAppAccess.length, 0);
  },
);

Deno.test('app-access handling does not depend on a separate provider-event lookup', async () => {
  const { deps, calls } = makeDeps({
    event: subscriptionEvent('customer.subscription.updated'),
    currentRow: currentRow(),
    throwIsAppAccessEventProcessed: true,
  });
  const res = await handleStripeWebhook(makeReq('POST'), deps);
  assertEquals(res.status, 200);
  assertEquals(await assertSafeBody(res), 'ok');
  assertEquals(calls.isAppAccessEventProcessed.length, 0);
  assertEquals(calls.applyAppAccess.length, 1);
});

Deno.test('verifies and claims before applying (durable ordering)', async () => {
  const { deps, calls } = makeDeps({ event: checkoutEvent() });
  await handleStripeWebhook(makeReq('POST'), deps);
  const verify = calls.order.indexOf('verify');
  const claim = calls.order.indexOf('claim');
  const apply = calls.order.indexOf('appaccess.atomic');
  const mark = calls.order.indexOf('mark_processed');
  assert(verify !== -1 && claim !== -1 && apply !== -1, 'all required stages ran');
  assert(verify < claim, 'signature verified before durable claim');
  assert(claim < apply, 'durable claim before atomic app-access reconciliation');
  assertEquals(mark, -1, 'atomic RPC includes processed completion');
});

Deno.test('makes no network calls: every provider interaction is injected', async () => {
  const prevFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (...args) => {
    fetchCount += 1;
    throw new Error('network disabled in tests');
  };
  try {
    const { deps } = makeDeps({ event: checkoutEvent() });
    const res = await handleStripeWebhook(makeReq('POST'), deps);
    assertEquals(res.status, 200);
    await res.text();
  } finally {
    globalThis.fetch = prevFetch;
  }
  assertEquals(fetchCount, 0, 'handler performs no real fetch');
});
