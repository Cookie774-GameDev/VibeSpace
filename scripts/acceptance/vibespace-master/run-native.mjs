#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  readWindowsNativeState,
  sanitizeEvidence,
  sha256,
} from '../../pr31-native-acceptance-harness.mjs';
import { appendEvidenceLine } from './evidence.mjs';

const execFile = promisify(execFileCallback);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, '..', '..', '..');

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA64 = /^[0-9a-f]{64}$/u;

function numberField(row, ...keys) {
  for (const key of keys) {
    const value = Number(row?.[key]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return 0;
}
function stringField(row, ...keys) {
  for (const key of keys) {
    if (typeof row?.[key] === 'string') return row[key];
  }
  return '';
}
function normalizePath(value) {
  return path.win32.normalize(String(value ?? '')).replaceAll('/', '\\').toLowerCase();
}
function parseDebugPort(commandLine) {
  const match = /(?:^|\s)--remote-debugging-port(?:=|\s+)(\d{2,5})(?:\s|$)/u.exec(commandLine);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

export function validateFrozenManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('master_manifest_invalid');
  }
  if (manifest.schemaVersion !== 1) throw new Error('master_manifest_schema_invalid');
  const candidate = manifest.candidate ?? {};
  if (!SHA40.test(String(candidate.head ?? ''))) throw new Error('master_manifest_head_invalid');
  if (!SHA64.test(String(candidate.sourceManifestHash ?? ''))) throw new Error('master_manifest_source_hash_invalid');
  if (!SHA64.test(String(candidate.nativeBinaryHash ?? ''))) throw new Error('master_manifest_binary_hash_invalid');
  const runtime = manifest.runtime ?? {};
  if (
    typeof runtime.profile !== 'string' ||
    !runtime.profile ||
    runtime.profile === 'observed' ||
    runtime.mainTarget !== 'main' ||
    !Number.isSafeInteger(runtime.appPid) ||
    runtime.appPid < 1 ||
    !Number.isSafeInteger(runtime.webviewPid) ||
    runtime.webviewPid < 1
  ) {
    throw new Error('master_manifest_runtime_invalid');
  }
  const limits = manifest.limits ?? {};
  if (
    limits.realChatSubmissions !== 2 ||
    limits.parallelUiControllers !== 1 ||
    !Number.isSafeInteger(limits.providerTurnDeadlineMs) ||
    limits.providerTurnDeadlineMs < 1000 ||
    limits.providerTurnDeadlineMs > 120000
  ) {
    throw new Error('master_manifest_limits_invalid');
  }
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) {
    throw new Error('master_manifest_scenarios_invalid');
  }
  const ids = new Set();
  for (const scenario of manifest.scenarios) {
    if (
      !/^[A-Z][A-Z0-9-]{2,63}$/u.test(String(scenario?.id ?? '')) ||
      ids.has(scenario.id) ||
      !Array.isArray(scenario.sourceDependencies) ||
      !Number.isSafeInteger(scenario.deadlineMs) ||
      scenario.deadlineMs < 1 ||
      scenario.deadlineMs > limits.providerTurnDeadlineMs ||
      !['none', 'local-fixture', 'one-real-turn'].includes(scenario.providerCostClassification) ||
      !Array.isArray(scenario.allowedEffects) ||
      !Array.isArray(scenario.evidenceRequirements) ||
      scenario.evidenceRequirements.length === 0
    ) {
      throw new Error('master_manifest_scenario_invalid');
    }
    ids.add(scenario.id);
  }
  const excluded = new Set(manifest.excludedClaims ?? []);
  for (const required of ['all-provider interoperability', 'statistical reliability', 'unmeasured savings']) {
    if (!excluded.has(required)) throw new Error('master_manifest_exclusions_invalid');
  }
  return manifest;
}

export async function computeSourceManifestHash(root = DEFAULT_ROOT, dependencies = {}) {
  const run = dependencies.execFile ?? execFile;
  const reader = dependencies.readFile ?? readFile;
  const fileStat = dependencies.stat ?? stat;
  const { stdout } = await run(
    'git',
    ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const names = stdout.toString('utf8').split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const name of names) {
    const absolute = path.join(root, name);
    hash.update(name.replaceAll('\\', '/'));
    hash.update('\0');
    try {
      const info = await fileStat(absolute);
      if (!info.isFile()) {
        hash.update('NONFILE\n');
        continue;
      }
      const bytes = await reader(absolute);
      hash.update(sha256(bytes));
      hash.update('\0');
      hash.update(String(bytes.byteLength));
      hash.update('\n');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('MISSING\n');
    }
  }
  return hash.digest('hex');
}

export function verifyFrozenRuntime(manifestInput, state, observed = {}) {
  const manifest = validateFrozenManifest(manifestInput);
  const processes = Array.isArray(state?.processes) ? state.processes : [];
  const listeners = Array.isArray(state?.listeners) ? state.listeners : [];
  const byPid = new Map(processes.map((row) => [numberField(row, 'ProcessId', 'processId'), row]));
  const app = byPid.get(manifest.runtime.appPid);
  const webview = byPid.get(manifest.runtime.webviewPid);
  if (!app || stringField(app, 'Name', 'name').toLowerCase() !== 'jarvis.exe') {
    throw new Error('master_runtime_app_identity_mismatch');
  }
  if (!webview || stringField(webview, 'Name', 'name').toLowerCase() !== 'msedgewebview2.exe') {
    throw new Error('master_runtime_webview_identity_mismatch');
  }
  let cursor = webview;
  let descendant = false;
  for (let depth = 0; depth < 16 && cursor; depth += 1) {
    const parentPid = numberField(cursor, 'ParentProcessId', 'parentProcessId');
    if (parentPid === manifest.runtime.appPid) {
      descendant = true;
      break;
    }
    cursor = byPid.get(parentPid);
  }
  if (!descendant) throw new Error('master_runtime_webview_not_owned');
  const commandLine = stringField(webview, 'CommandLine', 'commandLine');
  const expectedProfile = normalizePath(manifest.runtime.profile);
  if (!expectedProfile || !normalizePath(commandLine).includes(expectedProfile)) {
    throw new Error('master_runtime_profile_mismatch');
  }
  const cdpPort = parseDebugPort(commandLine);
  if (!cdpPort) throw new Error('master_runtime_cdp_missing');
  const listener = listeners.find(
    (row) =>
      numberField(row, 'LocalPort', 'localPort') === cdpPort &&
      numberField(row, 'OwningProcess', 'owningProcess') === manifest.runtime.webviewPid &&
      ['127.0.0.1', '::1'].includes(stringField(row, 'LocalAddress', 'localAddress')),
  );
  if (!listener) throw new Error('master_runtime_cdp_ownership_mismatch');
  const executablePath = stringField(app, 'ExecutablePath', 'executablePath');
  if (!executablePath) throw new Error('master_runtime_executable_missing');
  if (observed.head && observed.head !== manifest.candidate.head) throw new Error('master_candidate_head_changed');
  if (
    observed.sourceManifestHash &&
    observed.sourceManifestHash !== manifest.candidate.sourceManifestHash
  ) {
    throw new Error('master_candidate_source_changed');
  }
  if (
    observed.nativeBinaryHash &&
    observed.nativeBinaryHash !== manifest.candidate.nativeBinaryHash
  ) {
    throw new Error('master_candidate_binary_changed');
  }
  return Object.freeze(sanitizeEvidence({
    capturedAt: state.capturedAt,
    appPid: manifest.runtime.appPid,
    webviewPid: manifest.runtime.webviewPid,
    profile: manifest.runtime.profile,
    mainTarget: manifest.runtime.mainTarget,
    cdpPort,
    executablePath,
  }));
}

async function gitHead(root, dependencies = {}) {
  const run = dependencies.execFile ?? execFile;
  const { stdout } = await run('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout.trim();
}
async function fileSha256(filePath, dependencies = {}) {
  const reader = dependencies.readFile ?? readFile;
  return sha256(await reader(filePath));
}

export async function verifyManifestAgainstMachine(manifest, options = {}, dependencies = {}) {
  validateFrozenManifest(manifest);
  const root = options.root ?? DEFAULT_ROOT;
  const stateProbe = dependencies.stateProbe ?? readWindowsNativeState;
  const state = await stateProbe();
  const app = (state.processes ?? []).find(
    (row) => numberField(row, 'ProcessId', 'processId') === manifest.runtime.appPid,
  );
  const executablePath = stringField(app, 'ExecutablePath', 'executablePath');
  if (!executablePath) throw new Error('master_runtime_executable_missing');
  const observed = {
    head: await (dependencies.gitHead ?? gitHead)(root, dependencies),
    sourceManifestHash: await (dependencies.sourceManifestHash ?? computeSourceManifestHash)(root, dependencies),
    nativeBinaryHash: await (dependencies.binaryHash ?? fileSha256)(executablePath, dependencies),
  };
  return verifyFrozenRuntime(manifest, state, observed);
}

function parseArgs(argv) {
  const result = { root: DEFAULT_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--manifest' && value) result.manifest = value, index += 1;
    else if (key === '--evidence' && value) result.evidence = value, index += 1;
    else if (key === '--root' && value) result.root = value, index += 1;
    else throw new Error('master_native_arguments_invalid');
  }
  if (!result.manifest || !result.evidence) throw new Error('master_native_arguments_invalid');
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
  const started = performance.now();
  try {
    const identity = await verifyManifestAgainstMachine(manifest, { root: args.root });
    const record = await appendEvidenceLine(args.evidence, {
      scenario: 'A-NATIVE-BINDING',
      step: 'verify-frozen-runtime',
      status: 'pass',
      durationMs: performance.now() - started,
      evidence: 'native/runtime-identity.json',
      details: identity,
    });
    process.stdout.write(JSON.stringify(record) + '\n');
  } catch (error) {
    await appendEvidenceLine(args.evidence, {
      scenario: 'A-NATIVE-BINDING',
      step: 'verify-frozen-runtime',
      status: 'fail',
      durationMs: performance.now() - started,
      layer: 'native-binding',
      error: { name: error?.name, message: error?.message },
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(String(error?.message ?? 'master_native_failed') + '\n');
    process.exitCode = 1;
  });
}
