import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSetupRuntime, protectKey } from '../setup-runtime.mjs';
import { startGateway } from '../gateway.mjs';

test(
  'Windows protected storage round-trips without PowerShell module autoloading',
  { skip: process.platform !== 'win32' },
  async () => {
    const fixture = 'synthetic-runtime-storage-test';
    const encrypted = await protectKey(fixture);
    assert.ok(!encrypted.includes(fixture));
    assert.equal(await protectKey(encrypted, true), fixture);
  },
);

test('resumes protected progress, coalesces connect, and requires health before readiness', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-setup-test-'));
  const secret = 'unit-test-runtime-credential';
  const calls = [];
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    exitCode: null,
    kill() {
      this.killed = true;
    },
  });
  const options = {
    stateDir,
    base: stateDir,
    endpoint: 'http://127.0.0.1:52341',
    token: 'unit-bearer',
    getTools: async () => ({ tools: [{ name: 'read_file' }] }),
    protect: async (value, decrypt) => (decrypt ? secret : 'protected-unit-fixture'),
    spawnProcess: (...args) => {
      calls.push(args);
      return child;
    },
    fetchRequest: async () => ({ ok: true }),
  };
  try {
    const runtime = await createSetupRuntime(options);
    await assert.rejects(runtime.connect(), /Save your tunnel/);
    await assert.rejects(runtime.save({ apiKey: 'sk-admin-' + 'x'.repeat(25) }), /runtime API key/);
    await runtime.save({ tunnelId: 'tunnel_123456789', apiKey: secret, step: 2 });
    assert.ok(!(await readFile(path.join(stateDir, 'setup.json'), 'utf8')).includes(secret));
    const resumed = await createSetupRuntime(options);
    assert.equal((await resumed.snapshot()).step, 2);
    assert.equal((await resumed.snapshot()).hasKey, true);
    await Promise.all([resumed.connect(), resumed.connect()]);
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(calls[0][1]).includes(secret));
    assert.equal(calls[0][2].env.CONTROL_PLANE_API_KEY, secret);
    assert.equal((await resumed.snapshot()).status, 'connecting');
    await writeFile(path.join(stateDir, 'tunnel-health.url'), 'http://127.0.0.1:1234/');
    assert.equal((await resumed.snapshot()).status, 'ready');
    await assert.rejects(resumed.save({ tunnelId: 'tunnel_987654321' }), /Disconnect/);
    await resumed.close();
    assert.equal((await resumed.snapshot()).status, 'disconnected');
    assert.equal(child.killed, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('setup status requires bearer and rejects cross-origin access; page has strict CSP', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-setup-http-'));
  const gateway = await startGateway({
    stateDir,
    port: 0,
    client: { close: async () => {}, listTools: async () => ({ tools: [] }) },
  });
  try {
    const page = await fetch(gateway.endpoint + '/setup');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok(!(await page.text()).includes(gateway.token));
    assert.equal((await fetch(gateway.endpoint + '/setup/state')).status, 401);
    const headers = { authorization: 'Bearer ' + gateway.token };
    assert.equal(
      (
        await fetch(gateway.endpoint + '/setup/state', {
          headers: { ...headers, origin: 'https://invalid.example' },
        })
      ).status,
      401,
    );
    const status = await (await fetch(gateway.endpoint + '/setup/state', { headers })).json();
    assert.equal(status.status, 'disconnected');
    assert.ok(!JSON.stringify(status).includes(gateway.token));
    assert.equal(status.toolCount, 1);
  } finally {
    await gateway.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
