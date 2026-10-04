import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages/vibespace-desktop-commander');
const defaultOutput = path.join(
  root,
  'app/public/browser-agent-setup/vibespace-desktop-commander.zip',
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function powershell(script, env) {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', '$ErrorActionPreference="Stop"; ' + script],
    { windowsHide: true, env: { ...process.env, ...env }, stdio: 'inherit' },
  );
}

async function copyTree(sourcePath, destinationPath, relative, copied) {
  const entry = await lstat(sourcePath);
  if (entry.isSymbolicLink()) throw Error('Download source contains a symlink: ' + relative);
  if (entry.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    for (const child of (await readdir(sourcePath)).sort((a, b) => a.localeCompare(b))) {
      await copyTree(
        path.join(sourcePath, child),
        path.join(destinationPath, child),
        path.join(relative, child),
        copied,
      );
    }
    return;
  }
  if (!entry.isFile()) throw Error('Download source is not a regular file: ' + relative);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath);
  copied.push(relative.split(path.sep).join('/'));
}

async function archiveEntries(archive) {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
        '$zip=[IO.Compression.ZipFile]::OpenRead($env:VS_ARCHIVE); try { ' +
        "ConvertTo-Json -InputObject @($zip.Entries | Where-Object { !$_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName }) -Compress " +
        '} finally { $zip.Dispose() }',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, VS_ARCHIVE: archive },
    },
  );
  return JSON.parse(output).map((entry) => entry.replaceAll('\\', '/')).sort();
}

export async function buildDesktopCommanderDownload({
  output = process.env.VIBESPACE_CONNECTOR_DOWNLOAD_OUTPUT || defaultOutput,
  stagingRoot = process.env.VIBESPACE_CONNECTOR_BUILD_DIR || tmpdir(),
  packageFiles,
  validatePlugin3Tree,
} = {}) {
  if (process.platform !== 'win32')
    throw Error('The downloadable source ZIP builder requires Windows PowerShell.');
  if (!Array.isArray(packageFiles) || typeof validatePlugin3Tree !== 'function')
    throw Error('The ZIP builder requires the verified connector source allowlist.');
  const sourcePlugin3 = path.join(source, 'plugin3');
  await validatePlugin3Tree(sourcePlugin3);
  await mkdir(stagingRoot, { recursive: true });
  const work = await mkdtemp(path.join(stagingRoot, 'vibespace-download-'));
  try {
    const bundle = path.join(work, 'bundle');
    await mkdir(bundle);
    const copied = [];
    for (const file of packageFiles) {
      await copyTree(path.join(source, file), path.join(bundle, file), file, copied);
    }
    await validatePlugin3Tree(path.join(bundle, 'plugin3'));
    const expectedEntries = copied.sort();
    const archive = path.join(work, 'vibespace-desktop-commander.zip');
    powershell(
      "$null=[Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); " +
        '[IO.Compression.ZipFile]::CreateFromDirectory($env:VS_BUNDLE,$env:VS_ARCHIVE,[IO.Compression.CompressionLevel]::Optimal,$false)',
      { VS_BUNDLE: bundle, VS_ARCHIVE: archive },
    );
    const actualEntries = await archiveEntries(archive);
    if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries))
      throw Error('Download ZIP entries differ from the selected package source files.');

    const archiveBytes = await readFile(archive);
    const outputPath = path.resolve(output);
    const outputDirectory = path.dirname(outputPath);
    await mkdir(outputDirectory, { recursive: true });
    const publishDir = await mkdtemp(path.join(outputDirectory, '.vibespace-download-'));
    try {
      const publishFile = path.join(publishDir, path.basename(outputPath));
      await cp(archive, publishFile);
      if (sha256(await readFile(publishFile)) !== sha256(archiveBytes))
        throw Error('Download ZIP changed while publishing.');
      await rename(publishFile, outputPath);
    } finally {
      await rm(publishDir, { recursive: true, force: true });
    }
    if ((await stat(outputPath)).size !== archiveBytes.length)
      throw Error('Published download ZIP size differs from its verified archive.');
    return { output: outputPath, sha256: sha256(archiveBytes), files: actualEntries.length };
  } catch (error) {
    throw new Error(`${error.message} (staging retained at ${work})`, { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { sourceFiles: packageFiles, validatePlugin3Tree } = await import(
    './prepare-desktop-connector.mjs'
  );
  const result = await buildDesktopCommanderDownload({ packageFiles, validatePlugin3Tree });
  console.log(
    `Desktop Commander download published: ${result.output} (${result.files} files, SHA-256 ${result.sha256}).`,
  );
}
