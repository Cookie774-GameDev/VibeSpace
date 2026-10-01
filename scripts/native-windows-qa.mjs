import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NATIVE_QA_CARGO_ARGS = Object.freeze([
  'build',
  '--manifest-path',
  'app/src-tauri/Cargo.toml',
  '--bin',
  'jarvis',
  '--features',
  'jarvis-voice',
  '--locked',
  '-j',
  '1',
]);

export async function runLoggedCommand(command, args, { cwd, logFile, resultFile }) {
  const startedAtUTC = new Date().toISOString();
  const descriptor = openSync(logFile, 'wx');
  let result;
  try {
    result = await new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let spawnError = null;
      child.once('error', (error) => {
        spawnError = { code: error.code, message: error.message };
      });
      child.stdout.on('data', (chunk) => {
        writeSync(descriptor, chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        writeSync(descriptor, chunk);
        process.stderr.write(chunk);
      });
      child.once('close', (code, signal) =>
        resolve({
          command,
          args,
          pid: child.pid,
          code,
          signal,
          spawnError,
          startedAtUTC,
          finishedAtUTC: new Date().toISOString(),
        }),
      );
    });
  } finally {
    closeSync(descriptor);
  }
  await writeFile(resultFile, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  assert.equal(
    result.spawnError,
    null,
    `spawn failed: ${result.spawnError?.code}: ${result.spawnError?.message}`,
  );
  assert.equal(result.signal, null, `Subprocess terminated by ${result.signal}`);
  assert.equal(result.code, 0, `Subprocess exit code ${result.code}: ${command}`);
  return result;
}

export async function inspectBuiltExecutable(executable) {
  const info = await lstat(executable);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size >= 64,
    'Expected a regular PE executable',
  );
  const handle = await open(executable, 'r');
  try {
    const dos = Buffer.alloc(64);
    assert.equal((await handle.read(dos, 0, dos.length, 0)).bytesRead, dos.length);
    assert.equal(dos.toString('ascii', 0, 2), 'MZ', 'Expected a PE executable DOS header');
    const offset = dos.readUInt32LE(60);
    assert.ok(offset >= 64 && offset + 24 <= info.size, 'Invalid PE header location');
    const pe = Buffer.alloc(24);
    assert.equal((await handle.read(pe, 0, pe.length, offset)).bytesRead, pe.length);
    assert.equal(pe.readUInt32LE(0), 0x00004550, 'Expected PE executable signature');
    assert.equal(pe.readUInt16LE(4), 0x8664, 'Expected Windows x86_64 executable');
    const characteristics = pe.readUInt16LE(22);
    assert.ok(
      (characteristics & 2) !== 0 && (characteristics & 0x2000) === 0,
      'Expected an executable image, not a DLL',
    );
    return { executable, bytes: info.size, machine: 'x86_64' };
  } finally {
    await handle.close();
  }
}

function within(root, relative) {
  assert.ok(!path.isAbsolute(relative) && !relative.includes('\\'), 'Use a relative portable path');
  const resolved = path.resolve(root, relative);
  const local = path.relative(root, resolved);
  assert.ok(local && !local.startsWith('..') && !path.isAbsolute(local), 'Path outside root');
  return resolved;
}

export async function sha256(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'Expected a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function walk(root, relative) {
  const directory = within(root, relative);
  assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Resource symlinks are not allowed');
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${relative}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), 'Resource symlinks are not allowed');
    if (entry.isDirectory()) result.push(...(await walk(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error('Unexpected resource file type');
  }
  return result;
}

export async function hashInputs(root, names) {
  const files = [];
  for (const name of [...new Set(names)].sort()) {
    const file = within(root, name);
    files.push({ path: name, bytes: (await lstat(file)).size, sha256: await sha256(file) });
  }
  return {
    files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

export async function stageArtifact(root, target, output, evidence) {
  assert.ok(path.relative(root, output).startsWith(`work${path.sep}`), 'Stage inside owned work');
  try {
    await lstat(output);
    throw new Error('Artifact output already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const connector = path.join(target, 'resources/desktop-connector');
  const manifest = JSON.parse(await readFile(path.join(connector, 'manifest.json'), 'utf8'));
  assert.equal(manifest.platform, 'win32-x64', 'A supported Windows runtime is required');
  assert.equal(await sha256(path.join(connector, 'runtime.zip')), manifest.sha256);
  assert.ok(
    (
      await lstat(path.join(target, 'resources/siyuan-runtime/VIBESPACE_SIYUAN_READY.json'))
    ).isFile(),
  );
  const names = ['jarvis.exe'];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) names.push(entry.name);
  }
  names.push(...(await walk(target, 'resources')), ...(await walk(target, '_up_')));
  const payload = await hashInputs(target, names);
  const inputs = JSON.parse(await readFile(path.join(evidence, 'input-manifest.json'), 'utf8'));
  assert.ok(Array.isArray(inputs.files), 'Frozen input manifest required');
  const inputHashes = new Map(inputs.files.map((file) => [file.path, file.sha256]));
  const payloadNames = new Set(payload.files.map((file) => file.path));
  for (const file of inputs.files) {
    if (/^app\/src-tauri\/resources\/(desktop-connector|siyuan-runtime)\//u.test(file.path)) {
      assert.ok(
        payloadNames.has(file.path.slice('app/src-tauri/'.length)),
        `Missing frozen resource closure: ${file.path}`,
      );
    }
  }
  for (const file of payload.files) {
    if (file.path.startsWith('resources/') || file.path.startsWith('_up_/')) {
      const source = path.posix.normalize(`app/src-tauri/${file.path.replaceAll('_up_', '..')}`);
      assert.equal(
        file.sha256,
        inputHashes.get(source),
        `Resource differs from frozen input: ${source}`,
      );
    }
  }
  const disk = await statfs(path.dirname(output), { bigint: true }).catch(async (error) => {
    if (error.code !== 'ENOENT') throw error;
    return statfs(root, { bigint: true });
  });
  const bytes = payload.files.reduce((sum, file) => sum + BigInt(file.bytes), 0n);
  assert.ok(
    disk.bavail * disk.bsize >= bytes * 2n + 1073741824n,
    'Insufficient stage/upload disk headroom',
  );
  await mkdir(output, { recursive: true });
  for (const file of payload.files) {
    const destination = within(output, `binary/${file.path}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(within(target, file.path), destination, { errorOnExist: true, force: false });
    assert.equal(await sha256(destination), file.sha256, 'Copied payload integrity');
  }
  const evidenceNames = ['input-manifest.json', 'provenance.json', 'dll-dependencies.txt'];
  for (const name of evidenceNames) await cp(path.join(evidence, name), within(output, name));
  const result = {
    files: payload.files.map((file) => ({ ...file, path: `binary/${file.path}` })),
    evidenceFiles: (await hashInputs(output, evidenceNames)).files,
    payloadSHA256: payload.sha256,
    execution:
      'Not executed. Root must verify source, artifact hashes, system DLL/WebView2 requirements and native leases.',
  };
  await writeFile(
    path.join(output, 'artifact-manifest.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  return result;
}

async function main(command) {
  assert.equal(process.platform, 'win32', 'Windows artifact workflow only');
  assert.equal(process.arch, 'x64');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const evidence = path.join(root, 'work/native-windows-qa');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sourceSHA = git('rev-parse', 'HEAD');
  assert.equal(sourceSHA, process.env.QA_SOURCE_SHA);
  git('diff', '--exit-code');
  if (command === 'build') {
    assert.ok(process.env.CARGO_TARGET_DIR, 'Explicit Cargo target directory required');
    const target = path.resolve(process.env.CARGO_TARGET_DIR);
    assert.equal(target, path.join(root, 'work/native-windows-qa-target'));
    const executable = path.join(target, 'debug', 'jarvis.exe');
    await lstat(executable).then(
      () => {
        throw new Error('Refusing a preexisting QA executable');
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    const logs = (phase) => ({
      cwd: root,
      logFile: path.join(evidence, `${phase}.log`),
      resultFile: path.join(evidence, `${phase}.json`),
    });
    const preflight = await runLoggedCommand(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        path.join(root, 'scripts/native-windows-qa-preflight.ps1'),
        '-Phase',
        'before-cargo',
      ],
      logs('preflight-process'),
    );
    const cargo = await runLoggedCommand('cargo', NATIVE_QA_CARGO_ARGS, logs('cargo-build'));
    const built = await inspectBuiltExecutable(executable);
    built.sha256 = await sha256(executable);
    const provenancePath = path.join(evidence, 'provenance.json');
    const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
    provenance.build = { preflight, cargo, output: built };
    await writeFile(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
    await writeFile(
      path.join(evidence, 'build-output.json'),
      JSON.stringify(built, null, 2) + '\n',
      { flag: 'wx' },
    );
  } else if (command === 'snapshot') {
    const { fingerprint } = await import('./prepare-desktop-connector.mjs');
    assert.equal(await fingerprint(), process.env.QA_CONNECTOR_SHA256);
    const names = git('ls-files', '-z').split('\0').filter(Boolean);
    names.push('app/src-tauri/Cargo.lock');
    for (const resource of ['desktop-connector', 'siyuan-runtime']) {
      names.push(...(await walk(root, `app/src-tauri/resources/${resource}`)));
    }
    const inputs = await hashInputs(root, names);
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(evidence, 'input-manifest.json'),
      JSON.stringify(inputs, null, 2) + '\n',
    );
    const version = (tool, args) => execFileSync(tool, args, { encoding: 'utf8' }).trim();
    const provenance = {
      repository: process.env.GITHUB_REPOSITORY,
      sourceCommitSHA: sourceSHA,
      sourceTreeSHA: git('rev-parse', 'HEAD^{tree}'),
      workflowCommitSHA: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      inputSHA256: inputs.sha256,
      cargoLockSHA256: await sha256(path.join(root, 'app/src-tauri/Cargo.lock')),
      windowsConfigSHA256: await sha256(path.join(root, 'app/src-tauri/tauri.windows.conf.json')),
      connectorSourceSHA256: process.env.QA_CONNECTOR_SHA256,
      rustc: version('rustc', ['-Vv']),
      cargo: version('cargo', ['-V']),
      node: process.version,
      target: 'x86_64-pc-windows-msvc',
      profile: 'dev',
      features: ['default', 'jarvis-voice'],
      command:
        'cargo build --manifest-path app/src-tauri/Cargo.toml --bin jarvis --features jarvis-voice --locked -j 1',
      frontend:
        'Debug devUrl requires root-attested matching local Vite source; no frontend server is started by this job.',
      signing: 'Unsigned build-only artifact; no release or deployment.',
      runtimeAcceptance: 'Unrun',
    };
    await writeFile(
      path.join(evidence, 'provenance.json'),
      JSON.stringify(provenance, null, 2) + '\n',
    );
  } else if (command === 'stage') {
    assert.equal(
      await sha256(path.join(root, 'app/src-tauri/Cargo.lock')),
      process.env.QA_CARGO_LOCK_SHA256,
    );
    const target = path.resolve(process.env.CARGO_TARGET_DIR, 'debug');
    await stageArtifact(root, target, path.join(evidence, 'artifact'), evidence);
  } else {
    throw new Error('Expected snapshot, build or stage');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
