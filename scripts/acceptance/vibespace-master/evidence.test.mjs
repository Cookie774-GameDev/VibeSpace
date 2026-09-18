import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendEvidenceLine,
  createEvidenceRecord,
  readEvidenceLines,
  summarizeEvidence,
} from './evidence.mjs';

test('records append-only failed then corrected attempts without rewriting history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibespace-master-evidence-'));
  const file = path.join(root, 'evidence.jsonl');
  try {
    await appendEvidenceLine(file, {
      scenario: 'B-SCHEMA',
      step: 'native-append',
      status: 'fail',
      at: '2026-09-18T12:00:00.000Z',
      durationMs: 4,
      error: { message: 'schema mismatch', token: 'secret-value' },
    });
    await appendEvidenceLine(file, {
      scenario: 'B-SCHEMA',
      step: 'native-append',
      status: 'pass',
      at: '2026-09-18T12:00:01.000Z',
      durationMs: 3,
      evidence: 'native/schema-retry.json',
    });
    const rows = await readEvidenceLines(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'fail');
    assert.equal(rows[1].status, 'pass');
    assert.equal(JSON.stringify(rows).includes('secret-value'), false);
    const summary = summarizeEvidence(rows);
    assert.equal(summary.counts.fail, 1);
    assert.equal(summary.counts.pass, 1);
    assert.equal(summary.latestByScenario['B-SCHEMA'].status, 'pass');
    assert.equal((await readFile(file, 'utf8')).trim().split(/\r?\n/u).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid status, identifiers, traversal and noncanonical timestamps', () => {
  const base = {
    scenario: 'D-CODEX-REAL',
    step: 'terminal',
    status: 'pass',
    at: '2026-09-18T12:00:00.000Z',
    durationMs: 1,
  };
  assert.throws(() => createEvidenceRecord({ ...base, status: 'skip' }), /status_invalid/u);
  assert.throws(() => createEvidenceRecord({ ...base, scenario: 'bad' }), /scenario_invalid/u);
  assert.throws(() => createEvidenceRecord({ ...base, evidence: '../private.json' }), /path_invalid/u);
  assert.throws(() => createEvidenceRecord({ ...base, at: 'today' }), /time_invalid/u);
  assert.throws(() => createEvidenceRecord({ ...base, durationMs: -1 }), /duration_invalid/u);
});
