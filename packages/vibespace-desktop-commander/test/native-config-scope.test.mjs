import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('native Desktop Commander config scope follows its ephemeral port without granting other paths', async () => {
  const capability = JSON.parse(
    await readFile(
      new URL('../../../app/src-tauri/capabilities/default.json', import.meta.url),
      'utf8',
    ),
  );
  const http = capability.permissions.find(
    (permission) => permission.identifier === 'http:default',
  );
  const connector = http.allow.filter(
    ({ url }) => url.startsWith('http://127.0.0.1:') && url.endsWith('/config'),
  );
  assert.deepEqual(connector, [{ url: 'http://127.0.0.1:*/config' }]);
  assert.ok(!http.allow.some(({ url }) => url === 'http://127.0.0.1:*/*'));
});
