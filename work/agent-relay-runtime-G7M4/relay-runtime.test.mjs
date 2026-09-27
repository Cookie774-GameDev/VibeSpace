import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLoopbackServer, startRelayRuntime } from './relay-runtime.mjs';

test('loopback server binds only to 127.0.0.1 and serves a request', async () => {
  const server = await startLoopbackServer(async () => new Response('ok'), 0);
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('upstream engine starts on loopback, answers health, and shuts down', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-runtime-'));
  let host;
  try {
    host = await startRelayRuntime({ dbPath: join(dir, 'relay.sqlite'), port: 0 });
    assert.equal(host.host, '127.0.0.1');
    assert.equal(host.server.address().address, '127.0.0.1');
    assert.ok(host.port > 0);
    const response = await fetch(`${host.baseUrl}/health`);
    assert.equal(response.status, 200);
  } finally {
    await host?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('engine refuses a missing database path before opening SQLite', async () => {
  await assert.rejects(() => startRelayRuntime({}), /dbPath is required/);
});
