import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(
  await readFile(new URL('../app/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);

test('packaged updates use only the official signed GitHub Releases manifest', () => {
  const endpoints = config.plugins?.updater?.endpoints;

  assert.deepEqual(endpoints, [
    'https://github.com/Cookie774-GameDev/VibeSpace/releases/latest/download/latest.json',
  ]);

  const endpoint = new URL(endpoints[0]);
  assert.equal(endpoint.protocol, 'https:');
  assert.equal(endpoint.hostname, 'github.com');
  assert.equal(
    endpoint.pathname,
    '/Cookie774-GameDev/VibeSpace/releases/latest/download/latest.json',
  );
  assert.equal(config.bundle?.createUpdaterArtifacts, true);
  assert.match(config.plugins?.updater?.pubkey ?? '', /\S/u);
});
