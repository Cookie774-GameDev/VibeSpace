// index.test.ts - focused dependency-injected tests for call-start.
// Run: node --test supabase/functions/call-start/index.test.ts
// No Deno, no env, no network, no live Supabase/Twilio, no credentials.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleCallStart } from './index.ts';
import type { HandlerDeps, AppAccessResponse, ProviderResult, ReservationResult } from './index.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAccess(overrides: Partial<AppAccessResponse> = {}): AppAccessResponse {
  return {
    status: 'active',
    enabled: true,
    serverTime: new Date().toISOString(),
    canUseApp: true,
    canEdit: true,
    canExport: true,
    requiresCheckout: false,
    checkoutReason: null,
    ...overrides,
  };
}

interface CallLog {
  order: string[];
}

function makeDeps(overrides: Partial<HandlerDeps> = {}, log?: CallLog): HandlerDeps {
  const track = (name: string) => () => {
    log?.order.push(name);
  };
  return {
    getUser: async (_jwt: string) => {
      track('getUser')();
      return 'user-1';
    },
    getAppAccess: async (_jwt: string, _v?: string) => {
      track('getAppAccess')();
      return makeAccess();
    },
    isProviderConfigured: () => {
      track('isProviderConfigured')();
      return true;
    },
    reserveBudget: async () => {
      track('reserveBudget')();
      return { ok: true } as ReservationResult;
    },
    settleBudget: async () => {
      track('settleBudget')();
    },
    callProvider: async () => {
      track('callProvider')();
      return { ok: true, status: 201, body: { sid: 'CA123' } } as ProviderResult;
    },
    recordEvent: async () => {
      track('recordEvent')();
    },
    estimateCost: (seconds: number) => (Math.max(0, seconds) / 60) * 0.1,
    minReserveSeconds: 60,
    maxCallSeconds: 1800,
    appVersion: '1.2.3',
    ...overrides,
  };
}

function postReq(
  body: unknown,
  opts: { jwt?: string; method?: string; origin?: string } = {},
): Request {
  const { jwt = 'valid-jwt', method = 'POST', origin = 'tauri://localhost' } = opts;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (jwt) headers['authorization'] = `Bearer ${jwt}`;
  if (origin) headers['origin'] = origin;
  return new Request('http://localhost/call-start', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

const VALID_NUMBER = '+15551234567';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('call-start handler', () => {
  let log: CallLog;
  beforeEach(() => {
    log = { order: [] };
  });

  // ── Method / Auth ───────────────────────────────────────────────────────

  describe('method and auth', () => {
    it('rejects non-POST methods with 405', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({}, { method: 'GET' }));
      assert.equal(res.status, 405);
      const b = await json(res);
      assert.equal(b.error, 'method_not_allowed');
    });

    it('handles OPTIONS preflight', async () => {
      const req = new Request('http://localhost/call-start', {
        method: 'OPTIONS',
        headers: { origin: 'tauri://localhost' },
      });
      const res = await handleCallStart(makeDeps({}, log), req);
      assert.equal(res.status, 204);
      assert.equal(await res.text(), '');
      assert.ok(res.headers.get('access-control-allow-origin'));
    });

    it('rejects missing JWT with 401', async () => {
      const res = await handleCallStart(
        makeDeps({}, log),
        postReq({ to: VALID_NUMBER }, { jwt: '' }),
      );
      assert.equal(res.status, 401);
      const b = await json(res);
      assert.equal(b.error, 'unauthorized');
    });

    it('rejects invalid JWT with 401', async () => {
      const deps = makeDeps({ getUser: async () => null }, log);
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 401);
      const b = await json(res);
      assert.equal(b.error, 'unauthorized');
    });

    it('bounds authentication dependency failures without starting downstream work', async () => {
      const deps = makeDeps(
        {
          getUser: async () => {
            throw new Error('sensitive auth failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.deepEqual(b, { error: 'auth_unavailable' });
      assert.deepEqual(log.order, []);
    });
  });

  // ── Input validation ────────────────────────────────────────────────────

  describe('input validation', () => {
    it('rejects malformed JSON body with 400', async () => {
      const req = new Request('http://localhost/call-start', {
        method: 'POST',
        headers: {
          authorization: 'Bearer x',
          'content-type': 'application/json',
          origin: 'tauri://localhost',
        },
        body: 'not-json{{{',
      });
      const res = await handleCallStart(makeDeps({}, log), req);
      assert.equal(res.status, 400);
      const b = await json(res);
      assert.equal(b.error, 'bad_request');
    });

    it('rejects a missing number with 400 invalid_number', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({}));
      assert.equal(res.status, 400);
      const b = await json(res);
      assert.equal(b.error, 'invalid_number');
    });

    it('rejects non-E.164 numbers with 400 invalid_number', async () => {
      const bad = ['5551234567', '+0123456789', '+1', '+1abc2345678', 'not-a-number'];
      for (const to of bad) {
        const res = await handleCallStart(makeDeps({}, log), postReq({ to }));
        assert.equal(res.status, 400, `case: ${to}`);
        const b = await json(res);
        assert.equal(b.error, 'invalid_number', `case: ${to}`);
      }
    });

    it('number validation runs before the access check', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({ to: 'bad' }));
      assert.equal(res.status, 400);
      assert.ok(!log.order.includes('getAppAccess'), 'no access check on invalid number');
    });
  });

  // ── Access enforcement ──────────────────────────────────────────────────

  describe('app-access enforcement', () => {
    it('allows active canUseApp=true through to the provider', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 200);
    });

    it('rejects locked status with 403 access_locked', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () =>
            makeAccess({ status: 'locked', canUseApp: false, requiresCheckout: true }),
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 403);
      const b = await json(res);
      assert.equal(b.error, 'access_locked');
      assert.equal(b.access_status, 'locked');
      assert.equal(b.requires_checkout, true);
    });

    it('allows the authoritative prelaunch canUseApp=true decision', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () =>
            makeAccess({ status: 'prelaunch', canUseApp: true, enabled: false }),
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 200);
      assert.ok(
        log.order.includes('callProvider'),
        'prelaunch development access reaches provider',
      );
    });

    it('rejects unknown status with 403 access_denied', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => makeAccess({ status: 'unknown', canUseApp: false }) },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 403);
      const b = await json(res);
      assert.equal(b.error, 'access_denied');
      assert.equal(b.access_status, 'unknown');
    });

    it('fails closed when a usable state disagrees with canUseApp', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () =>
            makeAccess({ status: 'active', canUseApp: false, enabled: false }),
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'access_unavailable');
      assert.ok(!log.order.includes('reserveBudget'), 'inconsistent authority reserves no budget');
    });

    it('fails closed when enabled contradicts the authoritative status', async () => {
      for (const access of [
        makeAccess({ status: 'active', enabled: false, canUseApp: true }),
        makeAccess({ status: 'prelaunch', enabled: true, canUseApp: true }),
      ]) {
        const caseLog: CallLog = { order: [] };
        const deps = makeDeps({ getAppAccess: async () => access }, caseLog);
        const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
        assert.equal(res.status, 503, `case: ${access.status}`);
        assert.deepEqual(await json(res), { error: 'access_unavailable' });
        assert.ok(!caseLog.order.includes('reserveBudget'), 'contradiction reserves no budget');
      }
    });

    it('allows every authoritative usable state with canUseApp=true', async () => {
      for (const status of [
        'trialing',
        'cancel_at_period_end',
        'past_due',
        'grace',
        'admin',
        'internal',
      ]) {
        const caseLog: CallLog = { order: [] };
        const deps = makeDeps(
          { getAppAccess: async () => makeAccess({ status, canUseApp: true }) },
          caseLog,
        );
        const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
        assert.equal(res.status, 200, `case: ${status}`);
        assert.ok(caseLog.order.includes('callProvider'), `provider called for ${status}`);
      }
    });

    it('fails closed on unknown or unrecognized states even when canUseApp is true', async () => {
      for (const status of ['unknown', 'ended', 'future_state']) {
        const caseLog: CallLog = { order: [] };
        const deps = makeDeps(
          { getAppAccess: async () => makeAccess({ status, canUseApp: true }) },
          caseLog,
        );
        const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
        assert.equal(res.status, 503, `case: ${status}`);
        const b = await json(res);
        assert.equal(b.error, 'access_unavailable', `case: ${status}`);
        assert.ok(!caseLog.order.includes('reserveBudget'), `no budget reserved for ${status}`);
      }
    });

    it('fails closed when locked or prelaunch disagrees with its authoritative boolean', async () => {
      for (const access of [
        makeAccess({ status: 'locked', canUseApp: true }),
        makeAccess({ status: 'prelaunch', canUseApp: false, enabled: false }),
      ]) {
        const caseLog: CallLog = { order: [] };
        const deps = makeDeps({ getAppAccess: async () => access }, caseLog);
        const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
        assert.equal(res.status, 503, `case: ${access.status}`);
        const b = await json(res);
        assert.equal(b.error, 'access_unavailable', `case: ${access.status}`);
        assert.ok(!caseLog.order.includes('reserveBudget'), 'no budget reserved');
      }
    });

    it('fails closed on RPC error (null response)', async () => {
      const deps = makeDeps({ getAppAccess: async () => null }, log);
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'access_unavailable');
    });

    it('fails closed on RPC throw', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () => {
            throw new Error('rpc fail');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'access_unavailable');
    });

    it('fails closed on malformed response (missing canUseApp)', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => ({ status: 'active' }) as unknown as AppAccessResponse },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'access_unavailable');
    });

    it('fails closed on malformed response (missing status)', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => ({ canUseApp: true }) as unknown as AppAccessResponse },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
    });

    it('fails closed on non-boolean canUseApp', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () =>
            ({ status: 'active', canUseApp: 'true' }) as unknown as AppAccessResponse,
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'access_unavailable');
    });

    it('fails closed without echoing malformed checkout metadata', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () =>
            ({
              ...makeAccess({ status: 'locked', canUseApp: false }),
              requiresCheckout: 'sensitive rpc detail',
            }) as unknown as AppAccessResponse,
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.deepEqual(b, { error: 'access_unavailable' });
    });

    it('access denial performs no reservation, provider call, settlement, or audit', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => makeAccess({ status: 'locked', canUseApp: false }) },
        log,
      );
      await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.ok(!log.order.includes('reserveBudget'), 'no budget reservation');
      assert.ok(!log.order.includes('isProviderConfigured'), 'no provider config check');
      assert.ok(!log.order.includes('callProvider'), 'no provider call');
      assert.ok(!log.order.includes('settleBudget'), 'no settlement');
      assert.ok(!log.order.includes('recordEvent'), 'no usage event');
    });
  });

  // ── Effect ordering ─────────────────────────────────────────────────────

  describe('effect ordering', () => {
    it('runs auth before access before budget before provider', async () => {
      await handleCallStart(makeDeps({}, log), postReq({ to: VALID_NUMBER }));
      const authIdx = log.order.indexOf('getUser');
      const accessIdx = log.order.indexOf('getAppAccess');
      const providerCfgIdx = log.order.indexOf('isProviderConfigured');
      const budgetIdx = log.order.indexOf('reserveBudget');
      const callIdx = log.order.indexOf('callProvider');
      assert.ok(authIdx >= 0, 'auth was called');
      assert.ok(accessIdx >= 0, 'access was called');
      assert.ok(authIdx < accessIdx, 'auth before access');
      assert.ok(accessIdx < budgetIdx, 'access before budget');
      assert.ok(accessIdx < providerCfgIdx, 'access before provider config');
      assert.ok(accessIdx < callIdx, 'access before provider call');
    });
  });

  // ── Server-config version ───────────────────────────────────────────────

  describe('app version source', () => {
    it('passes the server-config appVersion to get_app_access, ignoring the client body', async () => {
      let seenVersion: string | undefined = 'SENTINEL';
      const deps = makeDeps(
        {
          getAppAccess: async (_j: string, v?: string) => {
            seenVersion = v;
            return makeAccess();
          },
        },
        log,
      );
      const res = await handleCallStart(
        deps,
        postReq({ to: VALID_NUMBER, app_version: '9.9.9-evil' }),
      );
      assert.equal(res.status, 200);
      assert.equal(seenVersion, '1.2.3', 'uses deps.appVersion, not body.app_version');
    });
  });

  // ── Budget ──────────────────────────────────────────────────────────────

  describe('budget', () => {
    it('returns 500 on budget reservation RPC error', async () => {
      const deps = makeDeps({ reserveBudget: async () => null }, log);
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 500);
      const b = await json(res);
      assert.equal(b.error, 'usage_unavailable');
    });

    it('bounds thrown budget reservation failures', async () => {
      const deps = makeDeps(
        {
          reserveBudget: async () => {
            throw new Error('sensitive budget failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 500);
      const b = await json(res);
      assert.deepEqual(b, { error: 'usage_unavailable' });
      assert.ok(!log.order.includes('callProvider'), 'provider was not called');
    });

    it('bounds estimate dependency failures before budget reservation', async () => {
      const deps = makeDeps(
        {
          estimateCost: () => {
            throw new Error('sensitive estimate failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 500);
      const b = await json(res);
      assert.deepEqual(b, { error: 'usage_unavailable' });
      assert.ok(!log.order.includes('reserveBudget'), 'invalid estimate reserves no budget');
    });

    it('returns 402 on budget exceeded', async () => {
      const deps = makeDeps(
        { reserveBudget: async () => ({ ok: false, reason: 'budget' }) as ReservationResult },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 402);
      const b = await json(res);
      assert.equal(b.error, 'budget_exceeded');
      assert.equal(b.reason, 'budget');
    });

    it('reserves estimateCost(minReserveSeconds) before the provider call', async () => {
      let reservedAmount = -1;
      const deps = makeDeps(
        {
          reserveBudget: async (_u: string, est: number) => {
            reservedAmount = est;
            return { ok: true } as ReservationResult;
          },
        },
        log,
      );
      await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(reservedAmount, (60 / 60) * 0.1);
    });
  });

  // ── Provider ────────────────────────────────────────────────────────────

  describe('provider behavior', () => {
    it('returns 503 and releases the reservation when calling is unconfigured', async () => {
      const deps = makeDeps({ isProviderConfigured: () => false }, log);
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.equal(b.error, 'calling_unconfigured');
      assert.ok(log.order.includes('reserveBudget'), 'reserved first');
      assert.ok(log.order.includes('settleBudget'), 'released reservation');
      assert.ok(!log.order.includes('callProvider'), 'no provider call');
    });

    it('bounds provider-configuration failures and attempts to release the reservation', async () => {
      const deps = makeDeps(
        {
          isProviderConfigured: () => {
            throw new Error('sensitive provider config failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 503);
      const b = await json(res);
      assert.deepEqual(b, { error: 'call_provider_unavailable' });
      assert.ok(log.order.includes('settleBudget'), 'reservation release attempted');
      assert.ok(!log.order.includes('callProvider'), 'provider not called');
    });

    it('returns 502 and settles on provider network error', async () => {
      const deps = makeDeps(
        {
          callProvider: async () => {
            throw new Error('timeout');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.error, 'call_provider_unavailable');
      assert.ok(log.order.includes('settleBudget'), 'settled on network error');
    });

    it('keeps provider failure bounded when reservation settlement throws', async () => {
      const deps = makeDeps(
        {
          callProvider: async () => {
            throw new Error('sensitive provider failure');
          },
          settleBudget: async () => {
            throw new Error('sensitive settlement failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.deepEqual(b, { error: 'call_provider_unavailable' });
    });

    it('returns 502 and settles on non-ok provider status', async () => {
      const deps = makeDeps(
        { callProvider: async () => ({ ok: false, status: 500, body: null }) as ProviderResult },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.error, 'call_failed');
      assert.ok(log.order.includes('settleBudget'), 'settled on error status');
    });

    it('returns 502 and settles on malformed provider success body', async () => {
      const deps = makeDeps(
        { callProvider: async () => ({ ok: true, status: 201, body: null }) as ProviderResult },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 502);
      const b = await json(res);
      assert.equal(b.error, 'call_failed');
      assert.ok(log.order.includes('settleBudget'), 'settled on malformed body');
    });

    it('returns 200 with call_sid, status, and max_seconds on success', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 200);
      const b = await json(res);
      assert.equal(b.call_sid, 'CA123');
      assert.equal(b.status, 'initiated');
      assert.equal(b.max_seconds, 1800);
    });
  });

  // ── Settlement / Audit ──────────────────────────────────────────────────

  describe('settlement and audit', () => {
    it('records an audit event with the call sid on success', async () => {
      let payload: Record<string, unknown> = {};
      const deps = makeDeps(
        {
          recordEvent: async (_u: string, p: Record<string, unknown>) => {
            payload = p;
          },
        },
        log,
      );
      await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(payload.call_sid, 'CA123');
      assert.equal(payload.direction, 'outbound');
      assert.equal(payload.status, 'initiated');
    });

    it('returns the initiated call when audit recording fails to prevent a duplicate retry', async () => {
      const deps = makeDeps(
        {
          recordEvent: async () => {
            throw new Error('sensitive audit failure');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.equal(res.status, 200);
      const b = await json(res);
      assert.deepEqual(b, { call_sid: 'CA123', status: 'initiated', max_seconds: 1800 });
    });

    it('does not settle when access is denied (nothing was reserved)', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => makeAccess({ status: 'locked', canUseApp: false }) },
        log,
      );
      await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      assert.ok(!log.order.includes('settleBudget'), 'no settlement on access denial');
    });
  });

  // ── Security / non-disclosure ───────────────────────────────────────────

  describe('security and non-disclosure', () => {
    it('never exposes Twilio or service-role secrets in responses', async () => {
      const res = await handleCallStart(makeDeps({}, log), postReq({ to: VALID_NUMBER }));
      const text = await res.text();
      assert.ok(!text.includes('TWILIO_AUTH_TOKEN'));
      assert.ok(!text.includes('SERVICE_ROLE'));
      assert.ok(!text.includes('twilio'));
    });

    it('never exposes the raw provider error body', async () => {
      const deps = makeDeps(
        {
          callProvider: async () =>
            ({
              ok: false,
              status: 500,
              body: { message: 'internal secret: twilio-token-abc123' },
            }) as ProviderResult,
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      const text = await res.text();
      assert.ok(!text.includes('twilio-token-abc123'), 'no secret leak');
      assert.ok(!text.includes('internal secret'), 'no raw error');
    });

    it('does not leak RPC error details on access_unavailable', async () => {
      const deps = makeDeps(
        {
          getAppAccess: async () => {
            throw new Error('db connection secret: pg://x:y@host');
          },
        },
        log,
      );
      const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));
      const text = await res.text();
      assert.ok(!text.includes('pg://'), 'no rpc detail leak');
      const b = JSON.parse(text);
      assert.equal(b.error, 'access_unavailable');
    });

    it('does not trust client-provided access/tier/status fields', async () => {
      const deps = makeDeps(
        { getAppAccess: async () => makeAccess({ status: 'locked', canUseApp: false }) },
        log,
      );
      const res = await handleCallStart(
        deps,
        postReq({ to: VALID_NUMBER, canUseApp: true, status: 'active', tier: 'ultra' }),
      );
      assert.equal(res.status, 403, 'client fields ignored; server access denies');
    });
  });
});

describe('call-start server app version', () => {
  it('fails closed before access, budget, or provider work when APP_VERSION is absent', async () => {
    const log: CallLog = { order: [] };
    const deps = makeDeps({ appVersion: undefined }, log);
    const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));

    assert.equal(res.status, 503);
    assert.deepEqual(await json(res), { error: 'access_unavailable' });
    assert.ok(!log.order.includes('getAppAccess'));
    assert.ok(!log.order.includes('reserveBudget'));
    assert.ok(!log.order.includes('callProvider'));
  });

  it('fails closed on malformed server versions rather than entering prelaunch', async () => {
    const log: CallLog = { order: [] };
    const deps = makeDeps({ appVersion: 'not-a-semver' }, log);
    const res = await handleCallStart(deps, postReq({ to: VALID_NUMBER }));

    assert.equal(res.status, 503);
    assert.ok(!log.order.includes('getAppAccess'));
    assert.ok(!log.order.includes('reserveBudget'));
  });
});
