import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Rust CI prepares connector resources before Cargo on a clean checkout', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const rust = workflow.split(/\n  rust:\s*\n/u)[1];
  assert.ok(rust, 'Rust CI job exists');
  const setupNode = rust.indexOf('actions/setup-node@');
  const prepare = rust.indexOf('run: npm run prepare:desktop-connector');
  const cargo = rust.indexOf('cargo check --release');
  assert.ok(setupNode >= 0, 'Rust job supplies Node for the resource preparer');
  assert.ok(prepare > setupNode, 'Connector preparation follows Node setup');
  assert.ok(cargo > prepare, 'Cargo starts after resource preparation succeeds');
  const appPackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(
    appPackage.scripts['prepare:desktop-connector'],
    'node scripts/prepare-desktop-connector.mjs',
  );
  assert.equal(
    appPackage.scripts['build:desktop-commander-download'],
    'node scripts/build-desktop-commander-download.mjs',
  );
});

test('Linux preparation creates the real unsupported-platform manifest without a developer runtime', async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'vibespace-connector-linux-ci-'));
  try {
    const script = path.join(fixtureRoot, 'scripts/prepare-desktop-connector.mjs');
    await mkdir(path.dirname(script));
    await cp(path.join(root, 'scripts/prepare-desktop-connector.mjs'), script);
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "Object.defineProperty(process, 'platform', {value: 'linux'}); Object.defineProperty(process, 'arch', {value: 'x64'}); globalThis.fetch = () => { throw new Error('Unsupported platform must not download runtimes'); }; await import((await import('node:url')).pathToFileURL(process.argv[1]).href);",
        script,
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true },
    );
    assert.match(stdout, /unavailable on this platform/u);
    const output = path.join(fixtureRoot, 'app/src-tauri/resources/desktop-connector');
    assert.deepEqual(await readdir(output), ['manifest.json']);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')), {
      version: 1,
      platform: 'linux-x64',
      supported: false,
    });
    const config = JSON.parse(
      await readFile(path.join(root, 'app/src-tauri/tauri.conf.json'), 'utf8'),
    );
    assert.ok(
      config.bundle.resources.includes('resources/desktop-connector/*'),
      'Required resource glob is retained',
    );
    assert.ok(
      config.build.beforeBuildCommand.includes('prepare-desktop-connector.mjs'),
      'Release packaging still prepares the verified Windows runtime',
    );
  } finally {
    // This is the exact fresh directory created by this test, never a user cache.
    const resolved = path.resolve(fixtureRoot);
    const prefix = path.resolve(tmpdir()) + path.sep;
    assert.ok(
      resolved.startsWith(prefix) &&
        path.basename(resolved).startsWith('vibespace-connector-linux-ci-'),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
