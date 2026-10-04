// sms-send Edge Function tests: server-side app-access enforcement + preserved
// own-number SMS behavior.
//
// Harness: node:test + node:assert/strict (zero network/external imports), the
// accepted Node-runnable convention for VibeSpace Supabase function modules
// (Deno is not installed here; `deno test` is reported SKIPPED). The pure
// handler `handleSmsSend` is imported from ./index.ts; importing that module
// performs NO Deno/env/network effects because the SDK import and Deno.serve
// live behind `import.meta.main`. Every external collaborator (auth, access
// RPC, phone lookup, rate/budget RPCs, provider, audit) is dependency-injected
// so these tests make no live Supabase/Twilio calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSmsSend, STOP_FOOTER } from './index.ts';
import { MAX_SMS_CHARS, estimateSmsCostUsd, smsSegments } from '../_shared/budget.ts';

const USER = 'user-sms-1';
const OTHER_USER = 'user-sms-other';
const T0 = 1_750_000_000_000;
const SERVER_TO = '+15551230001'; // authenticated user's own verified number
const SERVER_FROM = '+15557650001'; // user's paired twilio sender
const DEFAULT_FROM = '+15557650000'; // company fallback sender
const SECRET_TOKEN = 'super-secret-twilio-auth-token';
const SECRET_SID = 'ACsecretaccountsid';

const ACTIVE_ACCESS = {
  status: 'active',
  enabled: true,
  canUseApp: true,
  canEdit: true,
  canExport: true,
  requiresCheckout: false,
};

function accessResponse(overrides = {}) {
  return { ...ACTIVE_ACCESS, ...overrides };
}

// Build dependency-injected context. Every tracked dep records { name, args }
// into `calls` (uniformly, even when overridden) so tests can assert effect
// ordering and inspect exact arguments (audit payloads, provider args, etc.).
function makeDeps(overrides = {}) {
  const calls = [];
  const base = {
    authenticate: async (token) => (token === 'valid-token' ? USER : null),
    getAppAccess: async () => ({ data: accessResponse(), error: null }),
    getPhone: async (userId) =>
      userId === USER ? { userPhoneNumber: SERVER_TO, twilioPhoneNumber: SERVER_FROM } : null,
    isAppAdmin: async () => false,
    rateLimitHit: async () => ({ error: null, limited: false }),
    getSmsUsedCount: async () => 1, // not first of cycle by default
    reserveBudget: async () => ({ error: null, reservation: { ok: true } }),
    settleBudget: async () => undefined,
    recordEvent: async () => undefined,
    sendSms: async () => ({ ok: true, numSegments: 1, sid: 'SMtest' }),
    config: { smsConfigured: true, defaultFromNumber: DEFAULT_FROM },
    now: () => T0,
    ...overrides,
  };
  const tracked = [
    'authenticate',
    'getAppAccess',
    'getPhone',
    'isAppAdmin',
    'rateLimitHit',
    'getSmsUsedCount',
    'reserveBudget',
    'settleBudget',
    'recordEvent',
    'sendSms',
  ];
  const deps = { config: base.config, now: base.now, calls };
  for (const name of tracked) {
    const fn = base[name];
    deps[name] = async (...args) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }
  return deps;
}

async function callHandler(deps, opts = {}) {
  const method = opts.method ?? 'POST';
  const headers = { origin: opts.origin ?? 'tauri://localhost' };
  if (opts.auth !== null) {
    headers.authorization = opts.auth === undefined ? 'Bearer valid-token' : opts.auth;
  }
  const init = { method, headers };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  const req = new Request('https://fn.vibespace.local/sms-send', init);
  const res = await handleSmsSend(req, deps);
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

function calledNames(deps) {
  return deps.calls.map((c) => c.name);
}

function findCall(deps, name) {
  return deps.calls.find((c) => c.name === name);
}

function countCalls(deps, name) {
  return deps.calls.filter((c) => c.name === name).length;
}

// The set of side-effecting collaborators that MUST NOT run before/after a
// failed access decision (zero billable/provider/audit effects).
const DOWNSTREAM_EFFECTS = [
  'getPhone',
  'isAppAdmin',
  'rateLimitHit',
  'getSmsUsedCount',
  'reserveBudget',
  'settleBudget',
  'recordEvent',
  'sendSms',
];

function assertNoDownstreamEffects(deps) {
  const names = calledNames(deps);
  for (const effect of DOWNSTREAM_EFFECTS) {
    assert.equal(names.includes(effect), false, `unexpected effect: ${effect}`);
  }
}

// --- Method and CORS -------------------------------------------------------

test('rejects non-POST methods with 405', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const { res, json } = await callHandler(makeDeps(), { method });
    assert.equal(res.status, 405, method);
    assert.equal(json.error, 'method_not_allowed', method);
  }
});

test('answers OPTIONS preflight with 204 and restrictive CORS', async () => {
  const { res } = await callHandler(makeDeps(), { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '');
  assert.equal(res.headers.get('access-control-allow-origin'), 'tauri://localhost');
});

// --- Authentication (server-side JWT) --------------------------------------

test('rejects a missing Authorization header with 401 and no effects', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, { auth: null, body: { message: 'hi' } });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthorized');
  assert.equal(calledNames(deps).includes('getAppAccess'), false);
  assertNoDownstreamEffects(deps);
});

test('rejects a non-Bearer scheme with 401', async () => {
  const { res, json } = await callHandler(makeDeps(), {
    auth: 'Basic abc',
    body: { message: 'hi' },
  });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthorized');
});

test('rejects a Bearer header with no token with 401', async () => {
  const { res } = await callHandler(makeDeps(), { auth: 'Bearer', body: { message: 'hi' } });
  assert.equal(res.status, 401);
});

test('rejects an invalid token (authenticate -> null) with 401 and no access lookup', async () => {
  const deps = makeDeps({ authenticate: async () => null });
  const { res, json } = await callHandler(deps, { body: { message: 'hi' } });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthorized');
  assert.equal(calledNames(deps).includes('getAppAccess'), false);
  assertNoDownstreamEffects(deps);
});

// --- Bounded input validation (before access lookup) -----------------------

test('rejects an unparseable JSON body with 400 bad_request', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, { body: 'not-json{{{' });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'bad_request');
  assert.equal(calledNames(deps).includes('getAppAccess'), false);
});

test('rejects an empty message with 400 empty_message', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, { body: { message: '' } });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'empty_message');
  assert.equal(calledNames(deps).includes('getAppAccess'), false);
});

test('rejects a whitespace-only message with 400 empty_message', async () => {
  const { res, json } = await callHandler(makeDeps(), { body: { message: '   ' } });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'empty_message');
});

test('rejects an over-long message with 413 message_too_long', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, {
    body: { message: 'x'.repeat(MAX_SMS_CHARS + 1) },
  });
  assert.equal(res.status, 413);
  assert.equal(json.error, 'message_too_long');
  assert.equal(json.max, MAX_SMS_CHARS);
  assert.equal(calledNames(deps).includes('getAppAccess'), false);
});

// --- Client injection is ignored -------------------------------------------

test('ignores client-supplied destination and uses the server-side own number', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, {
    body: {
      message: 'hello',
      to: '+19998887777',
      destination: '+19998887777',
      phone_number: '+19998887777',
      user_phone_number: '+19998887777',
      twilio_phone_number: '+19990000000',
      from: '+19990000000',
    },
  });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  const sent = findCall(deps, 'sendSms').args[0];
  assert.equal(sent.to, SERVER_TO);
  assert.equal(sent.from, SERVER_FROM);
  assert.notEqual(sent.to, '+19998887777');
  assert.notEqual(sent.from, '+19990000000');
});

test('ignores client-supplied access/tier/status; only authoritative get_app_access decides', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({
      data: accessResponse({ status: 'locked', canUseApp: false }),
      error: null,
    }),
  });
  const { res, json } = await callHandler(deps, {
    body: {
      message: 'hello',
      canUseApp: true,
      tier: 'pro',
      status: 'active',
      access: { canUseApp: true, status: 'active' },
      plan: 'ultra',
    },
  });
  assert.equal(res.status, 403);
  assert.equal(json.error, 'access_denied');
  assertNoDownstreamEffects(deps);
});
// --- Authoritative app-access states ---------------------------------------

test('grants access and proceeds for canUseApp=true (active)', async () => {
  const deps = makeDeps();
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(calledNames(deps).includes('sendSms'));
});

test('proceeds for every recognized authoritative canUseApp=true state, including prelaunch', async () => {
  for (const status of [
    'prelaunch',
    'trialing',
    'grace',
    'cancel_at_period_end',
    'past_due',
    'admin',
    'internal',
  ]) {
    const deps = makeDeps({
      getAppAccess: async () => ({
        data: accessResponse({
          status,
          enabled: status === 'prelaunch' ? false : true,
          canUseApp: true,
        }),
        error: null,
      }),
    });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, 200, status);
    assert.equal(json.ok, true, status);
  }
});

test('rejects locked, unknown, and unrecognized statuses even when canUseApp=true', async () => {
  for (const [status, expectedStatus, expectedError] of [
    ['locked', 403, 'access_denied'],
    ['unknown', 403, 'access_denied'],
    ['future_unrecognized_status', 502, 'access_lookup_failed'],
  ]) {
    const deps = makeDeps({
      getAppAccess: async () => ({
        data: accessResponse({ status, canUseApp: true }),
        error: null,
      }),
    });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, expectedStatus, status);
    assert.equal(json.error, expectedError, status);
    assertNoDownstreamEffects(deps);
  }
});

test('allows the exact authoritative prelaunch enabled=false canUseApp=true tuple', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({
      data: accessResponse({ status: 'prelaunch', enabled: false, canUseApp: true }),
      error: null,
    }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.ok(calledNames(deps).includes('sendSms'));
});

test('fails closed for exact locked/unknown denials with 403 and zero effects', async () => {
  for (const status of ['locked', 'unknown']) {
    const deps = makeDeps({
      getAppAccess: async () => ({
        data: accessResponse({ status, canUseApp: false }),
        error: null,
      }),
    });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, 403, status);
    assert.equal(json.error, 'access_denied', status);
    assert.equal(json.reason, status, status);
    assertNoDownstreamEffects(deps);
  }
});

test('fails closed on contradictory status tuples before all downstream effects', async () => {
  for (const decision of [
    { status: 'prelaunch', enabled: false, canUseApp: false },
    { status: 'prelaunch', enabled: true, canUseApp: true },
    { status: 'active', enabled: false, canUseApp: true },
    { status: 'locked', enabled: true, canUseApp: true },
  ]) {
    const deps = makeDeps({
      getAppAccess: async () => ({
        data: accessResponse(decision),
        error: null,
      }),
    });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, 403, JSON.stringify(decision));
    assert.equal(json.error, 'access_denied', JSON.stringify(decision));
    assertNoDownstreamEffects(deps);
  }
});

// --- Malformed / error access responses fail closed ------------------------

test('fails closed when the access RPC returns an error (502 access_lookup_failed)', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({ data: null, error: { message: 'rpc boom' } }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'access_lookup_failed');
  assertNoDownstreamEffects(deps);
});

test('fails closed when the access RPC throws (502 access_lookup_failed)', async () => {
  const deps = makeDeps({
    getAppAccess: async () => {
      throw new Error('network down');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'access_lookup_failed');
  assertNoDownstreamEffects(deps);
});

test('fails closed on malformed access data (null / non-object / non-boolean canUseApp)', async () => {
  const malformed = [
    { data: null, error: null },
    { data: 'active', error: null },
    { data: { canUseApp: true }, error: null },
    { data: { status: 7, canUseApp: true }, error: null },
    { data: { status: 'active' }, error: null },
    { data: { status: 'active', canUseApp: 'yes' }, error: null },
    { data: { status: 'active', canUseApp: 1 }, error: null },
    { data: { status: 'active', enabled: 'yes', canUseApp: true }, error: null },
  ];
  for (const result of malformed) {
    const deps = makeDeps({ getAppAccess: async () => result });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, 502, JSON.stringify(result));
    assert.equal(json.error, 'access_lookup_failed', JSON.stringify(result));
    assertNoDownstreamEffects(deps);
  }
});

test('passes only the JWT to access lookup and ignores client app-version authority', async () => {
  const deps = makeDeps();
  const { res } = await callHandler(deps, {
    body: { message: 'hello', app_version: '999.999.999-client-injected' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(findCall(deps, 'getAppAccess').args, ['valid-token']);
});

test('access error response never leaks the RPC error detail', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({ data: null, error: { message: 'secret-db-detail xyz' } }),
  });
  const { json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(json.error, 'access_lookup_failed');
  assert.equal(JSON.stringify(json).includes('secret-db-detail'), false);
});

// --- Effect ordering -------------------------------------------------------

test('queries access after auth and before any phone/rate/budget/provider/audit effect', async () => {
  const deps = makeDeps();
  const { res } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  const names = calledNames(deps);
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('authenticate') >= 0);
  assert.ok(idx('getAppAccess') > idx('authenticate'), 'access after auth');
  for (const effect of [
    'getPhone',
    'isAppAdmin',
    'rateLimitHit',
    'getSmsUsedCount',
    'reserveBudget',
    'sendSms',
    'settleBudget',
    'recordEvent',
  ]) {
    assert.ok(idx(effect) > idx('getAppAccess'), `${effect} must follow access`);
  }
  assert.ok(idx('sendSms') > idx('reserveBudget'), 'provider after budget reservation');
});

test('on access denial only authenticate + getAppAccess run; nothing else', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({
      data: accessResponse({ status: 'locked', canUseApp: false }),
      error: null,
    }),
  });
  await callHandler(deps, { body: { message: 'hello' } });
  const names = calledNames(deps);
  assert.deepEqual(names, ['authenticate', 'getAppAccess']);
});

test('access check precedes the Twilio configuration check (no config leakage before authorization)', async () => {
  const deps = makeDeps({
    getAppAccess: async () => ({
      data: accessResponse({ status: 'locked', canUseApp: false }),
      error: null,
    }),
    config: { smsConfigured: false, defaultFromNumber: '' },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 403);
  assert.equal(json.error, 'access_denied');
});

// --- Twilio configuration (after access) -----------------------------------

test('returns 503 sms_not_configured when Twilio is absent (after access granted)', async () => {
  const deps = makeDeps({ config: { smsConfigured: false, defaultFromNumber: '' } });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 503);
  assert.equal(json.error, 'sms_not_configured');
  assert.equal(calledNames(deps).includes('getPhone'), false);
  assert.equal(calledNames(deps).includes('sendSms'), false);
});

// --- Phone lookup (server-side own number) ---------------------------------

test('returns 400 no_phone_number when the user has no stored number', async () => {
  const deps = makeDeps({ getPhone: async () => null });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'no_phone_number');
  assert.equal(calledNames(deps).includes('sendSms'), false);
});

test('returns 400 no_phone_number for an empty stored number', async () => {
  const deps = makeDeps({
    getPhone: async () => ({ userPhoneNumber: '  ', twilioPhoneNumber: SERVER_FROM }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'no_phone_number');
});

test('returns 400 invalid_phone_number for a non-E.164 stored number', async () => {
  const deps = makeDeps({
    getPhone: async () => ({ userPhoneNumber: '555-123', twilioPhoneNumber: SERVER_FROM }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'invalid_phone_number');
});

test('falls back to the configured default sender when no per-user twilio number', async () => {
  const deps = makeDeps({
    getPhone: async () => ({ userPhoneNumber: SERVER_TO, twilioPhoneNumber: '' }),
  });
  const { res } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(findCall(deps, 'sendSms').args[0].from, DEFAULT_FROM);
});

test('returns 503 sms_not_configured when no valid sender is available', async () => {
  const deps = makeDeps({
    getPhone: async () => ({ userPhoneNumber: SERVER_TO, twilioPhoneNumber: '' }),
    config: { smsConfigured: true, defaultFromNumber: '' },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 503);
  assert.equal(json.error, 'sms_not_configured');
});

// --- Rate limit (fail closed) ----------------------------------------------

test('returns 429 rate_limited when the rate RPC reports limited', async () => {
  const deps = makeDeps({ rateLimitHit: async () => ({ error: null, limited: true }) });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 429);
  assert.equal(json.error, 'rate_limited');
  assert.equal(calledNames(deps).includes('reserveBudget'), false);
  assert.equal(calledNames(deps).includes('sendSms'), false);
});

test('returns 503 usage_unavailable when the rate RPC errors', async () => {
  const deps = makeDeps({
    rateLimitHit: async () => ({ error: { message: 'db' }, limited: null }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 503);
  assert.equal(json.error, 'usage_unavailable');
});

test('bounds a clock dependency throw before rate, budget, or provider effects', async () => {
  const deps = makeDeps({
    now: () => {
      throw new Error('clock secret detail');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 503);
  assert.equal(json.error, 'usage_unavailable');
  assert.equal(calledNames(deps).includes('rateLimitHit'), false);
  assert.equal(calledNames(deps).includes('reserveBudget'), false);
  assert.equal(calledNames(deps).includes('sendSms'), false);
  assert.equal(JSON.stringify(json).includes('clock secret'), false);
});
// --- Budget reservation / settlement ---------------------------------------

test('returns 402 budget_exceeded and records a blocked audit event when reservation fails', async () => {
  const deps = makeDeps({
    reserveBudget: async () => ({
      error: null,
      reservation: { ok: false, reason: 'monthly_budget_exceeded' },
    }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 402);
  assert.equal(json.error, 'budget_exceeded');
  assert.equal(json.reason, 'monthly_budget_exceeded');
  assert.equal(calledNames(deps).includes('sendSms'), false);
  const event = findCall(deps, 'recordEvent');
  assert.ok(event, 'blocked audit event recorded');
  assert.equal(event.args[2].status, 'blocked');
  assert.equal(event.args[2].error_code, 'monthly_budget_exceeded');
});

test('bounds audit failure while preserving a denied budget response', async () => {
  const deps = makeDeps({
    reserveBudget: async () => ({
      error: null,
      reservation: { ok: false, reason: 'monthly_budget_exceeded' },
    }),
    recordEvent: async () => {
      throw new Error('audit secret detail');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 402);
  assert.equal(json.error, 'budget_exceeded');
  assert.equal(countCalls(deps, 'recordEvent'), 1);
  assert.equal(JSON.stringify(json).includes('audit secret'), false);
});

test('maps 5-hour and weekly window breaches to 429 rate_window_exceeded with retry_after', async () => {
  for (const reason of ['window_5h_exceeded', 'window_weekly_exceeded']) {
    const deps = makeDeps({
      reserveBudget: async () => ({
        error: null,
        reservation: { ok: false, reason, retry_after: '2026-01-01T00:00:00.000Z' },
      }),
    });
    const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
    assert.equal(res.status, 429, reason);
    assert.equal(json.error, 'rate_window_exceeded', reason);
    assert.equal(json.reason, reason, reason);
    assert.equal(json.retry_after, '2026-01-01T00:00:00.000Z', reason);
    assert.equal(calledNames(deps).includes('sendSms'), false, reason);
  }
});

test('bounds unknown budget reasons and retry details before response or audit', async () => {
  const dependencyDetail = 'SECRET_DB_DETAIL_with_phone_+15559998888';
  const deps = makeDeps({
    reserveBudget: async () => ({
      error: null,
      reservation: { ok: false, reason: dependencyDetail, retry_after: dependencyDetail },
    }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 402);
  assert.equal(json.error, 'budget_exceeded');
  assert.equal(json.reason, 'budget');
  assert.equal(json.retry_after, null);
  assert.equal(findCall(deps, 'recordEvent').args[2].error_code, 'budget');
  assert.equal(JSON.stringify(json).includes(dependencyDetail), false);
  assert.equal(
    JSON.stringify(findCall(deps, 'recordEvent').args[2]).includes(dependencyDetail),
    false,
  );
});

test('returns 500 usage_unavailable when the reserve RPC errors', async () => {
  const deps = makeDeps({
    reserveBudget: async () => ({ error: { message: 'db' }, reservation: null }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 500);
  assert.equal(json.error, 'usage_unavailable');
});

// --- App-admin semantics (only after access authorization) -----------------

test('app admins skip budget reservation and settlement but still send and audit', async () => {
  const deps = makeDeps({ isAppAdmin: async () => true });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(calledNames(deps).includes('reserveBudget'), false);
  assert.equal(calledNames(deps).includes('settleBudget'), false);
  assert.ok(calledNames(deps).includes('sendSms'));
  const event = findCall(deps, 'recordEvent');
  assert.equal(event.args[2].estimated_cost_usd, 0);
  assert.equal(event.args[2].actual_cost_usd, 0);
  // Admin lookup happens only AFTER access authorization.
  const names = calledNames(deps);
  assert.ok(names.indexOf('isAppAdmin') > names.indexOf('getAppAccess'));
});

// --- STOP compliance footer ------------------------------------------------

test('appends the STOP footer to the first message of a cycle', async () => {
  const deps = makeDeps({ getSmsUsedCount: async () => 0 });
  const { res } = await callHandler(deps, { body: { message: 'Hello' } });
  assert.equal(res.status, 200);
  assert.equal(findCall(deps, 'sendSms').args[0].body, `Hello${STOP_FOOTER}`);
});

test('does not append the footer after the first message of a cycle', async () => {
  const deps = makeDeps({ getSmsUsedCount: async () => 3 });
  await callHandler(deps, { body: { message: 'Hello' } });
  assert.equal(findCall(deps, 'sendSms').args[0].body, 'Hello');
});

test('does not append the footer when the message already contains STOP (case-insensitive)', async () => {
  for (const message of ['Please STOP', 'stop everything', 'Reply STOP now']) {
    const deps = makeDeps({ getSmsUsedCount: async () => 0 });
    await callHandler(deps, { body: { message } });
    assert.equal(findCall(deps, 'sendSms').args[0].body, message, message);
  }
});

// --- Provider outcomes -----------------------------------------------------

test('rolls back budget and records twilio_unreachable on a provider network error', async () => {
  const deps = makeDeps({ sendSms: async () => ({ ok: false, networkError: true }) });
  const est = estimateSmsCostUsd(smsSegments('hello'));
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'sms_unavailable');
  const settle = findCall(deps, 'settleBudget');
  assert.deepEqual(settle.args, [USER, est, 0, -1]);
  const event = findCall(deps, 'recordEvent');
  assert.equal(event.args[2].status, 'error');
  assert.equal(event.args[2].error_code, 'twilio_unreachable');
});

test('rolls back budget and records twilio_<status> on a provider HTTP error', async () => {
  const deps = makeDeps({ sendSms: async () => ({ ok: false, status: 500 }) });
  const est = estimateSmsCostUsd(smsSegments('hello'));
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'sms_failed');
  const settle = findCall(deps, 'settleBudget');
  assert.deepEqual(settle.args, [USER, est, 0, -1]);
  const event = findCall(deps, 'recordEvent');
  assert.equal(event.args[2].error_code, 'twilio_500');
});

test('bounds malformed provider status before writing the audit event', async () => {
  const dependencyDetail = 'SECRET_PROVIDER_STATUS_+15559998888';
  const deps = makeDeps({ sendSms: async () => ({ ok: false, status: dependencyDetail }) });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'sms_failed');
  const eventPayload = findCall(deps, 'recordEvent').args[2];
  assert.equal(eventPayload.error_code, 'twilio_error');
  assert.equal(JSON.stringify(eventPayload).includes(dependencyDetail), false);
});

test('bounds rollback and audit dependency throws after a reserved provider failure', async () => {
  const deps = makeDeps({
    sendSms: async () => {
      throw new Error('provider secret detail');
    },
    settleBudget: async () => {
      throw new Error('settlement secret detail');
    },
    recordEvent: async () => {
      throw new Error('audit secret detail');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 502);
  assert.equal(json.error, 'sms_unavailable');
  assert.equal(countCalls(deps, 'settleBudget'), 1);
  assert.equal(countCalls(deps, 'recordEvent'), 1);
  const serialized = JSON.stringify(json);
  for (const detail of ['provider secret', 'settlement secret', 'audit secret']) {
    assert.equal(serialized.includes(detail), false);
  }
});

test('settles the actual segment cost and records the twilio sid on success', async () => {
  const deps = makeDeps({ sendSms: async () => ({ ok: true, numSegments: 2, sid: 'SMabc' }) });
  const est = estimateSmsCostUsd(smsSegments('hello'));
  const actual = estimateSmsCostUsd(2);
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.segments, 2);
  const settle = findCall(deps, 'settleBudget');
  assert.deepEqual(settle.args, [USER, est, actual, 0]);
  const event = findCall(deps, 'recordEvent');
  assert.equal(event.args[2].status, 'ok');
  assert.equal(event.args[2].twilio_sid, 'SMabc');
  assert.equal(event.args[2].actual_cost_usd, actual);
});

test('drops malformed or unbounded provider ids from the audit event', async () => {
  const dependencyDetail = `SM${'SECRET'.repeat(30)}+15559998888`;
  const deps = makeDeps({
    sendSms: async () => ({ ok: true, numSegments: 1, sid: dependencyDetail }),
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  const eventPayload = findCall(deps, 'recordEvent').args[2];
  assert.equal(eventPayload.twilio_sid, null);
  assert.equal(JSON.stringify(eventPayload).includes(dependencyDetail), false);
});

test('falls back to the estimated segment count for non-finite provider segment data', async () => {
  const deps = makeDeps({
    sendSms: async () => ({ ok: true, numSegments: Number.POSITIVE_INFINITY, sid: 'SMbounded' }),
  });
  const expectedSegments = smsSegments('hello');
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.segments, expectedSegments);
  const settle = findCall(deps, 'settleBudget');
  assert.equal(settle.args[2], estimateSmsCostUsd(expectedSegments));
  assert.equal(findCall(deps, 'recordEvent').args[2].segments, expectedSegments);
});

test('bounds audit dependency throws after a successful settled send without duplicating delivery', async () => {
  const deps = makeDeps({
    recordEvent: async () => {
      throw new Error('audit secret detail');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(countCalls(deps, 'sendSms'), 1);
  assert.equal(countCalls(deps, 'settleBudget'), 1);
  assert.equal(countCalls(deps, 'recordEvent'), 1);
  assert.equal(JSON.stringify(json).includes('audit secret'), false);
});

test('bounds settlement failure after a successful send and still records the delivered SMS once', async () => {
  const deps = makeDeps({
    settleBudget: async () => {
      throw new Error('settlement secret detail');
    },
  });
  const { res, json } = await callHandler(deps, { body: { message: 'hello' } });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(countCalls(deps, 'sendSms'), 1);
  assert.equal(countCalls(deps, 'settleBudget'), 1);
  assert.equal(countCalls(deps, 'recordEvent'), 1);
  assert.equal(JSON.stringify(json).includes('settlement secret'), false);
});

// --- Audit field bounding --------------------------------------------------

test('audit events store only bounded last-four + char counts, never full PII', async () => {
  const message = 'SECRET_MESSAGE_DO_NOT_LEAK_abc123';
  const deps = makeDeps();
  const { res } = await callHandler(deps, { body: { message } });
  assert.equal(res.status, 200);
  const event = findCall(deps, 'recordEvent');
  const payload = event.args[2];
  assert.equal(payload.to_last4, '0001');
  assert.equal(payload.to_last4.length, 4);
  assert.equal(payload.message_chars, message.length);
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(SERVER_TO), false, 'full phone leaked to audit');
  assert.equal(serialized.includes(message), false, 'message content leaked to audit');
});

// --- Secret / PII non-disclosure in responses ------------------------------

test('responses never disclose secrets, full phone numbers, message content, or provider sids', async () => {
  const message = 'SECRET_MESSAGE_DO_NOT_LEAK_abc123';
  const deps = makeDeps({
    sendSms: async () => ({ ok: true, numSegments: 1, sid: 'SMsecretsid' }),
  });
  const { json } = await callHandler(deps, { body: { message } });
  const serialized = JSON.stringify(json);
  for (const sensitive of [
    SECRET_TOKEN,
    SECRET_SID,
    SERVER_TO,
    SERVER_FROM,
    message,
    'SMsecretsid',
  ]) {
    assert.equal(serialized.includes(sensitive), false, `response leaked: ${sensitive}`);
  }
});

test('error responses never disclose secrets or full phone numbers', async () => {
  const deps = makeDeps({
    getPhone: async () => ({ userPhoneNumber: 'not-e164', twilioPhoneNumber: SERVER_FROM }),
  });
  const { json } = await callHandler(deps, { body: { message: 'hello' } });
  const serialized = JSON.stringify(json);
  for (const sensitive of [SECRET_TOKEN, SECRET_SID, SERVER_TO, SERVER_FROM]) {
    assert.equal(serialized.includes(sensitive), false, `error leaked: ${sensitive}`);
  }
});
