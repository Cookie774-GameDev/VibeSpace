import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSetupRuntime } from '../setup-runtime.mjs';

test('watchdog recovers crashes with backoff, persists Off, and requires tools for completion', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-lifecycle-test-'));
  let tick,
    clock = 0,
    count = 0;
  const children = [];
  const options = {
    stateDir,
    base: stateDir,
    endpoint: 'http://127.0.0.1:1234',
    token: 'fixture',
    getTools: async () => ({ tools: Array(count).fill({ name: 'fixture' }) }),
    protect: async () => 'synthetic-protected-value',
    fetchRequest: async () => ({ ok: true }),
    now: () => clock,
    schedule: (fn, ms) => {
      assert.equal(ms, 1000);
      tick = fn;
    },
    unschedule: () => {},
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        killed: false,
        kill() {
          this.killed = true;
        },
      });
      children.push(child);
      return child;
    },
  };
  const runtime = await createSetupRuntime(options);
  try {
    await runtime.save({
      tunnelId: 'tunnel_123456789',
      apiKey: 'synthetic-runtime-credential',
      step: 3,
    });
    assert.equal((await runtime.snapshot()).setupComplete, false);
    await runtime.connect();
    await writeFile(path.join(stateDir, 'tunnel-health.url'), 'http://127.0.0.1:1234');
    assert.equal((await runtime.snapshot()).setupComplete, false);
    count = 2;
    assert.equal((await runtime.snapshot()).setupComplete, true);
    children[0].exitCode = 1;
    children[0].emit('exit', 1);
    tick();
    assert.equal(children.length, 1);
    clock = 1000;
    tick();
    for (let i = 0; children.length < 2 && i < 100; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(children.length, 2);
    await runtime.setEnabled(false);
    clock = 60000;
    tick();
    assert.equal(children.length, 2);
    assert.equal(children[1].killed, true);
    assert.equal((await runtime.snapshot()).status, 'off');
    assert.equal(JSON.parse(await readFile(path.join(stateDir, 'setup.json'))).enabled, false);
    const resumed = await createSetupRuntime(options);
    tick();
    assert.equal(children.length, 2);
    assert.equal((await resumed.snapshot()).setupComplete, true);
    await resumed.close();
  } finally {
    await runtime.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test('Off rejects authenticated MCP execution without removing configuration access', async () => {
  const { startGateway } = await import('../gateway.mjs');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-off-http-'));
  const gateway = await startGateway({
    stateDir,
    port: 0,
    client: { close: async () => {}, listTools: async () => ({ tools: [] }) },
  });
  const headers = { authorization: 'Bearer ' + gateway.token, 'content-type': 'application/json' };
  try {
    const response = await fetch(gateway.endpoint + '/setup/disconnect', {
      method: 'POST',
      headers,
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, false);
    assert.equal(
      (await fetch(gateway.endpoint + '/mcp', { method: 'POST', headers, body: '{}' })).status,
      503,
    );
    assert.equal((await fetch(gateway.endpoint + '/setup/state', { headers })).status, 200);
  } finally {
    await gateway.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
