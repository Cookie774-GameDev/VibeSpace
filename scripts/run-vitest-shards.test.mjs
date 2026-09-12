import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertExactCoverage,
  buildVitestArgs,
  discoverVitestFiles,
  partitionTestFiles,
} from './run-vitest-shards.mjs';

test('discovers frontend Vitest files recursively in deterministic order', async (t) => {
  const appDir = await mkdtemp(path.join(tmpdir(), 'vibespace-vitest-discovery-'));
  t.after(() => rm(appDir, { recursive: true, force: true }));

  await mkdir(path.join(appDir, 'src', 'zeta'), { recursive: true });
  await mkdir(path.join(appDir, 'src', 'alpha'), { recursive: true });
  await writeFile(path.join(appDir, 'src', 'zeta', 'view.test.tsx'), '');
  await writeFile(path.join(appDir, 'src', 'alpha', 'logic.spec.ts'), '');
  await writeFile(path.join(appDir, 'src', 'alpha', 'notes.ts'), '');

  assert.deepEqual(await discoverVitestFiles(appDir), [
    'src/alpha/logic.spec.ts',
    'src/zeta/view.test.tsx',
  ]);
});

test('partitions every file exactly once without exceeding the shard size', () => {
  const files = Array.from({ length: 123 }, (_, index) => `src/case-${index}.test.ts`);
  const shards = partitionTestFiles(files, 50);

  assert.deepEqual(
    shards.map((shard) => shard.length),
    [50, 50, 23],
  );
  assert.doesNotThrow(() => assertExactCoverage(files, shards));
});

test('coverage validation rejects duplicate and missing test files', () => {
  const files = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'];

  assert.throws(
    () => assertExactCoverage(files, [['src/a.test.ts', 'src/a.test.ts'], ['src/b.test.ts']]),
    /duplicate.*src\/a\.test\.ts.*missing.*src\/c\.test\.ts/is,
  );
});

test('rejects invalid shard sizes', () => {
  assert.throws(() => partitionTestFiles(['src/a.test.ts'], 0), /positive integer/i);
  assert.throws(() => partitionTestFiles(['src/a.test.ts'], 1.5), /positive integer/i);
});

test('bounds worker concurrency for every shard', () => {
  assert.deepEqual(buildVitestArgs(['src/default.test.ts']), [
    'run',
    '--reporter=dot',
    '--maxWorkers=4',
    '--testTimeout=15000',
    'src/default.test.ts',
  ]);
  assert.deepEqual(buildVitestArgs(['src/a.test.ts'], 4), [
    'run',
    '--reporter=dot',
    '--maxWorkers=4',
    '--testTimeout=15000',
    'src/a.test.ts',
  ]);
  assert.throws(() => buildVitestArgs(['src/a.test.ts'], 0), /positive integer/i);
});
