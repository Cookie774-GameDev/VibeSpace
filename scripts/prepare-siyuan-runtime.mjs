#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT_DIR = path.join(
  PROJECT_ROOT,
  'app',
  'src-tauri',
  'resources',
  'siyuan-runtime',
);
const DEFAULT_ALLOWED_OUTPUT_PARENT = path.dirname(DEFAULT_OUTPUT_DIR);
const DEFAULT_SOURCE_OFFER = path.join(PROJECT_ROOT, 'docs', 'oss', 'siyuan-source-offer.md');
const DEFAULT_RUNTIME_MANIFEST = path.join(
  PROJECT_ROOT,
  'app',
  'src-tauri',
  'resources',
  'siyuan-runtime-manifest.json',
);
const DEFAULT_CLOSURE_MANIFEST = path.join(
  PROJECT_ROOT,
  'docs',
  'oss',
  'siyuan-runtime-closure.json',
);
const READY_FILE = 'VIBESPACE_SIYUAN_READY.json';

export async function prepareSiyuanRuntime(options = {}) {
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const allowedOutputParent = path.resolve(
    options.allowedOutputParent ?? DEFAULT_ALLOWED_OUTPUT_PARENT,
  );
  assertDirectChild(outputDir, allowedOutputParent, 'SiYuan runtime output');
  await assertPhysicalDirectory(allowedOutputParent);
  await assertPhysicalDirectory(outputDir, true);

  const closurePath = path.resolve(options.closureManifestPath ?? DEFAULT_CLOSURE_MANIFEST);
  const runtimeManifestPath = path.resolve(options.runtimeManifestPath ?? DEFAULT_RUNTIME_MANIFEST);
  const sourceOfferPath = path.resolve(options.sourceOfferPath ?? DEFAULT_SOURCE_OFFER);
  const metadata = Object.freeze({
    'siyuan-runtime-manifest.json': await readFile(runtimeManifestPath, 'utf8'),
    'siyuan-runtime-closure.json': await readFile(closurePath, 'utf8'),
    'VIBESPACE_SIYUAN_SOURCE_OFFER.md': await readFile(sourceOfferPath, 'utf8'),
  });
  const closure = JSON.parse(metadata['siyuan-runtime-closure.json']);
  const runtimeManifest = JSON.parse(metadata['siyuan-runtime-manifest.json']);
  const fingerprint = closureFingerprint(closure);
  const ready = readyMetadata(runtimeManifest, closure, fingerprint);

  if (await reusePreparedOutput(outputDir, closure, ready, metadata)) {
    return { outputDir, reused: true, fingerprint };
  }
  if (await exists(outputDir)) {
    throw new Error(
      `SiYuan runtime output exists but is not the verified closure: ${outputDir}. Remove that exact directory before retrying.`,
    );
  }

  const source = await resolveSourceDirectory({ ...options, closure });
  try {
    await validateExtractedClosure(source.path, closure);
    const stage = path.join(
      allowedOutputParent,
      `.siyuan-runtime-stage-${process.pid}-${randomUUID()}`,
    );
    assertDirectChild(stage, allowedOutputParent, 'SiYuan runtime stage');
    await assertPhysicalDirectory(allowedOutputParent);
    await mkdir(stage, { recursive: false });
    try {
      for (const component of closure.closure.components) {
        const sourcePath = path.join(source.path, component.path);
        const destinationPath = path.join(stage, packagedComponentPath(component.path));
        await cp(sourcePath, destinationPath, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      for (const [name, content] of Object.entries(metadata)) {
        await writeFile(path.join(stage, name), content, { encoding: 'utf8', flag: 'wx' });
      }
      await writeFile(path.join(stage, READY_FILE), serializeJson(ready), {
        encoding: 'utf8',
        flag: 'wx',
      });
      await validatePackagedClosure(stage, closure);
      await assertPhysicalDirectory(allowedOutputParent);
      await assertPhysicalDirectory(outputDir, true);
      await rename(stage, outputDir);
    } catch (error) {
      await safeRemoveOwnedTemporary(stage, allowedOutputParent);
      throw error;
    }
  } finally {
    if (source.temporary) {
      await safeRemoveOwnedTemporary(source.cleanupPath ?? source.path, source.allowedParent);
    }
  }

  return { outputDir, reused: false, fingerprint };
}

export async function validateExtractedClosure(extractedRoot, closure) {
  const root = path.resolve(extractedRoot);
  const totals = await validateComponents(root, closure, (componentPath) => componentPath);
  validateTotals(totals, closure);
  return totals;
}

export async function validatePackagedClosure(packagedRoot, closure) {
  const root = path.resolve(packagedRoot);
  const totals = await validateComponents(root, closure, packagedComponentPath);
  validateTotals(totals, closure);
  return totals;
}

async function validateComponents(root, closure, locate) {
  if (!closure?.closure || !Array.isArray(closure.closure.components)) {
    throw new Error('SiYuan runtime closure manifest is invalid');
  }
  let bytes = 0;
  let files = 0;
  for (const component of closure.closure.components) {
    const componentPath = locate(component.path);
    const measured = await measureTree(root, componentPath, component.path);
    if (
      measured.bytes !== component.bytes ||
      measured.files !== component.files ||
      measured.treeSha256 !== component.treeSha256
    ) {
      throw new Error(`SiYuan runtime component verification failed: ${component.id}`);
    }
    bytes += measured.bytes;
    files += measured.files;
  }
  return { bytes, files };
}

function validateTotals(totals, closure) {
  if (
    totals.bytes !== closure.closure.uncompressedBytes ||
    totals.files !== closure.closure.fileCount
  ) {
    throw new Error('SiYuan runtime closure totals do not match the pinned manifest');
  }
}

export async function measureTree(root, relativePath, digestPath = relativePath) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!isWithin(resolvedRoot, target)) throw new Error('SiYuan component path escaped its root');
  const files = [];
  await collectRegularFiles(target, files);
  files.sort((left, right) => left.localeCompare(right, 'en'));
  let bytes = 0;
  const tree = createHash('sha256');
  for (const file of files) {
    const info = await lstat(file);
    const fileDigest = await sha256File(file);
    const local = path.relative(target, file).split(path.sep).join('/');
    const digestRelativePath = local
      ? `${digestPath.split(path.sep).join('/')}/${local}`
      : digestPath;
    bytes += info.size;
    tree.update(`${digestRelativePath}\0${info.size}\0${fileDigest}\n`);
  }
  return { bytes, files: files.length, treeSha256: tree.digest('hex') };
}

async function collectRegularFiles(target, files) {
  const info = await lstat(target);
  if (info.isSymbolicLink())
    throw new Error(`Symlinks are forbidden in the SiYuan runtime: ${target}`);
  if (info.isFile()) {
    files.push(target);
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported SiYuan runtime entry: ${target}`);
  const entries = await readdir(target, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) await collectRegularFiles(path.join(target, entry.name), files);
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function resolveSourceDirectory(options) {
  const configuredSource = options.sourceDir ?? process.env.VIBESPACE_SIYUAN_SOURCE_DIR;
  if (configuredSource) return { path: path.resolve(configuredSource), temporary: false };

  if (process.platform !== 'win32') {
    throw new Error('The pinned SiYuan payload is currently prepared only for Windows x64');
  }
  const cacheDir = path.resolve(
    options.cacheDir ??
      process.env.VIBESPACE_SIYUAN_CACHE_DIR ??
      path.join(os.tmpdir(), 'vibespace-siyuan-runtime-cache'),
  );
  await mkdir(cacheDir, { recursive: true });
  const installer = path.resolve(
    options.installerPath ??
      process.env.VIBESPACE_SIYUAN_INSTALLER ??
      path.join(cacheDir, options.closure.source.installerName),
  );
  if (!(await exists(installer))) await downloadOfficialInstaller(installer, options.closure);
  await verifyInstaller(installer, options.closure);

  const sevenZip = await locateSevenZip(options.sevenZipPath ?? process.env.VIBESPACE_7Z_PATH);
  const extracted = await mkdtemp(path.join(cacheDir, '.siyuan-extract-'));
  try {
    await execFileAsync(sevenZip, ['x', installer, `-o${extracted}`, '-y'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    // The pinned closure describes app-64.7z, not the surrounding NSIS files.
    // Use a separate application root so loose envelope assets cannot alter it.
    const pluginDir = path.join(extracted, '$PLUGINSDIR');
    const payload = path.join(pluginDir, 'app-64.7z');
    let pluginInfo;
    let payloadInfo;
    try {
      pluginInfo = await lstat(pluginDir);
      payloadInfo = await lstat(payload);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          'SiYuan installer nested application archive is missing: $PLUGINSDIR/app-64.7z',
        );
      }
      throw error;
    }
    if (
      pluginInfo.isSymbolicLink() ||
      !pluginInfo.isDirectory() ||
      payloadInfo.isSymbolicLink() ||
      !payloadInfo.isFile()
    ) {
      throw new Error('SiYuan installer nested application archive must be a regular file');
    }
    const application = path.join(extracted, 'application');
    await execFileAsync(sevenZip, ['x', '-t7z', payload, `-o${application}`, '-y'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { path: application, temporary: true, cleanupPath: extracted, allowedParent: cacheDir };
  } catch (error) {
    await safeRemoveOwnedTemporary(extracted, cacheDir);
    throw error;
  }
}

async function downloadOfficialInstaller(installer, closure) {
  const url = `https://github.com/siyuan-note/siyuan/releases/download/${closure.source.tag}/${closure.source.installerName}`;
  const partial = `${installer}.partial-${process.pid}-${randomUUID()}`;
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`SiYuan installer download failed: HTTP ${response.status}`);
  try {
    await pipeline(response.body, createWriteStream(partial, { flags: 'wx' }));
    await verifyInstaller(partial, closure);
    await rename(partial, installer);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function verifyInstaller(installer, closure) {
  const info = await lstat(installer);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== closure.source.installerBytes) {
    throw new Error('SiYuan installer size or file type does not match the pinned release');
  }
  if ((await sha256File(installer)) !== closure.source.installerSha256) {
    throw new Error('SiYuan installer SHA-256 does not match the pinned release');
  }
}

async function locateSevenZip(configured) {
  const candidates = [
    configured,
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await exists(candidate)) return path.resolve(candidate);
  }
  throw new Error(
    '7-Zip is required to extract the verified official SiYuan installer; set VIBESPACE_7Z_PATH',
  );
}

async function reusePreparedOutput(outputDir, closure, ready, metadata) {
  if (!(await exists(outputDir))) return false;
  const outputIdentity = await assertPhysicalDirectory(outputDir);
  try {
    const observedReady = JSON.parse(await readFile(path.join(outputDir, READY_FILE), 'utf8'));
    await assertDirectoryIdentity(outputDir, outputIdentity);
    if (
      Object.keys(observedReady).sort().join('\0') !== Object.keys(ready).sort().join('\0') ||
      Object.entries(ready).some(([key, value]) => observedReady[key] !== value)
    ) {
      return false;
    }
    await validatePackagedClosure(outputDir, closure);
    await assertDirectoryIdentity(outputDir, outputIdentity);
    await refreshPreparedMetadata(
      outputDir,
      {
        ...metadata,
        [READY_FILE]: serializeJson(ready),
      },
      outputIdentity,
    );
    await assertDirectoryIdentity(outputDir, outputIdentity);
    return true;
  } catch {
    // A replaced or removed output is not permission to rebuild a new directory.
    await assertDirectoryIdentity(outputDir, outputIdentity);
    return false;
  }
}

function readyMetadata(runtimeManifest, closure, fingerprint) {
  return Object.freeze({
    schemaVersion: 1,
    tag: runtimeManifest.runtime.tag,
    commitSha: runtimeManifest.runtime.commitSha,
    fingerprint,
    uncompressedBytes: closure.closure.uncompressedBytes,
    fileCount: closure.closure.fileCount,
  });
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function refreshPreparedMetadata(outputDir, metadata, outputIdentity) {
  for (const [name, expected] of Object.entries(metadata)) {
    const target = path.join(outputDir, name);
    let observed;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`SiYuan prepared metadata is not a regular file: ${name}`);
      }
      observed = await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    // Metadata reads can yield after closure verification; recheck the verified
    // directory before publication, including when all metadata already matches.
    await assertDirectoryIdentity(outputDir, outputIdentity);
    if (observed === expected) continue;
    const temporary = path.join(outputDir, `.siyuan-metadata-${randomUUID()}`);
    let published = false;
    try {
      await writeFile(temporary, expected, { encoding: 'utf8', flag: 'wx' });
      await assertDirectoryIdentity(outputDir, outputIdentity);
      await rename(temporary, target);
      published = true;
    } finally {
      if (!published) {
        // Retain ambiguous temporary files rather than delete through a replaced path.
        await assertDirectoryIdentity(outputDir, outputIdentity);
        await rm(temporary, { force: true });
      }
    }
  }
}

function closureFingerprint(closure) {
  return createHash('sha256')
    .update(JSON.stringify({ source: closure.source, closure: closure.closure }))
    .digest('hex');
}

function packagedComponentPath(componentPath) {
  return componentPath.startsWith('resources/')
    ? componentPath.slice('resources/'.length)
    : componentPath;
}

function assertDirectChild(target, parent, label) {
  if (path.dirname(target) !== parent || target === parent) {
    throw new Error(`${label} must be one exact direct child of ${parent}`);
  }
}

async function assertPhysicalDirectory(target, allowMissing = false) {
  let info;
  try {
    // lstat observes dangling links and Windows junctions instead of following them.
    info = await lstat(target, { bigint: true });
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return;
    throw error;
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    path.relative(target, await realpath(target)) !== ''
  ) {
    throw new Error(
      `SiYuan path must be a physical directory without symlinks or junctions: ${target}`,
    );
  }
  return info;
}

async function assertDirectoryIdentity(target, expected) {
  const observed = await assertPhysicalDirectory(target);
  if (observed.dev !== expected.dev || observed.ino !== expected.ino) {
    throw new Error(`SiYuan prepared directory identity changed: ${target}`);
  }
  // This is a boundary check, not an OS handle-relative/no-reparse operation.
  // A concurrent external replacement between this check and IO remains possible.
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function safeRemoveOwnedTemporary(target, allowedParent) {
  const resolved = path.resolve(target);
  const parent = path.resolve(allowedParent);
  assertDirectChild(resolved, parent, 'Temporary SiYuan path');
  if (!path.basename(resolved).startsWith('.siyuan-')) {
    throw new Error(`Refusing to remove an unowned temporary path: ${resolved}`);
  }
  // Do not redirect cleanup through a replaced parent or an unowned directory link.
  await assertPhysicalDirectory(parent);
  await assertPhysicalDirectory(resolved, true);
  await rm(resolved, { recursive: true, force: true });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length;) {
    const key = argv[index];
    if (key === '--if-windows') {
      options.ifWindows = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value)
      throw new Error('SiYuan prepare arguments must be --name value pairs');
    const property = {
      '--source-dir': 'sourceDir',
      '--installer': 'installerPath',
      '--seven-zip': 'sevenZipPath',
      '--cache-dir': 'cacheDir',
      '--output-dir': 'outputDir',
    }[key];
    if (!property) throw new Error(`Unknown SiYuan prepare argument: ${key}`);
    options[property] = value;
    index += 2;
  }
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.ifWindows && process.platform !== 'win32') {
      console.log(
        `SiYuan runtime preparation skipped on ${process.platform}; the pinned payload is Windows-only`,
      );
      process.exit(0);
    }
    delete options.ifWindows;
    const result = await prepareSiyuanRuntime(options);
    console.log(
      `SiYuan runtime ${result.reused ? 'verified and reused' : 'verified and prepared'}: ${result.outputDir}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
