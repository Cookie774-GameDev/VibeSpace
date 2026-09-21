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
    name: 'python',
    url: 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embeddable-amd64.zip',
    sha256: '76c3c0384ab3f822486f32450f3a4d20f5d65ad0ec32ee34290971aa0eb817e6',
  },
  {
    name: 'tunnel',
    url: 'https://github.com/openai/tunnel-client/releases/download/v0.0.14/tunnel-client-v0.0.14-windows-amd64.zip',
    sha256: '784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5',
  },
];
export const plugin3SourceFiles = [
  'src/broker-client.mjs',
  'src/broker-path.mjs',
  'src/broker.mjs',
  'src/contracts.mjs',
  'src/service.mjs',
  'src/shared-file.mjs',
  'src/storage-worker.mjs',
  'src/store.mjs',
  'extensions/codex-kit/broker_repo.py',
  'extensions/codex-kit/repo_ops.py',
  '3/skills/plugin3-native-work/SKILL.md',
  'runtime/desktop-commander-v3/package.json',
  'runtime/desktop-commander-v3/dist',
];
const plugin3SourceDirectories = new Set(['runtime/desktop-commander-v3/dist']);
export const requiredPlugin3Files = [
  'src/broker-client.mjs',
  'src/broker-path.mjs',
  'src/broker.mjs',
  'src/contracts.mjs',
  'src/service.mjs',
  'src/shared-file.mjs',
  'src/storage-worker.mjs',
  'src/store.mjs',
  'extensions/codex-kit/broker_repo.py',
  'extensions/codex-kit/repo_ops.py',
  '3/skills/plugin3-native-work/SKILL.md',
  'runtime/desktop-commander-v3/package.json',
  'runtime/desktop-commander-v3/dist/index.js',
  'runtime/desktop-commander-v3/dist/server.js',
  'runtime/desktop-commander-v3/dist/tools/agent-guide.js',
  'runtime/desktop-commander-v3/dist/tools/browser-session.js',
];
const forbiddenPlugin3Text = [
  /C:\\Users\\/i,
  /C:\/Users\//i,
  /Documents[\\/]Codex/i,
  /Plugin-3/i,
  /\.candidate-state/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/i,
  /\b(?:sk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{24,}/i,
  /\btunnel[_-][a-z0-9-]{12,}\b/i,
];
const forbiddenPlugin3PathSegments = new Set([
  '.git',
  'node_modules',
  'state',
  'work',
  'evidence',
  'logs',
  'profiles',
  'sessions',
  '__pycache__',
  'credentials',
  'secrets',
]);
const forbiddenPlugin3FileNames = new Set(['tunnel.yaml', 'watchdog.json']);
const allowedPlugin3DistExtensions = new Set(['.js', '.d.ts', '.css', '.html']);
const plugin3DistRoot = path.normalize('runtime/desktop-commander-v3/dist');
export const sourceFiles = [
  'package.json',
  'package-lock.json',
  'gateway.mjs',
  'setup-runtime.mjs',
  'supervisor.mjs',
  'startup.mjs',
  'startup.ps1',
  'startup.vbs',
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
  ...plugin3SourceFiles.map((file) => path.join('plugin3', file)),
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function validatePlugin3Tree(pluginRoot) {
  const required = new Set(requiredPlugin3Files.map((entry) => path.normalize(entry)));
  const allowedFiles = new Set(
    plugin3SourceFiles
      .filter((entry) => !plugin3SourceDirectories.has(entry))
      .map((entry) => path.normalize(entry)),
  );
  const allowedDirectories = [...plugin3SourceDirectories].map((entry) => path.normalize(entry));
  const seen = new Set();
  async function visit(relative) {
    const normalized = path.normalize(relative);
    const segments = normalized.split(/[\\/]/);
    const basename = path.basename(normalized).toLowerCase();
    if (
      segments.some((segment) => forbiddenPlugin3PathSegments.has(segment.toLowerCase())) ||
      forbiddenPlugin3FileNames.has(basename) ||
      /\.(?:log|pid)$/i.test(basename)
    )
      throw Error('Plugin3 production tree contains a forbidden path segment: ' + relative);
    const insideAllowedDirectory = allowedDirectories.some(
      (directory) => normalized === directory || normalized.startsWith(directory + path.sep),
    );
    const hasAllowedDescendant = plugin3SourceFiles.some((entry) => {
      const candidate = path.normalize(entry);
      return candidate.startsWith(normalized + path.sep);
    });
    if (
      normalized !== '.' &&
      !insideAllowedDirectory &&
      !allowedFiles.has(normalized) &&
      !hasAllowedDescendant
    )
      throw Error('Plugin3 production tree contains a non-allowlisted path: ' + relative);
    const absolute = path.join(pluginRoot, relative);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (entries) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink())
          throw Error(
            'Plugin3 production tree contains a symlink: ' + path.join(relative, entry.name),
          );
        await visit(path.join(relative, entry.name));
      }
      return;
    }
    const bytes = await readFile(absolute).catch(() => {
      throw Error('Plugin3 production file is unreadable: ' + relative);
    });
    if (!insideAllowedDirectory && !allowedFiles.has(normalized))
      throw Error('Plugin3 production tree contains a non-allowlisted file: ' + relative);
    if (insideAllowedDirectory) {
      const relativeToDist = path.relative(plugin3DistRoot, normalized);
      const lowerRelativeToDist = relativeToDist.toLowerCase();
      const extension = lowerRelativeToDist.endsWith('.d.ts')
        ? '.d.ts'
        : path.extname(lowerRelativeToDist);
      const exactJson =
        path.normalize(lowerRelativeToDist) === path.normalize('data/onboarding-prompts.json');
      if (!exactJson && !allowedPlugin3DistExtensions.has(extension))
        throw Error('Plugin3 production dist contains an unexpected extension: ' + relative);
    }
    if (bytes.includes(0))
      throw Error('Plugin3 production file contains unexpected binary data: ' + relative);
    seen.add(normalized);
    const text = bytes.toString('utf8');
    const match = forbiddenPlugin3Text.find((pattern) => pattern.test(text));
    if (match) throw Error('Plugin3 production file contains forbidden material: ' + relative);
  }
  await visit('.');
  for (const relative of required) {
    if (!seen.has(relative)) throw Error('Plugin3 production file is missing: ' + relative);
  }
  return { files: seen.size };
}
async function copySourceFiles(bundle) {
  for (const file of sourceFiles) {
    await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
    await cp(path.join(source, file), path.join(bundle, file), { recursive: true });
  }
  await validatePlugin3Tree(path.join(bundle, 'plugin3'));
}
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
  await copySourceFiles(bundle);
  for (const runtime of runtimes) {
    const archive = path.join(work, runtime.name + '.zip');
    console.log('Downloading verified ' + runtime.name + ' runtime…');
    const response = await fetch(runtime.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw Error('Runtime download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== runtime.sha256) throw Error('Runtime integrity check failed');
    await writeFile(archive, bytes);
    powershell(
      "$null=[Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); " +
        '[IO.Directory]::CreateDirectory($env:VS_EXTRACT) | Out-Null; ' +
        '[IO.Compression.ZipFile]::ExtractToDirectory($env:VS_ARCHIVE,$env:VS_EXTRACT)',
      {
        VS_ARCHIVE: archive,
        VS_EXTRACT: path.join(work, runtime.name),
      },
    );
  }
  const nodeRoot = path.join(work, 'node/node-v24.16.0-win-x64');
  const runtimeDir = path.join(bundle, 'runtime');
  await cp(path.join(work, 'tunnel'), runtimeDir, { recursive: true });
  await cp(path.join(work, 'python'), path.join(runtimeDir, 'python'), { recursive: true });
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
  execFileSync(
    path.join(runtimeDir, 'python', 'python.exe'),
    ['-c', 'import ast,json,pathlib,sys'],
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
  await copySourceFiles(bundle);
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
