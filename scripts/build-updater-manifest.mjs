#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_SIGNATURE_BYTES = 16 * 1024;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const MAX_SEMVER_CORE_NUMBER = 18_446_744_073_709_551_615n;

export async function buildUpdaterManifest(options, hooks = {}) {
  const version = validateVersion(required(options.version, '--version'));
  const requestedAssetsDir = path.resolve(required(options.assetsDir, '--assets-dir'));
  const assets = await bindDirectory(requestedAssetsDir, 'Assets directory');
  const baseUrl = validateBaseUrl(required(options.baseUrl, '--base-url'));
  const notes = options.notes ?? `VibeSpace ${version}`;
  const pubDate = validatePublicationDate(options.pubDate);
  const bindings = [];
  const outfile = await validateOutfile(
    path.resolve(options.outfile ?? path.join(assets.path, 'latest.json')),
    assets,
  );

  try {
    const entries = (await readdir(assets.path, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    );
    const entriesByName = new Map(entries.map((entry) => [entry.name, entry]));
    const platforms = {};

    for (const { names, platform } of platformArtifactNames(version)) {
      const artifactName = selectArtifact(platform, names, entriesByName);
      if (artifactName) {
        platforms[platform] = await platformEntry(platform, artifactName, entriesByName, {
          assetsDir: assets.path,
          baseUrl,
          bindings,
          hooks,
        });
      }
    }

    if (Object.keys(platforms).length === 0) {
      throw new Error('No signed updater artifacts found');
    }

    const manifest = {
      version,
      notes,
      pub_date: pubDate,
      platforms,
    };

    await writeManifestAtomically(
      outfile,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { assets, bindings },
      hooks,
    );
    return { manifest, outfile: outfile.path };
  } finally {
    await Promise.allSettled([
      ...bindings.map((binding) => binding.handle.close()),
      outfile.existingBinding?.handle.close(),
    ]);
  }
}

async function runCli(argv) {
  const args = parseArgs(argv);
  const result = await buildUpdaterManifest({
    assetsDir: args.assetsDir ?? args['assets-dir'],
    baseUrl: args.baseUrl ?? args['base-url'],
    notes: args.notes,
    outfile: args.outfile,
    pubDate: args.pubDate ?? args['pub-date'],
    version: args.version,
  });
  console.log(`Wrote updater manifest: ${result.outfile}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await runCli(process.argv.slice(2));
}

function platformArtifactNames(releaseVersion) {
  return [
    {
      platform: 'windows-x86_64',
      names: [
        `VibeSpace-${releaseVersion}-Windows-x64.exe`,
        `VibeSpace_${releaseVersion}_x64-setup.exe`,
        `Jarvis-One-${releaseVersion}-Windows-x64.exe`,
        `Jarvis One_${releaseVersion}_x64-setup.exe`,
      ],
    },
    {
      platform: 'darwin-aarch64',
      names: [
        'VibeSpace_aarch64.app.tar.gz',
        'VibeSpace_arm64.app.tar.gz',
        `VibeSpace_${releaseVersion}_aarch64.app.tar.gz`,
        `VibeSpace_${releaseVersion}_arm64.app.tar.gz`,
        `Jarvis One_${releaseVersion}_aarch64.app.tar.gz`,
        `Jarvis One_${releaseVersion}_arm64.app.tar.gz`,
        `Jarvis.One_${releaseVersion}_aarch64.app.tar.gz`,
        `VibeSpace-${releaseVersion}-macOS-aarch64.app.tar.gz`,
        `VibeSpace-${releaseVersion}-macOS-aarch64.tar.gz`,
        `Jarvis-One-${releaseVersion}-macOS-aarch64.app.tar.gz`,
        `Jarvis-One-${releaseVersion}-macOS-aarch64.tar.gz`,
      ],
    },
    {
      platform: 'darwin-x86_64',
      names: [
        'VibeSpace_x64.app.tar.gz',
        'VibeSpace_x86_64.app.tar.gz',
        `VibeSpace_${releaseVersion}_x64.app.tar.gz`,
        `VibeSpace_${releaseVersion}_x86_64.app.tar.gz`,
        `Jarvis One_${releaseVersion}_x64.app.tar.gz`,
        `Jarvis One_${releaseVersion}_x86_64.app.tar.gz`,
        `Jarvis.One_${releaseVersion}_x64.app.tar.gz`,
        `VibeSpace-${releaseVersion}-macOS-x86_64.app.tar.gz`,
        `VibeSpace-${releaseVersion}-macOS-x86_64.tar.gz`,
        `Jarvis-One-${releaseVersion}-macOS-x86_64.app.tar.gz`,
        `Jarvis-One-${releaseVersion}-macOS-x86_64.tar.gz`,
      ],
    },
    {
      platform: 'linux-x86_64',
      names: [
        `VibeSpace_${releaseVersion}_amd64.AppImage`,
        `VibeSpace_${releaseVersion}_x86_64.AppImage`,
        `Jarvis One_${releaseVersion}_amd64.AppImage`,
        `Jarvis One_${releaseVersion}_x86_64.AppImage`,
        `Jarvis_${releaseVersion}_amd64.AppImage`,
        `jarvis_${releaseVersion}_amd64.AppImage`,
        `VibeSpace-${releaseVersion}-Linux-x86_64.AppImage`,
        `VibeSpace-${releaseVersion}-Linux-amd64.AppImage`,
        `Jarvis-One-${releaseVersion}-Linux-x86_64.AppImage`,
        `Jarvis-One-${releaseVersion}-Linux-amd64.AppImage`,
      ],
    },
  ];
}

function selectArtifact(platform, supportedNames, entriesByName) {
  const matches = supportedNames.filter((name) => entriesByName.has(name)).sort();
  if (matches.length > 1) {
    throw new Error(`Ambiguous ${platform} artifacts: ${matches.join(', ')}`);
  }
  if (matches.length === 0) return undefined;

  const artifactName = matches[0];
  const entry = entriesByName.get(artifactName);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${platform} artifact must be a regular file: ${artifactName}`);
  }
  return artifactName;
}

async function platformEntry(platform, artifactName, entriesByName, context) {
  const signatureName = `${artifactName}.sig`;
  const signatureEntry = entriesByName.get(signatureName);
  if (!signatureEntry) {
    throw new Error(`Missing signature for ${artifactName}: expected ${signatureName}`);
  }
  if (!signatureEntry.isFile() || signatureEntry.isSymbolicLink()) {
    throw new Error(`Signature must be a regular file: ${signatureName}`);
  }

  const artifactPath = path.join(context.assetsDir, artifactName);
  const signaturePath = path.join(context.assetsDir, signatureName);
  const artifact = await bindRegularFile(artifactPath, `${platform} artifact`);
  context.bindings.push(artifact);
  const signatureFile = await bindRegularFile(signaturePath, 'Signature');
  context.bindings.push(signatureFile);
  if (signatureFile.snapshot.size > BigInt(MAX_SIGNATURE_BYTES)) {
    throw new Error(`Signature exceeds ${MAX_SIGNATURE_BYTES} bytes: ${signatureName}`);
  }

  const signature = (await signatureFile.handle.readFile('utf8')).trim();
  await context.hooks.afterSignatureRead?.({
    artifactPath,
    platform,
    signaturePath,
  });
  await revalidateFileBinding(artifact);
  await revalidateFileBinding(signatureFile);
  if (signature.length === 0) {
    throw new Error(`Signature must be nonempty: ${signatureName}`);
  }
  // This validates only the serialized Tauri/Minisign record structure. It
  // does not cryptographically verify the signature against a configured key;
  // the Tauri client remains the cryptographic verification boundary.
  validateUpdaterSignature(signature, signatureName);

  return {
    signature,
    url: `${context.baseUrl}/${encodeURIComponent(artifactName)}`,
  };
}

function validateUpdaterSignature(value, signatureName) {
  const encodedRecord = decodeCanonicalBase64(value);
  if (!encodedRecord) {
    throw invalidUpdaterSignature(signatureName);
  }

  const record = encodedRecord.toString('utf8');
  if (!Buffer.from(record, 'utf8').equals(encodedRecord)) {
    throw invalidUpdaterSignature(signatureName);
  }

  const lines = record.replace(/\r\n/gu, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (
    lines.length !== 4 ||
    !lines[0].startsWith('untrusted comment: ') ||
    !lines[2].startsWith('trusted comment: ')
  ) {
    throw invalidUpdaterSignature(signatureName);
  }

  const artifactSignature = decodeCanonicalBase64(lines[1]);
  const globalSignature = decodeCanonicalBase64(lines[3]);
  const supportedAlgorithm =
    artifactSignature?.[0] === 0x45 &&
    (artifactSignature[1] === 0x64 || artifactSignature[1] === 0x44);
  if (artifactSignature?.length !== 74 || globalSignature?.length !== 64 || !supportedAlgorithm) {
    throw invalidUpdaterSignature(signatureName);
  }
}

function decodeCanonicalBase64(value) {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[0-9A-Za-z+/]*={0,2}$/u.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : undefined;
}

function invalidUpdaterSignature(signatureName) {
  return new Error(`Signature is not a valid Tauri updater signature: ${signatureName}`);
}

async function bindDirectory(value, label) {
  const requestedPath = path.resolve(value);
  const requestedChain = await bindPathChain(requestedPath, label);
  const metadata = await lstat(value, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory`);
  }
  const resolved = await realpath(value);
  const resolvedMetadata = await lstat(resolved, { bigint: true });
  if (
    !resolvedMetadata.isDirectory() ||
    resolvedMetadata.isSymbolicLink() ||
    !sameFileIdentity(metadata, resolvedMetadata)
  ) {
    throw new Error(`${label} identity changed during validation`);
  }
  return {
    label,
    path: resolved,
    requestedChain,
    requestedPath,
    realpath: resolved,
    snapshot: metadataSnapshot(resolvedMetadata),
  };
}

async function bindPathChain(value, label) {
  const parsed = path.parse(value);
  const parts = value.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const chain = [];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current, { bigint: true });
    chain.push({
      path: current,
      realpath: await realpath(current),
      snapshot: metadataSnapshot(metadata),
    });
  }
  if (chain.length === 0) throw new Error(`${label} path chain must not be empty`);
  return chain;
}

async function bindRegularFile(value, label, allowedLinkCounts = [1n]) {
  const before = await lstat(value, { bigint: true });
  validateRegularFileMetadata(before, label, allowedLinkCounts);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(value, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    validateRegularFileMetadata(opened, label, allowedLinkCounts);
    if (!sameMetadataSnapshot(metadataSnapshot(before), metadataSnapshot(opened))) {
      throw new Error(`${label} identity changed while opening: ${path.basename(value)}`);
    }
    return {
      handle,
      label,
      path: value,
      sha256: await hashFileHandle(handle, opened.size),
      snapshot: metadataSnapshot(opened),
      allowedLinkCounts,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function hashFileHandle(handle, size) {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Updater artifact is too large to hash safely');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  const length = Number(size);
  while (position < length) {
    const bytesToRead = Math.min(buffer.length, length - position);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
    if (bytesRead === 0) throw new Error('Updater file ended while hashing');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

async function copyBoundFileToNewPath(binding, destination, label) {
  await revalidateFileBinding(binding);
  const destinationHandle = await open(destination, 'wx', 0o600);
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    const length = Number(binding.snapshot.size);
    while (position < length) {
      const bytesToRead = Math.min(buffer.length, length - position);
      const { bytesRead } = await binding.handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) throw new Error(`${label} source ended while copying`);
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
  } finally {
    await destinationHandle.close();
  }
  const copy = await bindRegularFile(destination, label);
  if (copy.sha256 !== binding.sha256) {
    await copy.handle.close();
    throw new Error(`${label} byte content changed during copy`);
  }
  return copy;
}

function validateRegularFileMetadata(metadata, label, allowedLinkCounts = [1n]) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (!allowedLinkCounts.includes(metadata.nlink)) {
    throw new Error(`${label} must not be multiply linked`);
  }
}

function metadataSnapshot(metadata) {
  return {
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameMetadataSnapshot(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function revalidateFileBinding(binding) {
  const opened = await binding.handle.stat({ bigint: true });
  const current = await lstat(binding.path, { bigint: true });
  validateRegularFileMetadata(opened, binding.label, binding.allowedLinkCounts);
  validateRegularFileMetadata(current, binding.label, binding.allowedLinkCounts);
  const sha256 = await hashFileHandle(binding.handle, opened.size);
  if (sha256 !== binding.sha256) {
    throw new Error(`${binding.label} byte content changed during manifest generation`);
  }
  if (
    !sameMetadataSnapshot(binding.snapshot, metadataSnapshot(opened)) ||
    !sameMetadataSnapshot(binding.snapshot, metadataSnapshot(current))
  ) {
    throw new Error(`${binding.label} identity or metadata changed during manifest generation`);
  }
}

async function revalidateBindingAtPath(binding, value, label, allowedLinkCounts = [1n, 2n]) {
  const opened = await binding.handle.stat({ bigint: true });
  const current = await lstat(value, { bigint: true });
  validateRegularFileMetadata(opened, label, allowedLinkCounts);
  validateRegularFileMetadata(current, label, allowedLinkCounts);
  if (
    !sameFileIdentity(binding.snapshot, metadataSnapshot(opened)) ||
    !sameFileIdentity(binding.snapshot, metadataSnapshot(current))
  ) {
    throw new Error(`${label} identity changed at the final publication boundary`);
  }
  if ((await hashFileHandle(binding.handle, opened.size)) !== binding.sha256) {
    throw new Error(`${label} byte content changed at the final publication boundary`);
  }
}

async function unlinkOwnedPath(binding) {
  try {
    await revalidateBindingAtPath(binding, binding.path, binding.label);
    await unlink(binding.path);
    return true;
  } catch {
    return false;
  }
}

async function revalidateOwnedTwoLinkPublication(binding, targetPath) {
  await revalidateBindingAtPath(binding, binding.path, binding.label, [2n]);
  await revalidateBindingAtPath(binding, targetPath, 'Published manifest', [2n]);
}

async function revalidateDirectory(binding, expected = binding.snapshot) {
  await revalidatePathChain(binding, expected);
  const currentRealpath = await realpath(binding.path);
  const current = await lstat(binding.path, { bigint: true });
  if (
    currentRealpath !== binding.realpath ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameMetadataSnapshot(expected, metadataSnapshot(current))
  ) {
    throw new Error(`${binding.label} identity or metadata changed during manifest generation`);
  }
}

async function revalidateDirectoryIdentity(binding) {
  await revalidatePathChainIdentity(binding);
  const currentRealpath = await realpath(binding.path);
  const current = await lstat(binding.path, { bigint: true });
  if (
    currentRealpath !== binding.realpath ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(binding.snapshot, metadataSnapshot(current))
  ) {
    throw new Error(`${binding.label} identity changed during manifest generation`);
  }
}

async function revalidatePathChainIdentity(binding) {
  for (const entry of binding.requestedChain) {
    const current = await lstat(entry.path, { bigint: true });
    if (
      (await realpath(entry.path)) !== entry.realpath ||
      !sameFileIdentity(entry.snapshot, metadataSnapshot(current))
    ) {
      throw new Error(`${binding.label} path chain identity changed during manifest generation`);
    }
  }
}

async function revalidatePathChain(binding, expectedLeaf) {
  for (const entry of binding.requestedChain) {
    const current = await lstat(entry.path, { bigint: true });
    const currentRealpath = await realpath(entry.path);
    const isLeaf = entry.path === binding.requestedPath;
    const expected = isLeaf ? expectedLeaf : entry.snapshot;
    if (
      currentRealpath !== entry.realpath ||
      (isLeaf
        ? !sameMetadataSnapshot(expected, metadataSnapshot(current))
        : !sameFileIdentity(expected, metadataSnapshot(current)))
    ) {
      throw new Error(`${binding.label} path chain identity changed during manifest generation`);
    }
  }
}

function validateBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Base URL must be a credential-free HTTPS URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error('Base URL must be a credential-free HTTPS URL');
  }
  return parsed.href.replace(/\/+$/u, '');
}

function journalIdentity(snapshot) {
  return {
    dev: snapshot.dev.toString(),
    ino: snapshot.ino.toString(),
    mode: snapshot.mode.toString(),
  };
}

function isJournalIdentity(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.keys(value).sort().join(',') === 'dev,ino,mode' &&
    /^[0-9]+$/u.test(value.dev ?? '') &&
    /^[0-9]+$/u.test(value.ino ?? '') &&
    /^[0-9]+$/u.test(value.mode ?? '')
  );
}

function matchesJournalIdentity(snapshot, identity) {
  return (
    snapshot.dev.toString() === identity.dev &&
    snapshot.ino.toString() === identity.ino &&
    snapshot.mode.toString() === identity.mode
  );
}

function assertJournalBoundFile(binding, sha256, identity, label) {
  if (
    binding.sha256 !== sha256 ||
    !isJournalIdentity(identity) ||
    !matchesJournalIdentity(binding.snapshot, identity)
  ) {
    throw new Error(`${label} bytes or identity do not match the publication journal`);
  }
}

async function recoverPublicationResidue(outfilePath, parent) {
  const basename = path.basename(outfilePath);
  const escapedBasename = basename.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const journalPattern = new RegExp(
    `^\\.${escapedBasename}\\.transaction-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.json$`,
    'iu',
  );
  const backupPattern = new RegExp(`^\\.${escapedBasename}\\.backup-[0-9a-f-]{36}$`, 'iu');
  const displacedPattern = new RegExp(`^\\.${escapedBasename}\\.displaced-[0-9a-f-]{36}$`, 'iu');
  const temporaryPattern = new RegExp(
    `^\\.${escapedBasename}\\.[0-9]+\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`,
    'iu',
  );
  const nextPattern = new RegExp(
    `^\\.${escapedBasename}\\.transaction-[0-9a-f-]{36}\\.json\\.next-[0-9a-f-]{36}$`,
    'iu',
  );
  const entries = await readdir(parent.path, { withFileTypes: true });
  const journalEntries = entries.filter((entry) => journalPattern.test(entry.name));
  const residueEntries = entries.filter(
    (entry) =>
      backupPattern.test(entry.name) ||
      displacedPattern.test(entry.name) ||
      temporaryPattern.test(entry.name) ||
      nextPattern.test(entry.name),
  );
  if (journalEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('Publication journal must be a regular file');
  }
  if (journalEntries.length === 0) {
    if (residueEntries.length > 0) {
      throw new Error('Unresolved updater publication residue exists without a valid journal');
    }
    return;
  }
  if (journalEntries.length !== 1) {
    throw new Error(`Multiple unresolved updater publication journals exist for ${basename}`);
  }

  const journalName = journalEntries[0].name;
  const transactionId = journalPattern.exec(journalName)[1];
  const journalPath = path.join(parent.path, journalName);
  const journalBinding = await bindRegularFile(journalPath, 'Publication journal');
  const residueBindings = [];
  try {
    if (journalBinding.snapshot.size > 16_384n) {
      throw new Error('Publication journal exceeds 16384 bytes');
    }
    let journal;
    try {
      journal = JSON.parse(await journalBinding.handle.readFile('utf8'));
    } catch {
      throw new Error('Publication journal must contain valid JSON');
    }
    if (journal?.schema !== 1 || journal.target !== basename) {
      throw new Error('Publication journal has an unsupported schema or target');
    }
    const expectedBackup = `.${basename}.backup-${transactionId}`;
    const expectedDisplaced = `.${basename}.displaced-${transactionId}`;
    const temporaryName = journal.proposed?.temporary;
    if (
      !/^[0-9a-f]{64}$/u.test(journal.proposed?.sha256 ?? '') ||
      typeof temporaryName !== 'string' ||
      !temporaryPattern.test(temporaryName) ||
      !isJournalIdentity(journal.proposed?.identity)
    ) {
      throw new Error(
        `Publication journal is not a supported ${journal.state}-target recovery record`,
      );
    }
    const priorIsValid =
      journal.prior === null ||
      (journal.prior?.backup === expectedBackup &&
        journal.prior?.displaced === expectedDisplaced &&
        /^[0-9a-f]{64}$/u.test(journal.prior?.sha256 ?? '') &&
        isJournalIdentity(journal.prior?.targetIdentity) &&
        isJournalIdentity(journal.prior?.backupIdentity));
    if (
      !priorIsValid ||
      !['prepared', 'displaced', 'linked', 'committed'].includes(journal.state) ||
      (journal.state === 'displaced' && journal.prior === null)
    ) {
      throw new Error(
        `Publication journal is not a supported ${journal.state}-target recovery record`,
      );
    }

    const allowedResidueNames = new Set([temporaryName]);
    if (journal.prior) {
      allowedResidueNames.add(expectedBackup);
      allowedResidueNames.add(expectedDisplaced);
    }
    if (residueEntries.some((entry) => !allowedResidueNames.has(entry.name))) {
      throw new Error('Publication journal has unbound updater publication residue');
    }

    const bindOptional = async (value, label, allowedLinkCounts = [1n]) => {
      if (!(await optionalLstat(value, { bigint: true }))) return undefined;
      const binding = await bindRegularFile(value, label, allowedLinkCounts);
      residueBindings.push(binding);
      return binding;
    };
    const temporary = await bindOptional(
      path.join(parent.path, temporaryName),
      'Journal-bound temporary manifest',
      [1n, 2n],
    );
    if (temporary) {
      assertJournalBoundFile(
        temporary,
        journal.proposed.sha256,
        journal.proposed.identity,
        'Journal-bound temporary manifest',
      );
    }
    const backup = journal.prior
      ? await bindOptional(path.join(parent.path, expectedBackup), 'Journal-bound prior backup')
      : undefined;
    if (backup) {
      assertJournalBoundFile(
        backup,
        journal.prior.sha256,
        journal.prior.backupIdentity,
        'Journal-bound prior backup',
      );
    }
    const displaced = journal.prior
      ? await bindOptional(
          path.join(parent.path, expectedDisplaced),
          'Journal-bound displaced prior manifest',
        )
      : undefined;
    if (displaced) {
      assertJournalBoundFile(
        displaced,
        journal.prior.sha256,
        journal.prior.targetIdentity,
        'Journal-bound displaced prior manifest',
      );
    }
    const target = await bindOptional(outfilePath, 'Journal-bound canonical manifest', [1n, 2n]);

    const targetIsPrior =
      target &&
      journal.prior &&
      target.sha256 === journal.prior.sha256 &&
      matchesJournalIdentity(target.snapshot, journal.prior.targetIdentity);
    const targetIsProposed =
      target &&
      target.sha256 === journal.proposed.sha256 &&
      matchesJournalIdentity(target.snapshot, journal.proposed.identity);
    if (target && !targetIsPrior && !targetIsProposed) {
      throw new Error('Canonical recovery target is not bound by the publication journal');
    }

    const rollbackPriorTarget =
      (journal.state === 'prepared' || journal.state === 'displaced') &&
      journal.prior &&
      !target &&
      backup &&
      displaced;
    const abortPrepared =
      journal.state === 'prepared' &&
      ((journal.prior === null && !target && !backup && !displaced) ||
        (journal.prior && targetIsPrior && backup && !displaced));
    const admitPrelinkedTarget =
      ((journal.state === 'prepared' && journal.prior === null) || journal.state === 'displaced') &&
      targetIsProposed;
    const admitDurableTarget =
      (journal.state === 'linked' || journal.state === 'committed') && targetIsProposed;
    if (journal.state === 'displaced' && (!journal.prior || !backup || !displaced)) {
      throw new Error('Displaced publication is missing journal-bound rollback residue');
    }
    if (journal.state === 'linked' && journal.prior && (!backup || !displaced)) {
      throw new Error('Linked publication is missing journal-bound rollback residue');
    }
    if (!rollbackPriorTarget && !abortPrepared && !admitPrelinkedTarget && !admitDurableTarget) {
      throw new Error('Publication journal state cannot be recovered safely');
    }

    await revalidateDirectory(parent);
    await revalidateFileBinding(journalBinding);
    if (rollbackPriorTarget) {
      await revalidateFileBinding(backup);
      await revalidateFileBinding(displaced);
      await link(backup.path, outfilePath);
      if (!(await unlinkOwnedPath(backup))) {
        throw new Error('Journal-bound prior backup changed during restoration');
      }
      const restored = await bindRegularFile(outfilePath, 'Recovered prior manifest');
      try {
        assertJournalBoundFile(
          restored,
          journal.prior.sha256,
          journal.prior.backupIdentity,
          'Recovered prior manifest',
        );
      } finally {
        await restored.handle.close();
      }
    }
    if (admitPrelinkedTarget || admitDurableTarget) {
      if (temporary) {
        if (!sameFileIdentity(temporary.snapshot, target.snapshot)) {
          throw new Error('Journal-bound target and temporary identities differ');
        }
        await revalidateFileBinding(temporary);
        await unlink(temporary.path);
      } else if (target.snapshot.nlink !== 1n) {
        throw new Error('Published recovery identity has an unaccounted hard link');
      }
      const admitted = await bindRegularFile(outfilePath, 'Recovered published manifest');
      try {
        assertJournalBoundFile(
          admitted,
          journal.proposed.sha256,
          journal.proposed.identity,
          'Recovered published manifest',
        );
      } finally {
        await admitted.handle.close();
      }
    } else if (temporary) {
      await revalidateFileBinding(temporary);
      await unlink(temporary.path);
    }
    for (const binding of [displaced, backup]) {
      if (binding && (await optionalLstat(binding.path, { bigint: true }))) {
        await revalidateFileBinding(binding);
        await unlink(binding.path);
      }
    }
    await revalidateFileBinding(journalBinding);
    await unlink(journalBinding.path);
  } finally {
    await Promise.allSettled([
      journalBinding.handle.close(),
      ...residueBindings.map((binding) => binding.handle.close()),
    ]);
  }
}

async function validateOutfile(value, artifactRoot) {
  if (path.extname(value).toLowerCase() !== '.json') {
    throw new Error('Outfile must have a .json extension');
  }
  const requestedWithinRequestedRoot = isContainedPath(value, artifactRoot.requestedPath);
  const requestedWithinCanonicalRoot = isContainedPath(value, artifactRoot.path);
  if (!requestedWithinRequestedRoot && !requestedWithinCanonicalRoot) {
    throw new Error('Outfile must be contained within the assets directory');
  }

  const parent = await bindDirectory(path.dirname(value), 'Outfile parent');
  requireContainedPath(parent.path, artifactRoot.path, true);
  const canonicalPath = path.join(parent.path, path.basename(value));
  await recoverPublicationResidue(canonicalPath, parent);
  parent.snapshot = metadataSnapshot(await lstat(parent.path, { bigint: true }));
  if (parent.path === artifactRoot.path) {
    artifactRoot.snapshot = parent.snapshot;
  }
  const existing = await optionalLstat(canonicalPath, { bigint: true });
  if (existing?.isSymbolicLink()) {
    throw new Error('Outfile must not be a symbolic link');
  }
  if (existing && existing.nlink !== 1n) {
    throw new Error('Outfile must not be multiply linked');
  }
  if (existing && !existing.isFile()) {
    throw new Error('Outfile must be a regular file when it already exists');
  }
  const existingBinding = existing ? await bindRegularFile(canonicalPath, 'Outfile') : null;
  return {
    existing: existing ? metadataSnapshot(existing) : null,
    existingBinding,
    parent,
    path: canonicalPath,
    requestedPath: value,
  };
}

function requireContainedPath(value, root, allowRoot = false) {
  if (!isContainedPath(value, root, allowRoot)) {
    throw new Error('Outfile must be contained within the assets directory');
  }
}

function isContainedPath(value, root, allowRoot = false) {
  const relative = path.relative(root, value);
  return !(
    (!allowRoot && relative.length === 0) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

async function optionalLstat(value, options) {
  try {
    return await lstat(value, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function validatePublicationDate(value) {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('--pub-date must be a canonical UTC ISO-8601 timestamp');
  }
  return value;
}

async function revalidateOutfileTarget(outfile) {
  const current = await optionalLstat(outfile.path, { bigint: true });
  if (outfile.existingBinding === null) {
    if (current) throw new Error('Outfile appeared during manifest generation');
    return;
  }
  if (!current) throw new Error('Outfile disappeared during manifest generation');
  await revalidateFileBinding(outfile.existingBinding);
}

async function restoreKnownGoodTarget(outfile, candidates, hooks) {
  await hooks.beforeRestore?.({
    backup: candidates[0]?.path,
  });
  let source;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await revalidateFileBinding(candidate);
      source = candidate;
      break;
    } catch {
      // Try the independently bound prior copy.
    }
  }
  if (!source) {
    throw new Error('Known-good manifest rollback source changed before restoration');
  }
  let conflict;
  if (await optionalLstat(outfile.path, { bigint: true })) {
    conflict = path.join(
      path.dirname(outfile.path),
      `.${path.basename(outfile.path)}.conflict-${randomUUID()}`,
    );
    await rename(outfile.path, conflict);
  }
  await revalidateFileBinding(source);
  await link(source.path, outfile.path);
  await unlinkOwnedPath(source);
  const restored = await bindRegularFile(outfile.path, 'Restored prior manifest');
  try {
    if (restored.sha256 !== source.sha256) {
      throw new Error('Restored prior manifest bytes do not match the held rollback evidence');
    }
  } finally {
    await restored.handle.close();
  }
  return conflict;
}

async function quarantineCanonicalTarget(outfile) {
  if (!(await optionalLstat(outfile.path, { bigint: true }))) return undefined;
  const conflict = path.join(
    path.dirname(outfile.path),
    `.${path.basename(outfile.path)}.conflict-${randomUUID()}`,
  );
  await rename(outfile.path, conflict);
  return conflict;
}

async function writePublicationJournal(journalPath, record, replace = false) {
  const contents = `${JSON.stringify(record)}\n`;
  if (!replace) {
    const handle = await open(journalPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const replacement = `${journalPath}.next-${randomUUID()}`;
  const handle = await open(replacement, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(replacement, journalPath);
}

async function publishManifestNoReplace(
  outfile,
  temporaryBinding,
  inputBindings,
  directoryBindings,
  hooks,
) {
  const directory = path.dirname(outfile.path);
  const basename = path.basename(outfile.path);
  const transactionId = randomUUID();
  const backupPath = path.join(directory, `.${basename}.backup-${transactionId}`);
  const displacedPath = path.join(directory, `.${basename}.displaced-${transactionId}`);
  const journalPath = path.join(directory, `.${basename}.transaction-${transactionId}.json`);
  let backupBinding;
  let displacedBinding;
  let publishedBinding;
  let publicationSucceeded = false;
  let rollbackCompleted = false;
  let preserveCrashResidue = false;
  let retainCommittedJournal = false;
  let journalRecord;
  try {
    if (outfile.existingBinding) {
      backupBinding = await copyBoundFileToNewPath(
        outfile.existingBinding,
        backupPath,
        'Prior manifest backup',
      );
      journalRecord = {
        schema: 1,
        state: 'prepared',
        target: basename,
        prior: {
          backup: path.basename(backupPath),
          backupIdentity: journalIdentity(backupBinding.snapshot),
          displaced: path.basename(displacedPath),
          sha256: backupBinding.sha256,
          targetIdentity: journalIdentity(outfile.existingBinding.snapshot),
        },
        proposed: {
          identity: journalIdentity(temporaryBinding.snapshot),
          sha256: temporaryBinding.sha256,
          temporary: path.basename(temporaryBinding.path),
        },
      };
      await writePublicationJournal(journalPath, journalRecord);
      try {
        await hooks.afterJournalPrepared?.({
          journal: journalPath,
          backup: backupPath,
          outfile: outfile.path,
          temporary: temporaryBinding.path,
        });
      } catch (error) {
        if (error?.simulateCrash === true) preserveCrashResidue = true;
        throw error;
      }
      await revalidateOutfileTarget(outfile);
      await rename(outfile.path, displacedPath);
      try {
        await hooks.afterTargetRenameBeforeJournal?.({
          journal: journalPath,
          backup: backupPath,
          displaced: displacedPath,
        });
      } catch (error) {
        if (error?.simulateCrash === true) preserveCrashResidue = true;
        throw error;
      }
      displacedBinding = await bindRegularFile(displacedPath, 'Displaced prior manifest');
      if (
        displacedBinding.sha256 !== outfile.existingBinding.sha256 ||
        !sameFileIdentity(displacedBinding.snapshot, outfile.existingBinding.snapshot)
      ) {
        await restoreKnownGoodTarget(outfile, [backupBinding], hooks);
        rollbackCompleted = true;
        throw new Error('Outfile changed at the final publication boundary');
      }
      journalRecord.state = 'displaced';
      await writePublicationJournal(journalPath, journalRecord, true);
      try {
        await hooks.afterTargetDisplaced?.({
          journal: journalPath,
          backup: backupPath,
          displaced: displacedPath,
        });
      } catch (error) {
        if (error?.simulateCrash === true) preserveCrashResidue = true;
        throw error;
      }
    } else if (await optionalLstat(outfile.path, { bigint: true })) {
      throw new Error('Outfile appeared at the final publication boundary');
    } else {
      journalRecord = {
        schema: 1,
        state: 'prepared',
        target: basename,
        prior: null,
        proposed: {
          identity: journalIdentity(temporaryBinding.snapshot),
          sha256: temporaryBinding.sha256,
          temporary: path.basename(temporaryBinding.path),
        },
      };
      await writePublicationJournal(journalPath, journalRecord);
      try {
        await hooks.afterJournalPrepared?.({
          journal: journalPath,
          outfile: outfile.path,
          temporary: temporaryBinding.path,
        });
      } catch (error) {
        if (error?.simulateCrash === true) preserveCrashResidue = true;
        throw error;
      }
    }

    const finalDirectorySnapshots = new Map();
    for (const [directoryPath] of directoryBindings) {
      finalDirectorySnapshots.set(
        directoryPath,
        metadataSnapshot(await lstat(directoryPath, { bigint: true })),
      );
    }
    await hooks.beforeFinalPublish?.({
      outfile: outfile.path,
      temporary: temporaryBinding.path,
    });
    if (await optionalLstat(outfile.path, { bigint: true })) {
      if (backupBinding) {
        await restoreKnownGoodTarget(outfile, [backupBinding, displacedBinding], hooks);
        rollbackCompleted = true;
      }
      throw new Error('Target appeared or changed at the final publication boundary');
    }
    for (const [directoryPath, binding] of directoryBindings) {
      await revalidateDirectory(binding, finalDirectorySnapshots.get(directoryPath));
    }
    for (const binding of inputBindings) await revalidateFileBinding(binding);
    await revalidateFileBinding(temporaryBinding);

    try {
      await link(temporaryBinding.path, outfile.path);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (backupBinding) {
        await restoreKnownGoodTarget(outfile, [backupBinding, displacedBinding], hooks);
        rollbackCompleted = true;
      }
      throw new Error('Target appeared or changed at the final publication boundary');
    }
    try {
      await hooks.afterTargetLinkBeforeJournal?.({
        journal: journalPath,
        outfile: outfile.path,
        temporary: temporaryBinding.path,
      });
    } catch (error) {
      if (error?.simulateCrash === true) preserveCrashResidue = true;
      throw error;
    }
    journalRecord.state = 'linked';
    await writePublicationJournal(journalPath, journalRecord, true);
    try {
      await hooks.afterTargetLinked?.({
        journal: journalPath,
        outfile: outfile.path,
        temporary: temporaryBinding.path,
      });
    } catch (error) {
      if (error?.simulateCrash === true) preserveCrashResidue = true;
      throw error;
    }
    try {
      for (const binding of inputBindings) await revalidateFileBinding(binding);
      await hooks.afterPublishLink?.({
        outfile: outfile.path,
        temporary: temporaryBinding.path,
      });
      for (const binding of inputBindings) await revalidateFileBinding(binding);
      for (const [, binding] of directoryBindings) {
        await revalidateDirectoryIdentity(binding);
      }
      await revalidateBindingAtPath(temporaryBinding, outfile.path, 'Published manifest');
      const temporaryRemoved = await unlinkOwnedPath(temporaryBinding);
      const targetAfterCleanup = await lstat(outfile.path, { bigint: true });
      const retainedOwnedTemporary = !temporaryRemoved && targetAfterCleanup.nlink === 2n;
      if (retainedOwnedTemporary) {
        await revalidateOwnedTwoLinkPublication(temporaryBinding, outfile.path);
      }
      publishedBinding = await bindRegularFile(
        outfile.path,
        'Published manifest',
        retainedOwnedTemporary ? [2n] : [1n],
      );
      if (!sameFileIdentity(publishedBinding.snapshot, temporaryBinding.snapshot)) {
        throw new Error('Published manifest identity changed at the final publication boundary');
      }
      if (publishedBinding.sha256 !== temporaryBinding.sha256) {
        throw new Error(
          'Published manifest byte content changed at the final publication boundary',
        );
      }
    } catch (error) {
      if (backupBinding) {
        await restoreKnownGoodTarget(outfile, [backupBinding, displacedBinding], hooks);
        rollbackCompleted = true;
      } else {
        await quarantineCanonicalTarget(outfile);
        rollbackCompleted = true;
      }
      throw error;
    }
    journalRecord.state = 'committed';
    await writePublicationJournal(journalPath, journalRecord, true);
    retainCommittedJournal = publishedBinding.snapshot.nlink === 2n;
    publicationSucceeded = true;

    try {
      await hooks.beforeCleanup?.({
        backup: backupBinding?.path,
        displaced: displacedBinding?.path,
      });
    } catch {
      // Cleanup hooks model non-commit-critical filesystem failures.
    }
    for (const binding of [displacedBinding, backupBinding]) {
      if (binding && (await optionalLstat(binding.path, { bigint: true }))) {
        try {
          await revalidateFileBinding(binding);
          await unlink(binding.path);
        } catch {
          // The verified commit remains authoritative; preserve unsafe residue.
        }
      }
    }
  } catch (error) {
    if (preserveCrashResidue) throw error;
    if (
      !publicationSucceeded &&
      !rollbackCompleted &&
      backupBinding &&
      (await optionalLstat(backupBinding.path, { bigint: true }))
    ) {
      await restoreKnownGoodTarget(outfile, [backupBinding, displacedBinding], hooks);
      rollbackCompleted = true;
    }
    throw error;
  } finally {
    if (!preserveCrashResidue) {
      for (const binding of [displacedBinding, backupBinding]) {
        if (binding && (await optionalLstat(binding.path, { bigint: true }))) {
          try {
            await revalidateFileBinding(binding);
            await unlink(binding.path);
          } catch {
            // Preserve residue whose path no longer matches the bound file.
          }
        }
      }
      if (!retainCommittedJournal) {
        const journalMetadata = await optionalLstat(journalPath, { bigint: true });
        if (journalMetadata?.isFile() && !journalMetadata.isSymbolicLink()) {
          try {
            const journal = await bindRegularFile(journalPath, 'Publication journal');
            try {
              await unlink(journal.path);
            } finally {
              await journal.handle.close();
            }
          } catch {
            // Preserve a journal pathname that no longer matches a regular file.
          }
        }
      }
    }
    await Promise.allSettled([
      backupBinding?.handle.close(),
      displacedBinding?.handle.close(),
      publishedBinding?.handle.close(),
    ]);
  }
}

async function writeManifestAtomically(outfile, contents, context, hooks) {
  const temporary = path.join(
    path.dirname(outfile.path),
    `.${path.basename(outfile.path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryBinding;
  try {
    for (const binding of context.bindings) await revalidateFileBinding(binding);
    await revalidateDirectory(context.assets);
    await revalidateDirectory(outfile.parent);
    await revalidateOutfileTarget(outfile);

    await hooks.beforeTemporaryWrite?.({
      assetsDir: context.assets.path,
      outfile: outfile.path,
      outfileParent: outfile.parent.path,
    });
    for (const binding of context.bindings) await revalidateFileBinding(binding);
    await revalidateDirectory(context.assets);
    await revalidateDirectory(outfile.parent);
    await revalidateOutfileTarget(outfile);

    const temporaryHandle = await open(temporary, 'wx', 0o600);
    try {
      await temporaryHandle.writeFile(contents, 'utf8');
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    temporaryBinding = await bindRegularFile(temporary, 'Temporary manifest');
    const expectedTemporaryHash = createHash('sha256').update(contents, 'utf8').digest('hex');
    if (temporaryBinding.sha256 !== expectedTemporaryHash) {
      throw new Error('Temporary manifest byte content changed during write or readback');
    }

    const directoryBindings = new Map([
      [context.assets.path, context.assets],
      [outfile.parent.path, outfile.parent],
    ]);
    const postTemporarySnapshots = new Map();
    const postTemporaryEntries = new Map();
    for (const [directoryPath] of directoryBindings) {
      postTemporarySnapshots.set(
        directoryPath,
        metadataSnapshot(await lstat(directoryPath, { bigint: true })),
      );
      postTemporaryEntries.set(directoryPath, (await readdir(directoryPath)).sort());
    }

    await hooks.beforePublish?.({
      assetsDir: context.assets.path,
      outfile: outfile.path,
      outfileParent: outfile.parent.path,
      temporary,
    });

    for (const binding of context.bindings) await revalidateFileBinding(binding);
    for (const [directoryPath, binding] of directoryBindings) {
      await revalidateDirectory(binding, postTemporarySnapshots.get(directoryPath));
      const expectedEntries = postTemporaryEntries.get(directoryPath);
      const currentEntries = (await readdir(directoryPath)).sort();
      if (
        currentEntries.length !== expectedEntries.length ||
        currentEntries.some((entry, index) => entry !== expectedEntries[index])
      ) {
        throw new Error(`${binding.label} identity or metadata changed during manifest generation`);
      }
    }
    await revalidateOutfileTarget(outfile);
    await revalidateFileBinding(temporaryBinding);
    await publishManifestNoReplace(
      outfile,
      temporaryBinding,
      context.bindings,
      directoryBindings,
      hooks,
    );
  } finally {
    await temporaryBinding?.handle.close();
    if (temporaryBinding && (await optionalLstat(temporary, { bigint: true }))) {
      await unlinkOwnedPath(temporaryBinding);
    }
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[name] = 'true';
    } else {
      parsed[name] = next;
      index += 1;
    }
  }
  return parsed;
}

function required(value, label) {
  if (!value) throw new Error(`Missing required argument ${label}`);
  return value;
}

function validateVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  if (
    !match ||
    match.slice(1, 4).some((identifier) => BigInt(identifier) > MAX_SEMVER_CORE_NUMBER) ||
    (match[4]
      ?.split('.')
      .some(
        (identifier) => /^\d+$/u.test(identifier) && identifier.length > 1 && identifier[0] === '0',
      ) ??
      false)
  ) {
    throw new Error('--version must be a semantic version');
  }
  return value;
}
