import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(repository, 'supabase', 'config.toml');
const templateRoot = realpathSync(path.join(repository, 'supabase', 'templates'));

test('active Supabase auth template paths resolve to committed local templates', () => {
  const config = readFileSync(configPath, 'utf8');
  const contentPaths = [...config.matchAll(/^\s*content_path\s*=\s*"([^"]+)"\s*$/gmu)].map(
    ([, value]) => value,
  );

  assert.deepEqual(contentPaths, [
    './supabase/templates/confirmation.html',
    './supabase/templates/magic_link.html',
    './supabase/templates/recovery.html',
    './supabase/templates/email_change.html',
  ]);

  for (const relativePath of contentPaths) {
    const absolutePath = path.resolve(repository, relativePath);
    assert.equal(existsSync(absolutePath), true, `${relativePath} must exist`);
    assert.equal(
      path.relative(templateRoot, realpathSync(absolutePath)).startsWith('..'),
      false,
      `${relativePath} must remain inside supabase/templates`,
    );
  }
});

test('every account email is branded, code-based, phishing-safe, and image-independent', () => {
  const templates = ['confirmation.html', 'magic_link.html', 'recovery.html', 'email_change.html'];

  for (const name of templates) {
    const html = readFileSync(path.join(templateRoot, name), 'utf8');
    assert.match(html, /VibeSpace/u, `${name} must carry the product identity`);
    assert.match(html, /\{\{\s*\.Token\s*\}\}/u, `${name} must present the one-time code`);
    assert.match(html, /expires in one hour/iu, `${name} must explain expiry`);
    assert.match(html, /do not (?:share|forward)/iu, `${name} must include phishing-safe copy`);
    assert.doesNotMatch(html, /<img|tracking|service_role|sb_secret_/iu);
  }
});

test('local email testing uses the current Supabase config section', () => {
  const config = readFileSync(configPath, 'utf8');

  assert.match(config, /^\[local_smtp\]$/mu);
  assert.doesNotMatch(config, /^\[inbucket\]$/mu);
});
