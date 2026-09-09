// Build a self-contained Windows resource from locked dependencies and verified runtimes.
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages/vibespace-desktop-commander');
const output = path.join(root, 'app/src-tauri/resources/desktop-connector');
export const runtimes = [
  {
    name: 'node',
    url: 'https://nodejs.org/dist/v24.16.0/node-v24.16.0-win-x64.zip',
    sha256: 'edaca9bd58ec8e92037dac4e877d52f6b8f430b81c18b57e264b4e2fb111cd56',
  },
  {
    name: 'tunnel',
    url: 'https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-windows-amd64.zip',
    sha256: '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5',
  },
];
export const sourceFiles = [
  'package.json',
  'package-lock.json',
  'gateway.mjs',
  'setup-runtime.mjs',
  'config.mjs',
  'mcp.mjs',
  'README.md',
  'setup',
  'upstream/dist',
  'upstream/LICENSE',
  'upstream/package.json',
  'browser/browser.mjs',
  'browser/cli.mjs',
  'browser/tool.mjs',
  'browser/package.json',
  'browser/package-lock.json',
  'browser/UPSTREAM-README.md',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function fingerprint() {
  const digest = createHash('sha256').update(JSON.stringify(runtimes));
  async function visit(relative) {
    const absolute = path.join(source, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      digest.update(relative).update(await readFile(absolute));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw Error('Source symlinks are not supported');
      await visit(path.join(relative, entry.name));
    }
  }
  for (const file of sourceFiles) await visit(file);
  return digest.update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
}
function powershell(script, env) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + script],
    { windowsHide: true, env: { ...process.env, ...env }, stdio: 'inherit' },
  );
}
async function prepare() {
  await mkdir(output, { recursive: true });
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    await writeFile(
      path.join(output, 'manifest.json'),
      JSON.stringify({
        version: 1,
        platform: process.platform + '-' + process.arch,
        supported: false,
      }),
    );
    console.log('Desktop connector is unavailable on this platform; app packaging continues.');
    return;
  }
  const sourceHash = await fingerprint();
  try {
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
    if (
      manifest.sourceHash === sourceHash &&
      manifest.sha256 === hash(await readFile(path.join(output, 'runtime.zip')))
    ) {
      console.log('Desktop connector resource verified (cached).');
      return;
    }
  } catch {}
  const stageRoot = process.env.VIBESPACE_CONNECTOR_BUILD_DIR || tmpdir();
  await mkdir(stageRoot, { recursive: true });
  const work = await mkdtemp(path.join(stageRoot, 'vibespace-connector-'));
  const bundle = path.join(work, 'bundle');
  await mkdir(bundle);
  for (const file of sourceFiles) {
    await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
    await cp(path.join(source, file), path.join(bundle, file), { recursive: true });
  }
  for (const runtime of runtimes) {
    const archive = path.join(work, runtime.name + '.zip');
    console.log('Downloading verified ' + runtime.name + ' runtime…');
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error('Runtime download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== runtime.sha256) throw Error('Runtime integrity check failed');
    await writeFile(archive, bytes);
    powershell('Expand-Archive -LiteralPath $env:VS_ARCHIVE -DestinationPath $env:VS_EXTRACT', {
      VS_ARCHIVE: archive,
      VS_EXTRACT: path.join(work, runtime.name),
    });
  }
  const nodeRoot = path.join(work, 'node/node-v24.16.0-win-x64');
  const runtimeDir = path.join(bundle, 'runtime');
  await cp(path.join(work, 'tunnel'), runtimeDir, { recursive: true });
  await cp(path.join(nodeRoot, 'node.exe'), path.join(runtimeDir, 'node.exe'));
  await cp(path.join(nodeRoot, 'LICENSE'), path.join(runtimeDir, 'NODE-LICENSE'));
  for (const cwd of [bundle, path.join(bundle, 'browser')]) {
    execFileSync(
      path.join(nodeRoot, 'node.exe'),
      [
        path.join(nodeRoot, 'node_modules/npm/bin/npm-cli.js'),
        'ci',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd, windowsHide: true, stdio: 'inherit' },
    );
  }
  // Native dependencies are optional packages; verify the actual Windows binaries resolve.
  execFileSync(
    path.join(runtimeDir, 'node.exe'),
    [
      '-e',
      "require('sharp'); const fs=require('fs'); if(!fs.existsSync(require('@vscode/ripgrep').rgPath))process.exit(1)",
    ],
    { cwd: bundle, windowsHide: true, stdio: 'inherit' },
  );
  await packageBundle(bundle);
  console.log('Desktop connector resource prepared. Staging retained at ' + work);
}

export async function packageBundle(bundle) {
  // Repack completed staging without another install; refuse dependency drift.
  for (const relative of ['package-lock.json', 'browser/package-lock.json']) {
    if (
      hash(await readFile(path.join(bundle, relative))) !==
      hash(await readFile(path.join(source, relative)))
    )
      throw Error('Staging dependencies changed; run a fresh preparation.');
  }
  for (const runtime of runtimes) {
    if (
      hash(await readFile(path.join(path.dirname(bundle), runtime.name + '.zip'))) !==
      runtime.sha256
    )
      throw Error('Staged runtime integrity check failed.');
  }
  for (const file of sourceFiles) {
    await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
    await cp(path.join(source, file), path.join(bundle, file), { recursive: true });
  }
  const sourceHash = await fingerprint();
  const archive = path.join(path.dirname(bundle), 'runtime-' + Date.now() + '.zip');
  powershell(
    "$null=[Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); [IO.Compression.ZipFile]::CreateFromDirectory($env:VS_BUNDLE,$env:VS_ARCHIVE,[IO.Compression.CompressionLevel]::Optimal,$false)",
    { VS_BUNDLE: bundle, VS_ARCHIVE: archive },
  );
  const disk = await statfs(output);
  if (disk.bavail * disk.bsize < (await stat(archive)).size + 16 * 1024 * 1024)
    throw Error('Not enough resource disk space. Verified archive retained in staging.');
  await cp(archive, path.join(output, 'runtime.zip'));
  await writeFile(
    path.join(output, 'manifest.json'),
    JSON.stringify(
      {
        version: 1,
        platform: 'win32-x64',
        sourceHash,
        sha256: hash(await readFile(archive)),
        runtimes,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Connector archive verified and published.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepare();
