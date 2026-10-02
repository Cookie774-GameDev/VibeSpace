'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../../..');
const mode = process.argv[2];
if (!['red', 'green'].includes(mode)) throw Error('Use red or green explicitly');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonicalHash = bytes => crypto.createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
const source = path.join(root, 'app/src/features/chat/Composer.tsx');
const original = path.join(__dirname, 'Composer.original.tsx');
const sourceCanonical = canonicalHash(fs.readFileSync(source));
const originalCanonical = canonicalHash(fs.readFileSync(original));
const headBlob = spawnSync('git', ['show', 'HEAD:app/src/features/chat/Composer.tsx'], { cwd: root });
if (headBlob.status !== 0) throw Error('Cannot verify original against QA HEAD blob');
const headCanonical = canonicalHash(headBlob.stdout);
if (sourceCanonical !== originalCanonical || headCanonical !== originalCanonical) {
  throw Error('Composer canonical content differs from preserved original/QA HEAD; rebase packet');
}
const req = createRequire(path.join(root, 'app/package.json'));
const cli = path.join(path.dirname(req.resolve('vitest/package.json')), 'vitest.mjs');
const config = path.join(__dirname, mode === 'red' ? 'vitest.config.ts' : 'candidate.config.ts');
const result = spawnSync(process.execPath, [cli, 'run', '--config', config, '--reporter=json', '--outputFile', path.join(__dirname, mode + '-report.json')], {
  cwd: path.join(root, 'app'), env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' }, encoding: 'utf8',
});
fs.writeFileSync(path.join(__dirname, mode + '.log'), (result.stdout || '') + (result.stderr || ''));
const receipt = { mode, sourceSha256: hash(source), originalSha256: hash(original), sourceCanonicalSha256: sourceCanonical, originalCanonicalSha256: originalCanonical, qaHeadCanonicalSha256: headCanonical, normalization: 'CRLF to LF only; no whitespace/BOM/content stripping', exitCode: result.status, error: result.error?.message, candidateOnlyTransform: mode === 'green', at: new Date().toISOString() };
fs.writeFileSync(path.join(__dirname, mode + '-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
// Raw status is retained: expected red is still a real failing test.
process.exitCode = result.status ?? 1;
