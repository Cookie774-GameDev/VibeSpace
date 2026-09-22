import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDisplayName, protectKey } from '../setup-runtime.mjs';

test('the optional ChatGPT plugin name defaults without changing tunnel identity', () => {
  assert.equal(normalizeDisplayName(''), 'VibeSpace Desktop');
  assert.equal(normalizeDisplayName('   '), 'VibeSpace Desktop');
  assert.throws(() => normalizeDisplayName('\n'), /app name/);
});
test(
  'protected storage works with direct Windows DPAPI and retains no plaintext',
  { skip: process.platform !== 'win32' },
  async () => {
    const value = 'synthetic-runtime-key-\u00e9-123456789';
    const encrypted = await protectKey(value);
    assert.notEqual(encrypted, value);
    assert.ok(!encrypted.includes(value));
    assert.equal(await protectKey(encrypted, true), value);
    await assert.rejects(protectKey('not-a-dpapi-blob', true), /secure.*storage|unlock/i);
  },
);

test('saving credentials does not start a tunnel before the user clicks Connect', async () => {
  const { createSetupRuntime } = await import('../setup-runtime.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { EventEmitter } = await import('node:events');
  const stateDir = await mkdtemp(tmpdir() + '/vs-explicit-connect-');
  let tick,
    spawned = 0;
  const runtime = await createSetupRuntime({
    stateDir,
    base: stateDir,
    endpoint: 'http://127.0.0.1:23456',
    token: 'fixture',
    protect: async () => 'synthetic-protected-key',
    getTools: async () => ({ tools: [] }),
    schedule: (fn) => {
      tick = fn;
      return 1;
    },
    unschedule: () => {},
    spawnProcess: () => {
      spawned++;
      return Object.assign(new EventEmitter(), {
        killed: false,
        exitCode: null,
        kill() {
          this.killed = true;
        },
      });
    },
  });
  try {
    await runtime.save({ tunnelId: 'tunnel_123456789', apiKey: 'synthetic-runtime-api-key' });
    await tick();
    assert.equal(spawned, 0, 'autosave must not authenticate/start a tunnel');
    await runtime.connect();
    assert.equal(spawned, 1);
  } finally {
    await runtime.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('setup failures expose only bounded public error codes, never exception text', async () => {
  const { publicSetupError } = await import('../setup-runtime.mjs');
  const error = Object.assign(new Error('private-key-marker-123'), {
    code: 'CREDENTIAL_STORAGE_UNAVAILABLE',
  });
  assert.equal(publicSetupError(error).code, 'CREDENTIAL_STORAGE_UNAVAILABLE');
  assert.match(publicSetupError(error).error, /secure storage/);
  assert.ok(!JSON.stringify(publicSetupError(error)).includes('private-key-marker'));
  assert.deepEqual(publicSetupError(new Error('arbitrary-secret-value')), {
    code: 'SETUP_REQUEST_FAILED',
    error:
      'The local setup operation could not be completed. Retry without changing your credentials.',
  });
});

test('the authenticated setup endpoint returns a safe typed error for invalid input', async () => {
  const {startGateway}=await import('../gateway.mjs');
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const dir=await mkdtemp(tmpdir()+'/vs-safe-setup-errors-');
  const gateway=await startGateway({stateDir:dir,port:0,client:{close:async()=>{},listTools:async()=>({tools:[]})}});
  try {
    const response=await fetch(gateway.endpoint+'/setup/draft',{method:'POST',
      headers:{authorization:'Bearer '+gateway.token,'content-type':'application/json'},
      body:JSON.stringify({displayName:{secret:'private-value-never-echo'}})});
    assert.equal(response.status,400);
    const body=await response.json();
    assert.equal(body.code,'INVALID_PLUGIN_NAME');
    assert.ok(!JSON.stringify(body).includes('private-value'));
  } finally {await gateway.close();await rm(dir,{recursive:true,force:true});}
});
