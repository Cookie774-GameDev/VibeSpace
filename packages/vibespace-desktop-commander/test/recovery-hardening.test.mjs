import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSetupRuntime } from '../setup-runtime.mjs';

async function fixture({ saved, fetchRequest } = {}) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-recovery-contract-'));
  if (saved) await writeFile(path.join(stateDir, 'setup.json'), JSON.stringify(saved));
  let clock = 0;
  let tick;
  let requests = 0;
  const children = [];
  const runtime = await createSetupRuntime({
    stateDir,
    base: stateDir,
    endpoint: 'http://127.0.0.1:23456',
    token: 'synthetic-local-token',
    getTools: async () => ({ tools: [{ name: 'read_file' }] }),
    protect: async () => 'synthetic-protected-fixture',
    now: () => clock,
    schedule: (fn, ms) => {
      assert.equal(ms, 1000);
      tick = fn;
      return 1;
    },
    unschedule: () => {},
    fetchRequest: async (...args) => {
      requests++;
      return fetchRequest ? fetchRequest(...args) : { ok: true };
    },
    spawnProcess: () => {
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        exitCode: null,
        kill() {
          this.killed = true;
          this.exitCode = 1;
          this.emit('exit', 1);
        },
      });
      children.push(child);
      return child;
    },
  });
  return {
    runtime,
    children,
    requests: () => requests,
    tick: async (time) => {
      clock = time;
      await tick();
    },
    healthFile: () => writeFile(path.join(stateDir, 'tunnel-health.url'), 'http://127.0.0.1:23457'),
    start: async () => {
      await runtime.save({
        tunnelId: 'tunnel_test123456789',
        apiKey: 'synthetic-runtime-credential',
      });
      await runtime.connect();
    },
    cleanup: async () => {
      await runtime.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

test('a bad saved display name cannot discard an existing protected credential or Off setting', async () => {
  const f = await fixture({
    saved: {
      version: 1,
      displayName: '',
      tunnelId: 'tunnel_test123456789',
      protectedKey: 'already-protected',
      enabled: false,
      setupComplete: true,
    },
  });
  try {
    const state = await f.runtime.snapshot();
    assert.equal(state.hasKey, true);
    assert.equal(state.enabled, false);
    assert.equal(state.setupComplete, true);
    assert.equal(state.displayName, 'VibeSpace Desktop');
  } finally {
    await f.cleanup();
  }
});

test('display names reject non-text values without altering saved state', async () => {
  const f = await fixture();
  try {
    await f.runtime.save({ displayName: 'My VibeSpace' });
    for (const displayName of [123, {}, ['bad'], 'x'.repeat(65), 'bad\u0000name'])
      await assert.rejects(f.runtime.save({ displayName }), /app name/);
    assert.equal((await f.runtime.snapshot()).displayName, 'My VibeSpace');
  } finally {
    await f.cleanup();
  }
});

test('the one-second watchdog probes a living tunnel, not just exited children', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.healthFile();
    const before = f.requests();
    await f.tick(1000);
    assert.equal(f.requests(), before + 1, 'each watchdog tick must check /readyz');
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].killed, false);
  } finally {
    await f.cleanup();
  }
});

test('three failed health checks after startup grace recover the owned tunnel with backoff', async () => {
  const f = await fixture({ fetchRequest: async () => ({ ok: false }) });
  try {
    await f.start();
    await f.healthFile();
    await f.tick(1000);
    await f.tick(2000);
    await f.tick(3000);
    assert.equal(f.children[0].killed, false, 'startup grace must prevent a restart loop');
    await f.tick(31000);
    await f.tick(32000);
    assert.equal(f.children[0].killed, false, 'must honor the failure threshold');
    await f.tick(33000);
    assert.equal(f.children[0].killed, true, 'a live but unhealthy child must be recovered');
    assert.equal(f.children.length, 1);
    await f.tick(34000);
    assert.equal(f.children.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('late successful health responses cannot turn a stopped connector back to Ready', async () => {
  let release;
  const f = await fixture({
    fetchRequest: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    await f.start();
    await f.healthFile();
    const pending = f.runtime.snapshot();
    for (let i = 0; !release && i < 50; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(typeof release, 'function');
    await f.runtime.setEnabled(false);
    release({ ok: true });
    await pending;
    await f.runtime.close();
    assert.equal((await f.runtime.snapshot()).status, 'off');
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].killed, true);
  } finally {
    await f.cleanup();
  }
});
