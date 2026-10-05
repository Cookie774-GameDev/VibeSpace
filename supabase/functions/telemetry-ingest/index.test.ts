import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleTelemetryIngest } from './index.ts';

const NOW = 1_758_500_000_000;
const BATCH_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const POLICY = 'telemetry-reward-2026-08-03';
const CLASSES = ['product_usage', 'diagnostics', 'tool_outcomes'];

function body(extra: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    events: [
      {
        eventId: EVENT_ID,
        eventName: 'diagnostic',
        schemaVersion: 1,
        occurredAt: NOW,
        appVersion: '1.2.3',
        platform: 'windows',
        metrics: { durationMs: 12 },
        outcome: 'ok',
        ...extra,
      },
    ],
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    config: { policyVersion: POLICY },
    nowMs: () => NOW,
    authenticate: async () => ({ id: 'user_123' }),
    getConsent: async () => ({
      enabled: true,
      eligible: true,
      policyVersion: POLICY,
      dataClasses: CLASSES,
    }),
    checkRateLimit: async () => ({ allowed: true, remaining: 250, retryAfterSeconds: 60 }),
    storeBatch: async () => ({ status: 'accepted', acceptedEventIds: [EVENT_ID] }),
    ...overrides,
  };
}

function request(payload: unknown = body(), headers: Record<string, string> = {}) {
  return new Request('https://edge.test', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

describe('telemetry ingest', () => {
  it('requires a verified bearer token before parsing or storing', async () => {
    let parsed = false;
    const response = await handleTelemetryIngest(
      new Request('https://edge.test', { method: 'POST', body: JSON.stringify(body()) }),
      deps({
        authenticate: async () => {
          parsed = true;
          return null;
        },
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(parsed, false);
  });

  it('requires the current policy and all disclosed classes', async () => {
    const response = await handleTelemetryIngest(
      request(),
      deps({
        getConsent: async () => ({
          enabled: true,
          eligible: false,
          policyVersion: 'old-policy',
          dataClasses: CLASSES,
        }),
      }),
    );
    assert.equal(response.status, 403);
  });

  it('rejects provider and identity fields before the store is reached', async () => {
    let stores = 0;
    const response = await handleTelemetryIngest(
      request(body({ providerId: 'provider-secret' })),
      deps({
        storeBatch: async () => {
          stores += 1;
          return { acceptedEventIds: [EVENT_ID] };
        },
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(stores, 0);
  });

  it('returns stable accepted IDs for a deduplicated retry', async () => {
    const response = await handleTelemetryIngest(
      request(),
      deps({ storeBatch: async () => ({ status: 'duplicate', acceptedEventIds: [EVENT_ID] }) }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      batchId: BATCH_ID,
      acceptedEventIds: [EVENT_ID],
      acceptedCount: 1,
      duplicate: true,
      rateLimitRemaining: 250,
    });
  });

  it('enforces the account-scoped rate limit without writing', async () => {
    let stores = 0;
    const response = await handleTelemetryIngest(
      request(),
      deps({
        checkRateLimit: async () => ({ allowed: false, remaining: 0, retryAfterSeconds: 17 }),
        storeBatch: async () => {
          stores += 1;
          return { acceptedEventIds: [EVENT_ID] };
        },
      }),
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(stores, 0);
  });

  it('bounds a streamed body even when content-length is absent', async () => {
    const response = await handleTelemetryIngest(request('x'.repeat(64 * 1024 + 1)), deps());
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  });

  it('reports rate-limit storage outages separately from a user rate limit', async () => {
    const response = await handleTelemetryIngest(
      request(),
      deps({
        checkRateLimit: async () => {
          throw new Error('database unavailable');
        },
      }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'telemetry_rate_limit_unavailable' });
  });

  it('does not expose storage errors or raw payloads', async () => {
    const response = await handleTelemetryIngest(
      request(),
      deps({
        storeBatch: async () => {
          throw new Error('database secret');
        },
      }),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'telemetry_store_failed' });
  });
});

it('honors a withdrawal that commits after the edge consent preflight', async () => {
  const response = await handleTelemetryIngest(
    request(),
    deps({
      storeBatch: async () => ({ status: 'consent_required' }),
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'telemetry_consent_required' });
});
it('uses the atomic store admission result under concurrent uploads', async () => {
  const response = await handleTelemetryIngest(
    request(),
    deps({
      storeBatch: async () => ({ status: 'rate_limited', retryAfterSeconds: 60 }),
    }),
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

const EXPANDED_POLICY = 'telemetry-app-diagnostics-2026-10-05-v1';
const EXPANDED_SCOPE = 'app-diagnostics-v1';
const expandedPayload = () =>
  body({ schemaVersion: 2, eventName: 'feature_open', feature: 'settings', metrics: { count: 2 } });
const expandedDeps = (overrides: Record<string, unknown> = {}) =>
  deps({
    config: { policyVersion: EXPANDED_POLICY, appDiagnosticsScope: EXPANDED_SCOPE },
    getConsent: async () => ({
      enabled: true,
      eligible: true,
      policyVersion: EXPANDED_POLICY,
      dataClasses: CLASSES,
    }),
    ...overrides,
  });
describe('expanded diagnostics ingest admission', () => {
  it('fails closed when the server has not explicitly enabled the expanded scope', async () => {
    for (const config of [
      { policyVersion: EXPANDED_POLICY },
      { policyVersion: EXPANDED_POLICY, appDiagnosticsScope: 'unknown-scope' },
      { policyVersion: POLICY, appDiagnosticsScope: EXPANDED_SCOPE },
    ]) {
      let stores = 0;
      const response = await handleTelemetryIngest(
        request(expandedPayload()),
        expandedDeps({
          config,
          storeBatch: async () => {
            stores++;
          },
        }),
      );
      assert.equal(response.status, 403);
      assert.equal(stores, 0);
    }
  });
  it('does not treat old, offered-only, disabled or withdrawing consent as expanded acceptance', async () => {
    for (const state of [
      { enabled: true, eligible: true, policyVersion: POLICY, dataClasses: CLASSES },
      {
        enabled: true,
        eligible: true,
        policyVersion: null,
        offeredPolicyVersion: EXPANDED_POLICY,
        dataClasses: CLASSES,
      },
      { enabled: false, eligible: true, policyVersion: EXPANDED_POLICY, dataClasses: CLASSES },
      {
        enabled: true,
        eligible: true,
        policyVersion: EXPANDED_POLICY,
        dataClasses: CLASSES,
        withdrawal: { status: 'pending' },
      },
      {
        enabled: true,
        eligible: true,
        policyVersion: EXPANDED_POLICY,
        dataClasses: CLASSES.slice(0, 2),
      },
    ]) {
      let stores = 0;
      const response = await handleTelemetryIngest(
        request(expandedPayload()),
        expandedDeps({
          getConsent: async () => state,
          storeBatch: async () => {
            stores++;
          },
        }),
      );
      assert.equal(response.status, 403);
      assert.equal(stores, 0);
    }
  });
  it('passes only sanitized scoped v2 dimensions to the existing account-bound atomic store', async () => {
    const stored: unknown[] = [];
    const response = await handleTelemetryIngest(
      request(expandedPayload()),
      expandedDeps({
        reconcileWithdrawal: () => assert.fail('ingest must not call billing'),
        storeBatch: async (account: string, batch: unknown) => {
          stored.push({ account, batch });
          return { status: 'accepted', acceptedEventIds: [EVENT_ID] };
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(stored, [{ account: 'user_123', batch: expandedPayload() }]);
    assert.deepEqual((await response.json()).acceptedEventIds, [EVENT_ID]);
  });
  it('keeps authoritative withdrawal after expanded consent preflight effective', async () => {
    const response = await handleTelemetryIngest(
      request(expandedPayload()),
      expandedDeps({ storeBatch: async () => ({ status: 'consent_required' }) }),
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'telemetry_consent_required' });
  });
  it('rejects v2 private fields and v1 smuggling before storage with content-free errors', async () => {
    for (const payload of [
      body({
        schemaVersion: 2,
        eventName: 'diagnostic',
        feature: 'app',
        diagnostic: 'renderer_error',
        metrics: { count: 1 },
        rawError: 'PRIVATE_SENTINEL',
      }),
      body({ schemaVersion: 1, metrics: { heapUsedMiB: 1 } }),
    ]) {
      let stores = 0;
      const response = await handleTelemetryIngest(
        request(payload),
        expandedDeps({
          storeBatch: async () => {
            stores++;
          },
        }),
      );
      assert.equal(response.status, 400);
      assert.equal(stores, 0);
      assert.deepEqual(await response.json(), { error: 'invalid_telemetry_payload' });
    }
  });
});
