import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRecorder } from './recorder.mjs';

test('rotation retains a previous file and missing sequences are explicit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-log-rotate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recorder = await createFileRecorder(dir, 1);
  await recorder.accept({ instanceId: 'one', sequence: 1, events: [{ sequence: 1 }] });
  await recorder.accept({ instanceId: 'one', sequence: 4, events: [{ sequence: 4 }] });
  assert.match(await readFile(join(dir, 'events.jsonl.previous'), 'utf8'), /"sequence":1/);
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].gap, 2);
  assert.equal(lines[1].event.sequence, 4);
});

test('persists events without a viewer, deduplicates samples, and marks disconnects', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vs-log-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const recorder = await createFileRecorder(dir);
  const snapshot = { instanceId: 'native-1', events: [{ sequence: 1, kind: 'semantic-tool', phase: 'completed', durationMs: 4.5, data: { result: 'answer' } }], sequence: 1 };
  await recorder.accept(snapshot);
  await recorder.accept(snapshot);
  const lines = (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event.durationMs, 4.5);
  await recorder.disconnected();
  assert.equal(JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')).connected, false);
  const resumed = await createFileRecorder(dir);
  await resumed.accept(snapshot);
  assert.equal((await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').length, 1);
});
