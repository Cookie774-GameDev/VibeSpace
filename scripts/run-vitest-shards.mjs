import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u;
const DEFAULT_SHARD_SIZE = 50;
const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_TEST_TIMEOUT_MS = 15_000;

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export async function discoverVitestFiles(appDir) {
  const srcDir = path.join(appDir, 'src');
  const discovered = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        discovered.push(toPosixPath(path.relative(appDir, absolutePath)));
      }
    }
  }

  await visit(srcDir);
  return discovered.sort((left, right) => left.localeCompare(right, 'en'));
}

export function partitionTestFiles(files, maxFilesPerShard = DEFAULT_SHARD_SIZE) {
  if (!Number.isInteger(maxFilesPerShard) || maxFilesPerShard <= 0) {
    throw new TypeError('Shard size must be a positive integer.');
  }

  const shards = [];
  for (let offset = 0; offset < files.length; offset += maxFilesPerShard) {
    shards.push(files.slice(offset, offset + maxFilesPerShard));
  }
  return shards;
}

export function assertExactCoverage(discoveredFiles, shards) {
  const expected = new Set(discoveredFiles);
  const counts = new Map();

  for (const file of shards.flat()) {
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
  const missing = discoveredFiles.filter((file) => !counts.has(file));
  const unexpected = [...counts.keys()].filter((file) => !expected.has(file)).sort();

  if (duplicates.length || missing.length || unexpected.length) {
    throw new Error(
      [
        duplicates.length ? `duplicate files: ${duplicates.join(', ')}` : null,
        missing.length ? `missing files: ${missing.join(', ')}` : null,
        unexpected.length ? `unexpected files: ${unexpected.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}

function parsePositiveInteger(raw, label, fallback) {
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer; received ${raw}.`);
  }
  return parsed;
}

function parseShardSize(args) {
  const argument = args.find((value) => value.startsWith('--shard-size='));
  return parsePositiveInteger(
    argument?.slice('--shard-size='.length) ?? process.env.VITEST_SHARD_SIZE,
    'Shard size',
    DEFAULT_SHARD_SIZE,
  );
}

function parseMaxWorkers(args) {
  const argument = args.find((value) => value.startsWith('--max-workers='));
  return parsePositiveInteger(
    argument?.slice('--max-workers='.length) ?? process.env.VITEST_MAX_WORKERS,
    'Max workers',
    DEFAULT_MAX_WORKERS,
  );
}

export function buildVitestArgs(shard, maxWorkers = DEFAULT_MAX_WORKERS) {
  const boundedWorkers = parsePositiveInteger(maxWorkers, 'Max workers', DEFAULT_MAX_WORKERS);
  return [
    'run',
    '--reporter=dot',
    `--maxWorkers=${boundedWorkers}`,
    `--testTimeout=${DEFAULT_TEST_TIMEOUT_MS}`,
    ...shard,
  ];
}

export async function runVitestShards({
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  shardSize = DEFAULT_SHARD_SIZE,
  maxWorkers = DEFAULT_MAX_WORKERS,
  listOnly = false,
} = {}) {
  const appDir = path.join(repoRoot, 'app');
  const files = await discoverVitestFiles(appDir);
  if (files.length === 0) {
    throw new Error(`No frontend Vitest files found under ${path.join(appDir, 'src')}`);
  }

  const shards = partitionTestFiles(files, shardSize);
  assertExactCoverage(files, shards);

  console.log(
    `Discovered ${files.length} frontend test files in ${shards.length} deterministic shard(s).`,
  );
  if (listOnly) {
    for (const [index, shard] of shards.entries()) {
      console.log(`shard ${index + 1}/${shards.length} (${shard.length}): ${shard.join(', ')}`);
    }
    return { files, shards };
  }

  const vitestCli = path.join(appDir, 'node_modules', 'vitest', 'vitest.mjs');
  for (const [index, shard] of shards.entries()) {
    console.log(`\n=== Vitest shard ${index + 1}/${shards.length} (${shard.length} files) ===`);
    const result = spawnSync(process.execPath, [vitestCli, ...buildVitestArgs(shard, maxWorkers)], {
      cwd: appDir,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Vitest shard ${index + 1}/${shards.length} failed with exit code ${result.status ?? 'unknown'}.`,
      );
    }
  }

  console.log(`\nAll ${files.length} frontend test files passed exactly once.`);
  return { files, shards };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  runVitestShards({
    shardSize: parseShardSize(args),
    maxWorkers: parseMaxWorkers(args),
    listOnly: args.includes('--list'),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
