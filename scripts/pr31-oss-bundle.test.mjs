import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verifyPr31OssBundle } from './pr31-oss-bundle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('PR31 OSS bundle metadata is deterministically cross-checked', () => {
  assert.deepEqual(verifyPr31OssBundle(ROOT), { ok: true, errors: [] });
});

test('PR31 OSS checker rejects a package-lock integrity drift without network access', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'vibespace-pr31-oss-'));
  try {
    mkdirSync(resolve(fixture, 'app/src-tauri'), { recursive: true });
    mkdirSync(resolve(fixture, 'docs'), { recursive: true });
    mkdirSync(resolve(fixture, 'scripts'), { recursive: true });
    cpSync(resolve(ROOT, 'docs/oss'), resolve(fixture, 'docs/oss'), { recursive: true });
    cpSync(resolve(ROOT, 'app/src-tauri/tauri.conf.json'), resolve(fixture, 'app/src-tauri/tauri.conf.json'));
    cpSync(resolve(ROOT, 'app/package.json'), resolve(fixture, 'app/package.json'));
    cpSync(resolve(ROOT, 'package.json'), resolve(fixture, 'package.json'));
    cpSync(resolve(ROOT, 'package-lock.json'), resolve(fixture, 'package-lock.json'));
    const lockPath = resolve(fixture, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/gpt-tokenizer'].integrity = 'sha512-drift';
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const result = verifyPr31OssBundle(fixture);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('package-lock integrity mismatch: gpt-tokenizer'));
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
