import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app', 'src-tauri', 'src', 'lib.rs'), 'utf8');

function between(value, startMarker, endMarker) {
  const start = value.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const bodyStart = start + startMarker.length;
  const end = value.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return value.slice(bodyStart, end);
}

function rustStringConstant(value, name) {
  const match = value.match(new RegExp(`const\\s+${name}:\\s*&str\\s*=\\s*"([0-9a-f]{64})";`, 'u'));
  assert.ok(match, `missing Rust string constant: ${name}`);
  return match[1];
}

test('ordinary native authority registers the exact bounded file mutation commands', () => {
  const ordinary = between(source, 'fn run_ordinary(', '#[cfg(test)]');
  const handler = between(ordinary, '.invoke_handler(tauri::generate_handler![', '])');
  const commands = handler
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/,$/u, ''))
    .filter((line) => line && !line.startsWith('#[cfg('));

  for (const command of ['fsread::fs_rename_file', 'fsread::fs_delete_file']) {
    assert.equal(
      commands.filter((candidate) => candidate === command).length,
      1,
      `${command} must be registered exactly once`,
    );
  }

  assert.ok(
    commands.indexOf('fsread::fs_rename_file') < commands.indexOf('fsread::fs_delete_file'),
    'rename must precede delete in the frozen handler authority',
  );

  const authorityMatch = source.match(
    /const ORDINARY_HANDLER_AUTHORITY: &str = "\\\r?\n([\s\S]*?)";/u,
  );
  assert.ok(authorityMatch, 'frozen ordinary command authority must be present');
  const frozenAuthority = authorityMatch[1].replace(/\r\n/gu, '\n');
  const normalizedHandler = handler
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/,$/u, ''))
    .filter(Boolean)
    .filter((line) => !line.startsWith('//'))
    .join('\n');
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const authorityHash = rustStringConstant(source, 'ORDINARY_HANDLER_AUTHORITY_SHA256');
  const normalizedHash = rustStringConstant(source, 'ORDINARY_HANDLER_NORMALIZED_SHA256');

  assert.equal(hash(frozenAuthority), authorityHash);
  assert.equal(hash(normalizedHandler), normalizedHash);
});
