import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_CAPACITY_STAGES = Object.freeze([500, 2_000, 5_000, 10_000]);

const STAGING_CONFIRMATION = 'I_CONFIRM_THIS_IS_AN_ISOLATED_TEST_PROJECT';
const EXECUTION_CONFIRMATION = 'I_CONFIRM_CAPACITY_LOAD_ON_THIS_NON_PRODUCTION_TARGET';
const DEFAULT_PATH = '/rest/v1/profiles?select=id&limit=1';

function positiveInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

function exactStages(stages) {
  if (
    !Array.isArray(stages) ||
    stages.length !== DEFAULT_CAPACITY_STAGES.length ||
    stages.some((stage, index) => stage !== DEFAULT_CAPACITY_STAGES[index])
  ) {
    throw new Error('Capacity stages must be exactly 500,2000,5000,10000.');
  }
  return Object.freeze([...stages]);
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function safeAnonKey(value) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8_192 ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('A bounded Supabase publishable/anon key is required.');
  }
  return value;
}

export function normalizeCapacityConfig(input) {
  const url = new URL(input.baseUrl);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The capacity target URL is invalid.');
  }
  const loopback = isLoopback(url.hostname);
  if (!loopback) {
    if (input.allowStaging !== true || input.nonProductionConfirmation !== STAGING_CONFIRMATION) {
      throw new Error(
        'Capacity execution requires a local loopback target unless an isolated staging target is explicitly confirmed.',
      );
    }
    if (url.protocol !== 'https:') {
      throw new Error('A staging capacity target must use HTTPS.');
    }
    if (input.confirmedHost !== url.hostname) {
      throw new Error('The confirmed host must exactly match the staging target host.');
    }
  }
  if (
    typeof input.path !== 'string' ||
    !input.path.startsWith('/') ||
    input.path.startsWith('//') ||
    /[\r\n]/.test(input.path)
  ) {
    throw new Error('Capacity request path must be an origin-relative path.');
  }
  const targetUrl = new URL(input.path, `${url.origin}/`);
  const sensitiveQueryName = [...targetUrl.searchParams.keys()].find((name) =>
    /(?:key|token|secret|password|authorization|credential|signature)/i.test(name),
  );
  if (sensitiveQueryName) {
    throw new Error('Capacity request URLs cannot contain sensitive query parameters.');
  }

  const stages = exactStages(input.stages ?? DEFAULT_CAPACITY_STAGES);
  const requestTimeoutMs = positiveInteger(input.requestTimeoutMs ?? 10_000, 'Request timeout', {
    min: 250,
    max: 60_000,
  });
  const stageTimeoutMs = positiveInteger(input.stageTimeoutMs ?? 180_000, 'Stage timeout', {
    min: requestTimeoutMs,
    max: 900_000,
  });
  const cooldownMs = positiveInteger(input.cooldownMs ?? 5_000, 'Cooldown', {
    min: 0,
    max: 120_000,
  });
  const targetOrigin = url.origin;

  return Object.freeze({
    targetKind: loopback ? 'local' : 'staging',
    targetOrigin,
    targetPath: input.path,
    targetUrl: targetUrl.toString(),
    anonKey: safeAnonKey(input.anonKey),
    stages,
    requestTimeoutMs,
    stageTimeoutMs,
    cooldownMs,
  });
}

function round(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index]);
}

function latencySummary(latencies) {
  const sorted = [...latencies].sort((left, right) => left - right);
  return Object.freeze({
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? round(sorted.at(-1)) : null,
  });
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function requestSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let parentAborted = false;
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('request_timeout')), timeoutMs);
  return {
    signal: controller.signal,
    parentAborted: () => parentAborted,
    dispose() {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

export async function runCapacityStage(input, dependencies = {}) {
  const users = positiveInteger(input.users, 'Users', { max: 10_000 });
  const maxInFlight = positiveInteger(input.maxInFlight ?? users, 'Maximum in-flight requests', {
    max: users,
  });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? (() => performance.now());
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');

  const stageController = new AbortController();
  let externalAbort = false;
  let timedOut = false;
  const abortFromExternal = () => {
    externalAbort = true;
    stageController.abort(input.signal?.reason);
  };
  if (input.signal?.aborted) abortFromExternal();
  else input.signal?.addEventListener('abort', abortFromExternal, { once: true });
  const stageTimer = setTimeout(() => {
    timedOut = true;
    stageController.abort(new Error('stage_timeout'));
  }, input.stageTimeoutMs);

  const startedAt = now();
  let nextRequest = 0;
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  const statusCounts = {};
  const latencies = [];

  async function worker() {
    while (!stageController.signal.aborted) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      if (requestIndex >= users) return;
      attempted += 1;
      const requestStartedAt = now();
      const scopedSignal = requestSignal(stageController.signal, input.requestTimeoutMs);
      try {
        const response = await fetchImpl(input.targetUrl, {
          method: 'GET',
          headers: {
            apikey: input.anonKey,
            Authorization: `Bearer ${input.anonKey}`,
            Accept: 'application/json',
            'X-Client-Info': 'vibespace-capacity-probe/1',
          },
          cache: 'no-store',
          signal: scopedSignal.signal,
        });
        increment(statusCounts, String(response.status));
        if (response.ok) succeeded += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        if (scopedSignal.parentAborted()) increment(statusCounts, 'cancelled');
        else if (scopedSignal.signal.aborted) increment(statusCounts, 'request_timeout');
        else increment(statusCounts, 'network_error');
        void error;
      } finally {
        latencies.push(Math.max(0, now() - requestStartedAt));
        scopedSignal.dispose();
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: maxInFlight }, () => worker()));
  } finally {
    clearTimeout(stageTimer);
    input.signal?.removeEventListener('abort', abortFromExternal);
  }

  const wallTimeMs = Math.max(0, now() - startedAt);
  return Object.freeze({
    users,
    maxInFlight,
    attempted,
    succeeded,
    failed,
    errorRate: attempted === 0 ? 0 : round(failed / attempted, 6),
    requestsPerSecond: wallTimeMs === 0 ? 0 : round(attempted / (wallTimeMs / 1_000)),
    wallTimeMs: round(wallTimeMs),
    statusCounts: Object.freeze({ ...statusCounts }),
    latencyMs: latencySummary(latencies),
    timedOut,
    aborted: externalAbort,
  });
}

export function classifyCapacityResults(
  results,
  { degradedP95Ms = 1_000, breakingErrorRate = 0.05 } = {},
) {
  let highestPassingUsers = null;
  let degradationStageUsers = null;
  let breakingPointUsers = null;

  for (const result of results) {
    const broken =
      result.timedOut ||
      result.aborted ||
      result.errorRate >= breakingErrorRate ||
      result.attempted < result.users;
    const degraded =
      broken ||
      result.errorRate > 0 ||
      (typeof result.latencyMs.p95 === 'number' && result.latencyMs.p95 > degradedP95Ms);
    if (degraded && degradationStageUsers === null) degradationStageUsers = result.users;
    if (broken && breakingPointUsers === null) breakingPointUsers = result.users;
    if (!degraded) highestPassingUsers = result.users;
  }

  return Object.freeze({
    highestPassingUsers,
    degradationStageUsers,
    breakingPointUsers,
    status:
      breakingPointUsers !== null
        ? 'breaking-point-observed'
        : degradationStageUsers !== null
          ? 'degradation-observed'
          : results.length === 0
            ? 'not-executed'
            : 'all-stages-within-client-budgets',
  });
}

const EMPTY_OPERATOR_METRICS = Object.freeze({
  databaseConnections: null,
  databaseCpuPercent: null,
  databaseMemoryBytes: null,
  edgeFunctionInvocations: null,
  egressBytes: null,
  realtimePeakConnections: null,
});

function normalizeOperatorMetrics(value) {
  const metrics = { ...EMPTY_OPERATOR_METRICS, ...value };
  for (const [name, metric] of Object.entries(metrics)) {
    if (metric === null) continue;
    if (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) {
      throw new Error(`Operator metric ${name} must be null or a non-negative number.`);
    }
    if (name === 'databaseCpuPercent' && metric > 100) {
      throw new Error('Operator metric databaseCpuPercent cannot exceed 100.');
    }
  }
  return Object.freeze(metrics);
}

export function buildCapacityReport({
  config,
  results,
  classification,
  operatorMetrics = EMPTY_OPERATOR_METRICS,
  generatedAt = new Date().toISOString(),
}) {
  const normalizedOperatorMetrics = normalizeOperatorMetrics(operatorMetrics);
  const missingOperatorMetrics = Object.entries(normalizedOperatorMetrics)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  return Object.freeze({
    schemaVersion: 1,
    generatedAt,
    evidenceStatus:
      results.length === 0
        ? 'BLOCKED_TECHNICAL_NOT_EXECUTED'
        : missingOperatorMetrics.length
          ? 'IMPLEMENTED_EXTERNAL_METRICS_REQUIRED'
          : 'LOCAL_OR_STAGING_EVIDENCE_CAPTURED',
    target: Object.freeze({
      kind: config.targetKind,
      origin: config.targetOrigin,
      path: config.targetPath,
    }),
    stages: Object.freeze([...config.stages]),
    requestTimeoutMs: config.requestTimeoutMs,
    stageTimeoutMs: config.stageTimeoutMs,
    results: Object.freeze([...results]),
    classification,
    operatorMetrics: normalizedOperatorMetrics,
    missingOperatorMetrics: Object.freeze(missingOperatorMetrics),
    limitations: Object.freeze([
      'Client measurements do not prove database CPU, memory, connection, Edge invocation, egress, or Realtime capacity.',
      'A passing isolated test project does not establish a production SLA.',
      'Authentication, RLS, billing, and account-isolation correctness require their separate negative tests.',
    ]),
  });
}

function envBoolean(value) {
  return value === '1' || value === 'true';
}

function optionalMetric(value, name) {
  if (value === undefined || value === '') return null;
  const metric = Number(value);
  if (!Number.isFinite(metric) || metric < 0) {
    throw new Error(`${name} must be a non-negative number when provided.`);
  }
  return metric;
}

function parseCliArgs(argv) {
  const args = new Set(argv);
  const outputIndex = argv.indexOf('--output');
  return {
    execute: args.has('--execute'),
    output: outputIndex >= 0 ? argv[outputIndex + 1] : undefined,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const executeConfirmation = process.env.SUPABASE_CAPACITY_EXECUTE;
  const anonKey =
    process.env.SUPABASE_CAPACITY_ANON_KEY ?? (cli.execute ? '' : 'dry-run-key-not-transmitted');
  const config = normalizeCapacityConfig({
    baseUrl: process.env.SUPABASE_CAPACITY_URL ?? 'http://127.0.0.1:54321',
    path: process.env.SUPABASE_CAPACITY_PATH ?? DEFAULT_PATH,
    anonKey,
    stages: DEFAULT_CAPACITY_STAGES,
    requestTimeoutMs: Number(process.env.SUPABASE_CAPACITY_REQUEST_TIMEOUT_MS ?? 10_000),
    stageTimeoutMs: Number(process.env.SUPABASE_CAPACITY_STAGE_TIMEOUT_MS ?? 180_000),
    cooldownMs: Number(process.env.SUPABASE_CAPACITY_COOLDOWN_MS ?? 5_000),
    allowStaging: envBoolean(process.env.SUPABASE_CAPACITY_ALLOW_STAGING),
    confirmedHost: process.env.SUPABASE_CAPACITY_CONFIRM_HOST,
    nonProductionConfirmation: process.env.SUPABASE_CAPACITY_NON_PRODUCTION_CONFIRMATION,
  });

  const results = [];
  const abortController = new AbortController();
  const onInterrupt = () => abortController.abort(new Error('operator_cancelled'));
  process.once('SIGINT', onInterrupt);
  try {
    if (cli.execute) {
      if (executeConfirmation !== EXECUTION_CONFIRMATION) {
        throw new Error(`Execution requires SUPABASE_CAPACITY_EXECUTE=${EXECUTION_CONFIRMATION}.`);
      }
      for (const users of config.stages) {
        const result = await runCapacityStage({
          ...config,
          users,
          signal: abortController.signal,
        });
        results.push(result);
        if (result.aborted || result.timedOut || result.errorRate >= 0.05) break;
        if (users !== config.stages.at(-1) && config.cooldownMs > 0) {
          await sleep(config.cooldownMs);
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }

  const classification = classifyCapacityResults(results);
  const report = buildCapacityReport({
    config,
    results,
    classification,
    operatorMetrics: {
      databaseConnections: optionalMetric(
        process.env.SUPABASE_CAPACITY_DB_CONNECTIONS,
        'SUPABASE_CAPACITY_DB_CONNECTIONS',
      ),
      databaseCpuPercent: optionalMetric(
        process.env.SUPABASE_CAPACITY_DB_CPU_PERCENT,
        'SUPABASE_CAPACITY_DB_CPU_PERCENT',
      ),
      databaseMemoryBytes: optionalMetric(
        process.env.SUPABASE_CAPACITY_DB_MEMORY_BYTES,
        'SUPABASE_CAPACITY_DB_MEMORY_BYTES',
      ),
      edgeFunctionInvocations: optionalMetric(
        process.env.SUPABASE_CAPACITY_EDGE_INVOCATIONS,
        'SUPABASE_CAPACITY_EDGE_INVOCATIONS',
      ),
      egressBytes: optionalMetric(
        process.env.SUPABASE_CAPACITY_EGRESS_BYTES,
        'SUPABASE_CAPACITY_EGRESS_BYTES',
      ),
      realtimePeakConnections: optionalMetric(
        process.env.SUPABASE_CAPACITY_REALTIME_PEAK_CONNECTIONS,
        'SUPABASE_CAPACITY_REALTIME_PEAK_CONNECTIONS',
      ),
    },
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (cli.output) await writeFile(cli.output, json, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(json);
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(
      `supabase-capacity-probe: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
