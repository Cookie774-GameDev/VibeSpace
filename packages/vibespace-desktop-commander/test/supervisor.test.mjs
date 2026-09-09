import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { supervise } from '../supervisor.mjs';
test('supervisor restarts only its child with backoff; shutdown stops recovery', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-supervisor-fixture-'));
  let clock = 0;
  const children = [];
  const instance = await supervise(stateDir, {
    schedule: (_tick, delay) => {
      assert.equal(delay, 1000);
      return 1;
    },
    unschedule: () => {},
    now: () => clock,
    spawnProcess: (_exe, args, options) => {
      assert.match(args[0], /gateway.mjs$/);
      assert.equal(options.windowsHide, true);
      const child = Object.assign(new EventEmitter(), {
        killed: false,
        kill() {
          this.killed = true;
        },
      });
      children.push(child);
      return child;
    },
  });
  try {
    assert.equal(children.length, 1);
    children[0].emit('exit', 1);
    await instance.tick();
    assert.equal(children.length, 1);
    clock = 1000;
    await instance.tick();
    assert.equal(children.length, 2);
    await instance.stop();
    assert.equal(children[1].killed, true);
    clock = 60000;
    await instance.tick();
    assert.equal(children.length, 2);
  } finally {
    await instance.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
test('supervisor leaves an existing live owner untouched', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-supervisor-owner-'));
  const file = path.join(stateDir, 'supervisor.lock');
  const original = JSON.stringify({ pid: 12345 });
  await writeFile(file, original);
  try {
    const result = await supervise(stateDir, {
      alive: (pid) => assert.equal(pid, 12345),
      spawnProcess: () => assert.fail('must not spawn'),
    });
    assert.equal(result, undefined);
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
test('supervisor requests graceful gateway shutdown before releasing its lock', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'vs-supervisor-graceful-'));
  let sent;
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    kill: () => assert.fail('healthy gateway must shut down gracefully'),
    send(message, callback) {
      sent = message;
      callback(null);
      queueMicrotask(() => child.emit('exit', 0));
    },
  });
  const instance = await supervise(stateDir, {
    schedule: () => 1,
    unschedule: () => {},
    spawnProcess: () => child,
  });
  try {
    await instance.stop();
    assert.equal(sent, 'shutdown');
  } finally {
    await instance.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});
