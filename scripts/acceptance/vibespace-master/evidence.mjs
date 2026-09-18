import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeEvidence } from '../../pr31-native-acceptance-harness.mjs';

export const EVIDENCE_STATUSES = Object.freeze(['pass', 'fail', 'blocked', 'not-run', 'not-applicable']);
const STATUS = new Set(EVIDENCE_STATUSES);
const SAFE_ID = /^[A-Z][A-Z0-9-]{2,63}$/u;
const SAFE_STEP = /^[a-z0-9][a-z0-9._:-]{1,127}$/u;

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeRelativeEvidence(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || path.isAbsolute(value)) {
    throw new Error('master_evidence_path_invalid');
  }
  const normalized = value.replaceAll('\\\\', '/');
  if (normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('master_evidence_path_invalid');
  }
  return normalized;
}

export function createEvidenceRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('master_evidence_invalid');
  if (!SAFE_ID.test(String(input.scenario ?? ''))) throw new Error('master_evidence_scenario_invalid');
  if (!SAFE_STEP.test(String(input.step ?? ''))) throw new Error('master_evidence_step_invalid');
  if (!STATUS.has(input.status)) throw new Error('master_evidence_status_invalid');
  const at = input.at ?? new Date().toISOString();
  if (!canonicalIso(at)) throw new Error('master_evidence_time_invalid');
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error('master_evidence_duration_invalid');
  return Object.freeze(sanitizeEvidence({
    scenario: input.scenario,
    step: input.step,
    status: input.status,
    at,
    durationMs,
    evidence: safeRelativeEvidence(input.evidence),
    ...(input.layer ? { layer: String(input.layer).slice(0, 128) } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.details ? { details: input.details } : {}),
  }));
}

export async function appendEvidenceLine(filePath, input) {
  const record = createEvidenceRecord(input);
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'a', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return record;
}

export async function readEvidenceLines(filePath) {
  let text = '';
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const parsed = JSON.parse(line);
    return createEvidenceRecord(parsed);
  });
}

export function summarizeEvidence(records) {
  const counts = Object.fromEntries(EVIDENCE_STATUSES.map((status) => [status, 0]));
  const latestByScenario = {};
  for (const record of records) {
    if (!STATUS.has(record.status)) throw new Error('master_evidence_status_invalid');
    counts[record.status] += 1;
    latestByScenario[record.scenario] = record;
  }
  return Object.freeze({ counts: Object.freeze(counts), latestByScenario: Object.freeze(latestByScenario) });
}
