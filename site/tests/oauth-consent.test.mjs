import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../oauth/consent/index.html', import.meta.url), 'utf8');
const script = await readFile(
  new URL('../oauth/consent/oauth-consent.js', import.meta.url),
  'utf8',
);

assert.match(html, /Connect VibeSpace MCP/u);
assert.match(html, /id="signin-form"/u);
assert.match(html, /id="approve-button"/u);
assert.match(html, /id="deny-button"/u);
assert.match(script, /getAuthorizationDetails\(authorizationId\)/u);
assert.match(script, /approveAuthorization\(authorizationId\)/u);
assert.match(script, /denyAuthorization\(authorizationId\)/u);
assert.match(script, /getUser\(\)/u);
assert.match(script, /signInWithPassword/u);
assert.match(script, /startsWith\('sb_publishable_'\)/u);
assert.doesNotMatch(script, /service_role|sb_secret_/u);
assert.doesNotMatch(html, /service_role|sb_secret_/u);

console.log('OAuth consent contract passed.');
