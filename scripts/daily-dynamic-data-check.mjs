#!/usr/bin/env node
/**
 * Daily Dynamic Data Maintenance check.
 *
 * Safe, read-only validation:
 *  - maintenance doc + registry exist
 *  - registry surfaces have required fields
 *  - lastUpdated ISO dates parse
 *  - module paths referenced by the registry exist
 *  - reports stale surfaces (does not rewrite prices)
 *
 * Never fabricates updates. Exit 1 on structural failure; exit 0 with
 * STALE warnings when data is merely past threshold (operator action).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DOC = path.join(ROOT, 'docs/operations/DAILY_DYNAMIC_DATA_MAINTENANCE.md');
const REGISTRY = path.join(ROOT, 'docs/operations/dynamic-data-registry.json');
const TS_REGISTRY = path.join(ROOT, 'app/src/lib/dynamic-data/registry.ts');
const FRESHNESS = path.join(ROOT, 'app/src/lib/dynamic-data/freshness.ts');

const REQUIRED_SURFACE_FIELDS = [
  'id',
  'title',
  'module',
  'sourceOfTruth',
  'sourceKind',
  'refreshCadence',
  'cachePolicy',
  'staleAfterDays',
  'failureBehavior',
  'test',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function warn(message) {
  console.warn(`WARN: ${message}`);
}

function ok(message) {
  console.log(`OK: ${message}`);
}

function parseIsoDateUtc(value) {
  const trimmed = String(value ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

function resolveModulePath(moduleField) {
  // Allow "path.ts#export" annotations
  const bare = moduleField.split('#')[0];
  return path.join(ROOT, bare);
}

function main() {
  console.log('Daily Dynamic Data Maintenance check');
  console.log(`root: ${ROOT}`);
  console.log(`now:  ${new Date().toISOString()}`);
  console.log('');

  for (const file of [DOC, REGISTRY, TS_REGISTRY, FRESHNESS]) {
    if (!fs.existsSync(file)) {
      fail(`missing required file: ${path.relative(ROOT, file)}`);
    } else {
      ok(`found ${path.relative(ROOT, file)}`);
    }
  }

  if (process.exitCode === 1) process.exit(1);

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch (err) {
    fail(`registry JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.surfaces)) {
    fail('registry must have schemaVersion: 1 and surfaces[]');
    process.exit(1);
  }

  const docText = fs.readFileSync(DOC, 'utf8');
  if (!docText.includes('Daily Dynamic Data Maintenance')) {
    fail('maintenance document missing expected title');
  }
  if (!docText.includes('dynamic-data-registry.json')) {
    fail('maintenance document must reference the machine-readable registry');
  }

  const tsRegistry = fs.readFileSync(TS_REGISTRY, 'utf8');
  const ids = new Set();
  const now = Date.now();
  let staleCount = 0;

  for (const surface of registry.surfaces) {
    for (const field of REQUIRED_SURFACE_FIELDS) {
      if (surface[field] === undefined || surface[field] === null || surface[field] === '') {
        fail(`surface ${surface.id ?? '(missing id)'} missing field ${field}`);
      }
    }
    if (ids.has(surface.id)) fail(`duplicate surface id: ${surface.id}`);
    ids.add(surface.id);

    if (!tsRegistry.includes(`'${surface.id}'`) && !tsRegistry.includes(`"${surface.id}"`)) {
      // soft: some ids may only appear in meta objects
      if (!tsRegistry.includes(surface.id)) {
        warn(`TS registry may be missing id ${surface.id} — keep registry.ts in sync`);
      }
    }

    const modulePath = resolveModulePath(surface.module);
    if (!fs.existsSync(modulePath)) {
      fail(`module path missing for ${surface.id}: ${surface.module}`);
    }

    const testPath = path.join(ROOT, surface.test);
    if (!fs.existsSync(testPath)) {
      warn(`test path not found for ${surface.id}: ${surface.test}`);
    }

    // lastUpdated lives in TS meta for most; optional on JSON
    const lastUpdated =
      surface.lastUpdated ||
      (surface.id === 'deepgram-stt-pricing' ? '2026-08-02' : null);

    if (surface.staleAfterDays > 0) {
      // Prefer reading lastUpdated from JSON if present; else skip age if absent
      if (surface.lastUpdated) {
        const ms = parseIsoDateUtc(surface.lastUpdated);
        if (ms === null) {
          fail(`${surface.id}: invalid lastUpdated ${surface.lastUpdated}`);
        } else {
          const ageDays = Math.floor((now - ms) / (24 * 60 * 60 * 1000));
          if (ageDays > surface.staleAfterDays) {
            staleCount += 1;
            warn(
              `${surface.id} STALE (${ageDays}d > ${surface.staleAfterDays}d). Source: ${surface.sourceOfTruth}`,
            );
          }
        }
      }
    }
  }

  // Required inventory for launch-critical prompt
  const requiredIds = [
    'deepgram-stt-pricing',
    'llm-cost-rates',
    'chat-model-catalog',
    'benchmark-leaderboard',
    'subscription-plan-pricing',
    'provider-usage-limits',
  ];
  for (const id of requiredIds) {
    if (!ids.has(id)) fail(`registry missing required surface id: ${id}`);
  }

  ok(`${ids.size} surfaces inventoried`);
  if (staleCount > 0) {
    warn(`${staleCount} surface(s) past stale threshold — re-verify official sources; do not fabricate updates`);
  } else {
    ok('no JSON-embedded lastUpdated fields reported stale (see TS meta for full set)');
  }

  // Fail closed: never treat missing failureBehavior as OK (already required)
  const silentCurrent = registry.surfaces.filter(
    (s) =>
      typeof s.failureBehavior === 'string' &&
      /silent|keep.?old.?as.?current|retain.?current/i.test(s.failureBehavior),
  );
  if (silentCurrent.length > 0) {
    fail(
      `surfaces must not allow silently retaining old prices as current: ${silentCurrent
        .map((s) => s.id)
        .join(', ')}`,
    );
  }

  console.log('');
  if (process.exitCode === 1) {
    console.error('RESULT: FAILED structural checks');
    process.exit(1);
  }
  console.log('RESULT: PASS (read-only). Review WARNs before shipping catalog changes.');
  process.exit(0);
}

main();
