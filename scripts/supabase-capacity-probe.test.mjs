import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CAPACITY_STAGES,
  buildCapacityReport,
  classifyCapacityResults,
  normalizeCapacityConfig,
  runCapacityStage,
} from './supabase-capacity-probe.mjs';

const LOCAL_INPUT = Object.freeze({
  baseUrl: 'http://127.0.0.1:54321',
  path: '/rest/v1/profiles?select=id&limit=1',
  anonKey: 'fixture-publishable-key',
  stages: DEFAULT_CAPACITY_STAGES,
  requestTimeoutMs: 2_000,
  stageTimeoutMs: 30_000,
  cooldownMs: 0,
});

test('uses the exact master-goal capacity stages', () => {
  assert.deepEqual(DEFAULT_CAPACITY_STAGES, [500, 2_000, 5_000, 10_000]);
  assert.deepEqual(normalizeCapacityConfig(LOCAL_INPUT).stages, DEFAULT_CAPACITY_STAGES);

  assert.throws(
    () => normalizeCapacityConfig({ ...LOCAL_INPUT, stages: [500, 2_000, 10_001] }),
    /capacity stages must be exactly 500,2000,5000,10000/i,
  );
});

test('fails closed for remote and ambiguous targets', () => {
  assert.throws(
    () =>
      normalizeCapacityConfig({
        ...LOCAL_INPUT,
        baseUrl: 'https://production-project.supabase.co',
      }),
    /local loopback target/i,
  );

  assert.throws(
    () =>
      normalizeCapacityConfig({
        ...LOCAL_INPUT,
        baseUrl: 'https://isolated-test.supabase.co',
        allowStaging: true,
        confirmedHost: 'other-project.supabase.co',
        nonProductionConfirmation: 'I_CONFIRM_THIS_IS_AN_ISOLATED_TEST_PROJECT',
      }),
    /confirmed host/i,
  );

  const staging = normalizeCapacityConfig({
    ...LOCAL_INPUT,
    baseUrl: 'https://isolated-test.supabase.co',
    allowStaging: true,
    confirmedHost: 'isolated-test.supabase.co',
    nonProductionConfirmation: 'I_CONFIRM_THIS_IS_AN_ISOLATED_TEST_PROJECT',
  });
  assert.equal(staging.targetKind, 'staging');
  assert.equal(staging.targetOrigin, 'https://isolated-test.supabase.co');
});

test('rejects credentials and sensitive values in the reportable request URL', () => {
  assert.throws(
    () =>
      normalizeCapacityConfig({
        ...LOCAL_INPUT,
        path: '/rest/v1/profiles?access_token=should-not-be-in-a-url',
      }),
    /sensitive query parameters/i,
  );
  assert.throws(
    () =>
      normalizeCapacityConfig({
        ...LOCAL_INPUT,
        path: '/rest/v1/profiles?select=id\r\nX-Injected:true',
      }),
    /request path/i,
  );
});

test('measures a stage without retaining credentials or response bodies', async () => {
  const timestamps = [0, 0, 10, 10, 30, 30, 60, 60, 100, 110];
  let timestampIndex = 0;
  const requests = [];
  const config = normalizeCapacityConfig({
    ...LOCAL_INPUT,
    stages: [500, 2_000, 5_000, 10_000],
  });

  const result = await runCapacityStage(
    { ...config, users: 4, maxInFlight: 1 },
    {
      now: () => timestamps[timestampIndex++] ?? 110,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(null, { status: requests.length === 4 ? 503 : 200 });
      },
    },
  );

  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.init.headers.apikey === LOCAL_INPUT.anonKey));
  assert.deepEqual(result.statusCounts, { 200: 3, 503: 1 });
  assert.equal(result.users, 4);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.errorRate, 0.25);
  assert.equal(result.latencyMs.p50, 20);
  assert.equal(result.latencyMs.p95, 40);
  assert.equal(result.latencyMs.max, 40);
  assert.equal(result.wallTimeMs, 110);
  assert.equal(result.requestsPerSecond, 36.364);
  assert.equal(JSON.stringify(result).includes(LOCAL_INPUT.anonKey), false);
  assert.equal(JSON.stringify(result).includes('response body'), false);
});

test('classifies the first degraded and breaking stage from explicit budgets', () => {
  const base = {
    attempted: 500,
    succeeded: 500,
    failed: 0,
    errorRate: 0,
    requestsPerSecond: 500,
    wallTimeMs: 1_000,
    statusCounts: { 200: 500 },
    latencyMs: { p50: 100, p95: 200, p99: 250, max: 300 },
    timedOut: false,
    aborted: false,
  };
  const classification = classifyCapacityResults(
    [
      { ...base, users: 500 },
      {
        ...base,
        users: 2_000,
        attempted: 2_000,
        succeeded: 2_000,
        latencyMs: { ...base.latencyMs, p95: 1_200 },
      },
      {
        ...base,
        users: 5_000,
        attempted: 5_000,
        succeeded: 4_700,
        failed: 300,
        errorRate: 0.06,
      },
    ],
    { degradedP95Ms: 1_000, breakingErrorRate: 0.05 },
  );

  assert.deepEqual(classification, {
    highestPassingUsers: 500,
    degradationStageUsers: 2_000,
    breakingPointUsers: 5_000,
    status: 'breaking-point-observed',
  });
});

test('keeps uncollected operator metrics explicit and never serializes the key', () => {
  const config = normalizeCapacityConfig(LOCAL_INPUT);
  const report = buildCapacityReport({
    config,
    results: [],
    classification: {
      highestPassingUsers: null,
      degradationStageUsers: null,
      breakingPointUsers: null,
      status: 'not-executed',
    },
    generatedAt: '2026-08-06T00:00:00.000Z',
  });

  assert.equal(report.target.origin, 'http://127.0.0.1:54321');
  assert.equal(report.operatorMetrics.databaseConnections, null);
  assert.equal(report.operatorMetrics.databaseCpuPercent, null);
  assert.equal(report.operatorMetrics.edgeFunctionInvocations, null);
  assert.equal(report.operatorMetrics.egressBytes, null);
  assert.equal(report.operatorMetrics.realtimePeakConnections, null);
  assert.equal(report.evidenceStatus, 'BLOCKED_TECHNICAL_NOT_EXECUTED');
  assert.equal(JSON.stringify(report).includes(LOCAL_INPUT.anonKey), false);
});

test('marks evidence captured only when every operator metric is supplied', () => {
  const config = normalizeCapacityConfig(LOCAL_INPUT);
  const report = buildCapacityReport({
    config,
    results: [
      {
        users: 500,
        maxInFlight: 500,
        attempted: 500,
        succeeded: 500,
        failed: 0,
        errorRate: 0,
        requestsPerSecond: 500,
        wallTimeMs: 1_000,
        statusCounts: { 200: 500 },
        latencyMs: { p50: 40, p95: 80, p99: 100, max: 120 },
        timedOut: false,
        aborted: false,
      },
    ],
    classification: {
      highestPassingUsers: 500,
      degradationStageUsers: null,
      breakingPointUsers: null,
      status: 'all-stages-within-client-budgets',
    },
    operatorMetrics: {
      databaseConnections: 12,
      databaseCpuPercent: 33.5,
      databaseMemoryBytes: 268_435_456,
      edgeFunctionInvocations: 0,
      egressBytes: 12_345,
      realtimePeakConnections: 0,
    },
  });

  assert.equal(report.evidenceStatus, 'LOCAL_OR_STAGING_EVIDENCE_CAPTURED');
  assert.deepEqual(report.missingOperatorMetrics, []);
  assert.throws(
    () =>
      buildCapacityReport({
        config,
        results: [],
        classification: {
          highestPassingUsers: null,
          degradationStageUsers: null,
          breakingPointUsers: null,
          status: 'not-executed',
        },
        operatorMetrics: { databaseConnections: -1 },
      }),
    /operator metric/i,
  );
});

test('stops launching new requests after cancellation', async () => {
  const controller = new AbortController();
  let calls = 0;
  const config = normalizeCapacityConfig(LOCAL_INPUT);

  const result = await runCapacityStage(
    { ...config, users: 20, signal: controller.signal },
    {
      now: (() => {
        let value = 0;
        return () => (value += 1);
      })(),
      fetch: async () => {
        calls += 1;
        if (calls === 3) controller.abort();
        return new Response(null, { status: 200 });
      },
    },
  );

  assert.equal(result.aborted, true);
  assert.ok(calls < 20);
  assert.equal(result.attempted, calls);
});
