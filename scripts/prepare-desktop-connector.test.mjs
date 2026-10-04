import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  plugin3SourceFiles,
  requiredPlugin3Files,
  runtimes,
  validatePlugin3Tree,
} from './prepare-desktop-connector.mjs';
import { plugin3TransportOptions } from '../packages/vibespace-desktop-commander/gateway.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageRoot = process.env.VIBESPACE_CONNECTOR_TEST_ROOT
  ? path.resolve(process.env.VIBESPACE_CONNECTOR_TEST_ROOT)
  : path.join(repoRoot, 'packages', 'vibespace-desktop-commander');
const plugin3Root = path.join(packageRoot, 'plugin3');
const plugin3Entry = path.join(plugin3Root, 'runtime', 'desktop-commander-v3', 'dist', 'index.js');
const plugin3Node = process.env.VIBESPACE_CONNECTOR_TEST_NODE || process.execPath;
const testStateRoot = process.env.VIBESPACE_CONNECTOR_TEST_STATE_ROOT || tmpdir();

async function copyPlugin3(destination) {
  await cp(plugin3Root, destination, { recursive: true });
  return destination;
}

function cleanEnv() {
  const allowed = ['ComSpec', 'PATHEXT', 'TMP', 'TEMP', 'windir', 'SystemRoot', 'PATH'];
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

test('Plugin3 production source is allowlisted and relocatable', async () => {
  assert.ok(plugin3SourceFiles.includes('runtime/desktop-commander-v3/dist'));
  for (const file of ['src/codex-reader.mjs', 'src/native-patch.mjs']) {
    assert.ok(plugin3SourceFiles.includes(file), `missing Plugin3 source allowlist entry: ${file}`);
    assert.ok(requiredPlugin3Files.includes(file), `missing required Plugin3 source entry: ${file}`);
  }
  for (const file of [
    'runtime/desktop-commander-v3/dist/tools/process-lifecycle.js',
    'runtime/desktop-commander-v3/dist/utils/process-output.js',
    'runtime/desktop-commander-v3/dist/config.js',
    'runtime/desktop-commander-v3/dist/version.js',
  ]) {
    assert.ok(requiredPlugin3Files.includes(file), `missing required Plugin3 source entry: ${file}`);
  }
  assert.ok(
    requiredPlugin3Files.includes('runtime/desktop-commander-v3/dist/tools/browser-session.js'),
  );
  assert.deepEqual(
    runtimes.find((runtime) => runtime.name === 'python'),
    {
      name: 'python',
      url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-amd64.zip',
      sha256: '76c3c0384ab3f822486f32450f3a4d20f5d65ad0ec32ee34290971aa0eb817e6',
    },
  );
  const result = await validatePlugin3Tree(plugin3Root);
  assert.ok(result.files >= requiredPlugin3Files.length);
  const serviceSource = await readFile(path.join(plugin3Root, 'src', 'service.mjs'), 'utf8');
  assert.match(serviceSource, /createCodexReader/);
  assert.match(serviceSource, /applyNativePatch/);
  assert.match(serviceSource, /native_patch/);
  assert.match(serviceSource, /run\(process\.env\.PLUGIN3_PYTHON\|\|'python',\['-B','-X','utf8'/);
  assert.doesNotMatch(serviceSource, /run\('python'/);
  const guide = await readFile(
    path.join(plugin3Root, '3', 'skills', 'plugin3-native-work', 'SKILL.md'),
    'utf8',
  );
  assert.match(guide, /workspace_open/);
  assert.doesNotMatch(guide, /C:\\Users\\|Documents[\\/]Codex|Plugin-3/i);
});

test('Plugin3 production scanner rejects developer paths and state payloads', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vibespace-plugin3-negative-'));
  try {
    const relocated = await copyPlugin3(path.join(temp, 'relocated', 'plugin3'));
    await writeFile(path.join(relocated, 'leak.txt'), 'unlisted production file', 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /non-allowlisted path/);

    await rm(path.join(relocated, 'leak.txt'));
    const brokerPath = path.join(relocated, 'src', 'broker-path.mjs');
    const brokerPathSource = await readFile(brokerPath, 'utf8');
    await writeFile(brokerPath, `${brokerPathSource}\nC:\\Users\\viper\\secret.txt\n`, 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /forbidden material/);
    await writeFile(brokerPath, brokerPathSource, 'utf8');

    await writeFile(brokerPath, `${brokerPathSource}\ngithub_pat_fake_1234567890123456\n`, 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /forbidden material/);
    await writeFile(brokerPath, brokerPathSource, 'utf8');

    await mkdir(path.join(relocated, 'state'));
    await writeFile(path.join(relocated, 'state', 'leak.txt'), 'state', 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /forbidden path segment/);
    await rm(path.join(relocated, 'state'), { recursive: true, force: true });

    const dist = path.join(relocated, 'runtime', 'desktop-commander-v3', 'dist');
    await mkdir(path.join(dist, 'logs'));
    await writeFile(path.join(dist, 'logs', 'trace.log'), 'runtime log', 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /forbidden path segment/);
    await rm(path.join(dist, 'logs'), { recursive: true, force: true });

    await writeFile(path.join(dist, 'data', 'unexpected.bin'), Buffer.from([1, 2, 3]));
    await assert.rejects(() => validatePlugin3Tree(relocated), /unexpected extension/);
    await rm(path.join(dist, 'data', 'unexpected.bin'));

    await writeFile(path.join(dist, 'data', 'extra.json'), '{}', 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /unexpected extension/);
    await rm(path.join(dist, 'data', 'extra.json'));

    await writeFile(path.join(dist, 'tunnel.yaml'), 'endpoint: test', 'utf8');
    await assert.rejects(() => validatePlugin3Tree(relocated), /forbidden path segment/);
    await rm(path.join(dist, 'tunnel.yaml'));

    await rm(path.join(relocated, '3', 'skills', 'plugin3-native-work', 'SKILL.md'));
    await assert.rejects(() => validatePlugin3Tree(relocated), /missing/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('gateway launches the staged Plugin3 shared service with isolated state', () => {
  const options = plugin3TransportOptions('C:\\app\\connector', 'C:\\app\\state', {
    ripgrepPath:
      'C:\\app\\connector\\node_modules\\@vscode\\ripgrep-win32-x64\\bin\\rg.exe',
  });
  assert.equal(options.command, process.execPath);
  assert.deepEqual(options.args, [
    'C:\\app\\connector\\plugin3\\runtime\\desktop-commander-v3\\dist\\index.js',
    '--no-onboarding',
    '--shared-service',
  ]);
  assert.equal(options.cwd, 'C:\\app\\connector');
  assert.equal(options.env.PLUGIN3_DATA_DIR, 'C:\\app\\state\\plugin3');
  assert.equal(options.env.PLUGIN3_PYTHON, 'C:\\app\\connector\\runtime\\python\\python.exe');
  assert.ok(options.env.PATH, 'shared service receives the bundled runtime executable search path');
  const runtimePath = options.env.PATH.split(path.delimiter);
  assert.ok(runtimePath.includes('C:\\app\\connector\\runtime\\python'));
  assert.ok(
    runtimePath.includes(
      'C:\\app\\connector\\node_modules\\@vscode\\ripgrep-win32-x64\\bin',
    ),
  );
  assert.equal(options.env.PLUGIN3_SHARED_SERVICE, '1');
  assert.equal(options.env.OPENAI_API_KEY, undefined);
});

test('staged Plugin3 advertises shared-service and browser MCP tools', async () => {
  await mkdir(testStateRoot, { recursive: true });
  const stateDir = await mkdtemp(path.join(testStateRoot, 'vibespace-plugin3-tools-'));
  const transport = new StdioClientTransport({
    command: plugin3Node,
    args: [plugin3Entry, '--no-onboarding', '--shared-service'],
    cwd: packageRoot,
    env: {
      ...cleanEnv(),
      PLUGIN3_DATA_DIR: path.join(stateDir, 'plugin3'),
      PLUGIN3_PYTHON:
        process.env.VIBESPACE_CONNECTOR_TEST_PYTHON ||
        path.join(packageRoot, 'runtime', 'python', 'python.exe'),
      PATH:
        process.env.VIBESPACE_CONNECTOR_TEST_PATH ||
        [
          path.join(packageRoot, 'runtime', 'python'),
          path.join(packageRoot, 'node_modules', '@vscode', 'ripgrep', 'bin'),
          cleanEnv().PATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
      PLUGIN3_SHARED_SERVICE: '1',
      DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1',
    },
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'vibespace-plugin3-packaging-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 30000 });
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of [
      'workspace_open',
      'read_batch',
      'edit_plan',
      'edit_apply',
      'job_start',
      'browser_session',
      'browser_observe',
      'plugin3_guide',
      'native_patch',
      'codex_threads',
      'force_terminate',
    ]) {
      assert.ok(names.has(name), `missing staged Plugin3 tool: ${name}`);
    }
  } finally {
    await client.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('relocated broker path honors caller-provided data directory', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vibespace-plugin3-relocation-'));
  const prior = process.env.PLUGIN3_DATA_DIR;
  try {
    const relocated = await copyPlugin3(path.join(temp, 'plugin3'));
    const dataDir = path.join(temp, 'runtime-data');
    process.env.PLUGIN3_DATA_DIR = dataDir;
    const module = await import(
      `${pathToFileURL(path.join(relocated, 'src', 'broker-path.mjs')).href}?relocation=${Date.now()}`
    );
    assert.equal(module.dataDir, path.resolve(dataDir));
    assert.match(module.endpoint, /plugin3-/i);
  } finally {
    if (prior === undefined) delete process.env.PLUGIN3_DATA_DIR;
    else process.env.PLUGIN3_DATA_DIR = prior;
    await rm(temp, { recursive: true, force: true });
  }
});

test('Plugin3 runtime state follows the connector data directory', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vibespace-plugin3-state-root-'));
  const prior = process.env.PLUGIN3_DATA_DIR;
  try {
    const relocated = await copyPlugin3(path.join(temp, 'plugin3'));
    const dataDir = path.join(temp, 'isolated-state');
    process.env.PLUGIN3_DATA_DIR = dataDir;
    const config = await import(
      `${pathToFileURL(path.join(relocated, 'runtime', 'desktop-commander-v3', 'dist', 'config.js')).href}?state=${Date.now()}`
    );
    assert.equal(path.dirname(config.CONFIG_FILE), path.join(dataDir, 'desktop-commander'));

    const processOutput = await import(
      `${pathToFileURL(path.join(relocated, 'runtime', 'desktop-commander-v3', 'dist', 'utils', 'process-output.js')).href}?state=${Date.now()}`
    );
    const log = new processOutput.ProcessOutputLog({ pid: 41 });
    assert.equal(path.dirname(log.status().path), path.join(dataDir, 'process-output'));
    await log.finish();

    const browser = await import(
      `${pathToFileURL(path.join(plugin3Root, 'runtime', 'desktop-commander-v3', 'dist', 'tools', 'browser-session.js')).href}?state=${Date.now()}`
    );
    assert.equal(browser.browserArtifactsDirectory, path.join(dataDir, 'browser-artifacts'));
  } finally {
    if (prior === undefined) delete process.env.PLUGIN3_DATA_DIR;
    else process.env.PLUGIN3_DATA_DIR = prior;
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  'bundled Python repo helper imports its sibling module',
  { skip: !process.env.VIBESPACE_CONNECTOR_TEST_PYTHON },
  async () => {
    await mkdir(testStateRoot, { recursive: true });
    const temp = await mkdtemp(path.join(testStateRoot, 'plugin3-python-helper-'));
    try {
      const workspace = path.join(temp, 'workspace');
      await mkdir(workspace);
      const manifest = path.join(workspace, 'manifest.json');
      await writeFile(manifest, JSON.stringify({ root: workspace, changes: [] }), 'utf8');
      const helper = path.join(plugin3Root, 'extensions', 'codex-kit', 'broker_repo.py');
      const result = spawnSync(
        process.env.VIBESPACE_CONNECTOR_TEST_PYTHON,
        ['-B', '-X', 'utf8', helper, 'plan', manifest, path.join(temp, 'state')],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /Provide between 1 and 500 changes/u);
      assert.doesNotMatch(result.stderr, /ModuleNotFoundError/u);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test('native and release entry points preflight the connector resource', async () => {
  const appPackage = JSON.parse(await readFile(path.join(repoRoot, 'app', 'package.json'), 'utf8'));
  assert.equal(
    appPackage.scripts['prepare:desktop-connector'],
    'node ../scripts/prepare-desktop-connector.mjs',
  );
  assert.equal(appPackage.scripts['pretauri:dev'], 'npm run prepare:desktop-connector');
  assert.equal(appPackage.scripts['pretauri:dev:cdp'], 'npm run prepare:desktop-connector');
  assert.equal(appPackage.scripts['pretauri:build'], 'npm run prepare:desktop-connector');

  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    rootPackage.scripts['prepare:desktop-connector'],
    'node scripts/prepare-desktop-connector.mjs',
  );

  const releaseWorkflow = await readFile(
    path.join(repoRoot, '.github', 'workflows', 'release.yml'),
    'utf8',
  );
  assert.match(
    releaseWorkflow,
    /- name: Prepare verified Desktop Connector resource\s+run: npm run prepare:desktop-connector/u,
  );
  const packagerSource = await readFile(
    path.join(repoRoot, 'scripts', 'prepare-desktop-connector.mjs'),
    'utf8',
  );
  assert.match(packagerSource, /ZipFile\]::ExtractToDirectory/);
  assert.doesNotMatch(packagerSource, /Expand-Archive/);
});
