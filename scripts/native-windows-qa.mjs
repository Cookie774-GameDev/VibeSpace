import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  statfs,
  writeFile,
} from 'node:fs/promises';
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

export async function inspectPeImage(executable, dll = false) {
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
      (characteristics & 2) !== 0 && Boolean(characteristics & 0x2000) === dll,
      dll ? 'Expected a DLL image' : 'Expected an executable image, not a DLL',
    );
    return { executable, bytes: info.size, machine: 'x86_64' };
  } finally {
    await handle.close();
  }
}

export async function inspectBuiltExecutable(executable) {
  return inspectPeImage(executable);
}

function isWithin(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// DirectML is intentionally excluded: it must come from this build's verified output.
const SYSTEM_DLLS = new Set(
  (
    'kernel32 ntdll kernelbase user32 gdi32 gdi32full advapi32 ole32 oleaut32 shell32 shlwapi ' +
    'combase comctl32 crypt32 cryptbase bcrypt bcryptprimitives ws2_32 setupapi cfgmgr32 ' +
    'dbghelp dwmapi dxgi d3d12 d3d11 dxcore dcomp dwrite imm32 shcore propsys version ' +
    'wintrust secur32 sspicli normaliz uxtheme winmm winhttp wininet urlmon psapi iphlpapi ' +
    'netapi32 ntmarta win32u wtsapi32 powrprof pdh ucrtbase rpcrt4 mswsock'
  )
    .split(' ')
    .map((name) => `${name}.dll`),
);

export function parseDllReports(text) {
  const modules = [];
  for (const line of text.split(/\r?\n/u)) {
    const heading = /^Dump of file (.+)$/u.exec(line.trim());
    if (heading) {
      const file = heading[1].replace(/^"|"$/gu, '');
      const name = path.win32.basename(file).toLowerCase();
      assert.ok(
        name === 'jarvis.exe' || /^[a-z0-9_.-]+\.dll$/u.test(name),
        'Invalid inspected module',
      );
      assert.ok(!modules.some((module) => module.name === name), 'Duplicate DLL inspection');
      modules.push({ name, file, imports: [] });
    } else {
      const imported = /^\s+([a-z0-9_.-]+\.dll)\s*$/iu.exec(line);
      if (imported) {
        assert.ok(modules.length, 'Dependency without inspected module');
        const names = modules.at(-1).imports;
        if (!names.includes(imported[1].toLowerCase())) names.push(imported[1].toLowerCase());
      }
    }
  }
  assert.ok(
    modules.some((module) => module.name === 'jarvis.exe'),
    'Executable dependency inspection missing',
  );
  assert.ok(
    modules.find((module) => module.name === 'jarvis.exe').imports.length,
    'Executable dependency list is empty',
  );
  return modules;
}

export function verifyDllImports(modules, inventory) {
  assert.ok(
    Array.isArray(inventory.files) && inventory.files.length,
    'Verified DLL closure is empty',
  );
  const packaged = new Map(inventory.files.map((file) => [file.name.toLowerCase(), file]));
  assert.equal(packaged.size, inventory.files.length, 'Duplicate packaged DLL names');
  const inspected = new Set(modules.map((module) => module.name));
  for (const file of inventory.files)
    assert.ok(inspected.has(file.name.toLowerCase()), `DLL not inspected: ${file.name}`);
  const dependencies = [];
  for (const module of modules) {
    assert.ok(
      module.name === 'jarvis.exe' || packaged.has(module.name),
      'Inspected DLL missing from package',
    );
    for (const imported of module.imports) {
      const kind = packaged.has(imported)
        ? 'packaged'
        : SYSTEM_DLLS.has(imported) || /^(api|ext)-ms-win-/u.test(imported)
          ? 'windows-system-contract'
          : null;
      assert.ok(kind, `Unresolved non-system DLL: ${module.name} -> ${imported}`);
      dependencies.push({ module: module.name, imported, kind });
    }
  }
  return dependencies;
}

export async function materializeDlls(
  target,
  destination,
  { sourceSHA, executableSHA256, msvcRedistRoot },
) {
  const targetRoot = await realpath(path.dirname(target));
  const ortCache = path.join(targetRoot, 'ort-cache');
  const redistRoot = await realpath(msvcRedistRoot);
  assert.match(
    redistRoot.replaceAll('\\', '/'),
    /\/VC\/Redist\/MSVC\/[^/]+\/x64\/Microsoft\.VC\d+\.CRT$/iu,
    'Expected the selected MSVC x64 CRT redist directory',
  );
  assert.ok(
    !(await lstat(destination).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })),
    'DLL materialization directory already exists',
  );
  const files = [];
  for (const [directory, origin] of [
    [target, 'cargo-output'],
    [redistRoot, 'msvc-redist'],
  ]) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.name.toLowerCase().endsWith('.dll')) continue;
      assert.match(entry.name, /^[a-z0-9_.-]+\.dll$/iu, 'Invalid DLL filename');
      // Never silently drop DLL links or unexpected types as the old isFile filter did.
      const sourcePath = path.join(directory, entry.name);
      const info = await lstat(sourcePath);
      assert.ok(info.isFile() || info.isSymbolicLink(), 'Unsupported DLL source type');
      const resolvedPath = await realpath(sourcePath);
      assert.ok(
        isWithin(origin === 'cargo-output' ? targetRoot : redistRoot, resolvedPath),
        'DLL source outside approved build/toolchain root',
      );
      if (info.isSymbolicLink() && origin === 'cargo-output')
        assert.ok(
          isWithin(ortCache, resolvedPath) || isWithin(target, resolvedPath),
          'DLL link outside isolated build cache',
        );
      const image = await inspectPeImage(resolvedPath, true);
      const hash = await sha256(resolvedPath);
      const prior = files.find((file) => file.name.toLowerCase() === entry.name.toLowerCase());
      if (prior) {
        assert.equal(prior.sha256, hash, 'Conflicting DLL sources');
        continue;
      }
      files.push({
        name: entry.name,
        sourcePath,
        resolvedPath,
        origin,
        wasSymbolicLink: info.isSymbolicLink(),
        bytes: image.bytes,
        sha256: hash,
      });
    }
  }
  assert.ok(files.length, 'No DLL sources materialized');
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    await cp(file.resolvedPath, within(destination, file.name), {
      errorOnExist: true,
      force: false,
    });
    assert.equal(
      await sha256(within(destination, file.name)),
      file.sha256,
      'Materialized DLL integrity',
    );
    assert.equal(
      await sha256(file.resolvedPath),
      file.sha256,
      'DLL source changed during materialization',
    );
  }
  return {
    sourceSHA,
    executableSHA256,
    target,
    ortCache,
    msvcRedistRoot: redistRoot,
    directory: destination,
    files,
  };
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
  const inventoryPath = path.join(evidence, 'dll-inventory.json');
  assert.ok(
    (await lstat(inventoryPath).catch(() => null))?.isFile(),
    'Verified DLL inventory/closure required',
  );
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const provenance = JSON.parse(await readFile(path.join(evidence, 'provenance.json'), 'utf8'));
  assert.equal(inventory.sourceSHA, provenance.sourceCommitSHA, 'DLL inventory source mismatch');
  assert.equal(
    inventory.executableSHA256,
    await sha256(path.join(target, 'jarvis.exe')),
    'DLL inventory executable mismatch',
  );
  assert.equal(
    provenance.dllInventorySHA256,
    await sha256(inventoryPath),
    'DLL inventory provenance mismatch',
  );
  assert.equal(
    path.resolve(inventory.directory),
    path.join(evidence, 'materialized-dlls'),
    'Unexpected DLL inventory directory',
  );
  const modules = parseDllReports(
    await readFile(path.join(evidence, 'dll-dependencies.txt'), 'utf8'),
  );
  const dependencies = verifyDllImports(modules, inventory);
  for (const module of modules) {
    const expected =
      module.name === 'jarvis.exe'
        ? path.join(target, 'jarvis.exe')
        : path.join(
            inventory.directory,
            inventory.files.find((file) => file.name.toLowerCase() === module.name).name,
          );
    assert.equal(path.resolve(module.file), expected, 'DLL inspection path mismatch');
  }
  names.push(...(await walk(target, 'resources')), ...(await walk(target, '_up_')));
  const payload = await hashInputs(target, names);
  for (const file of inventory.files) {
    const source = within(inventory.directory, file.name);
    assert.equal((await inspectPeImage(source, true)).bytes, file.bytes, 'DLL image changed');
    assert.equal(await sha256(source), file.sha256, 'DLL inventory hash mismatch');
    payload.files.push({ path: file.name, bytes: file.bytes, sha256: file.sha256 });
  }
  payload.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  payload.sha256 = createHash('sha256').update(JSON.stringify(payload.files)).digest('hex');
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
    const dll = inventory.files.find((source) => source.name === file.path);
    await cp(dll ? within(inventory.directory, dll.name) : within(target, file.path), destination, {
      errorOnExist: true,
      force: false,
    });
    assert.equal(await sha256(destination), file.sha256, 'Copied payload integrity');
  }
  provenance.dllClosure = {
    dependencies,
    inventorySHA256: provenance.dllInventorySHA256,
    runtimeAcceptance: 'Unrun',
  };
  await writeFile(
    path.join(evidence, 'provenance.json'),
    JSON.stringify(provenance, null, 2) + '\n',
  );
  const evidenceNames = [
    'input-manifest.json',
    'provenance.json',
    'dll-dependencies.txt',
    'dll-inventory.json',
  ];
  for (const name of evidenceNames) await cp(path.join(evidence, name), within(output, name));
  const result = {
    files: payload.files.map((file) => ({ ...file, path: `binary/${file.path}` })),
    evidenceFiles: (await hashInputs(output, evidenceNames)).files,
    payloadSHA256: payload.sha256,
    dllClosure: provenance.dllClosure,
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
    assert.equal(
      path.resolve(process.env.ORT_CACHE_DIR ?? ''),
      path.join(target, 'ort-cache'),
      'Isolated ORT cache required',
    );
    await lstat(path.join(target, 'ort-cache')).then(
      () => {
        throw new Error('Refusing a preexisting ORT runtime cache');
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
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
  } else if (command === 'materialize-dlls') {
    assert.equal(
      path.resolve(process.env.CARGO_TARGET_DIR ?? ''),
      path.join(root, 'work/native-windows-qa-target'),
      'Isolated build target required',
    );
    assert.equal(
      path.resolve(process.env.ORT_CACHE_DIR ?? ''),
      path.join(root, 'work/native-windows-qa-target/ort-cache'),
      'Isolated ORT cache required',
    );
    const target = path.resolve(process.env.CARGO_TARGET_DIR, 'debug');
    const provenance = JSON.parse(await readFile(path.join(evidence, 'provenance.json'), 'utf8'));
    assert.equal(provenance.build.cargo.code, 0, 'Successful real build required');
    assert.equal(
      await sha256(path.join(target, 'jarvis.exe')),
      provenance.build.output.sha256,
      'Build output changed',
    );
    const inventory = await materializeDlls(target, path.join(evidence, 'materialized-dlls'), {
      sourceSHA,
      executableSHA256: provenance.build.output.sha256,
      msvcRedistRoot: process.env.QA_MSVC_REDIST_DIR,
    });
    const inventoryPath = path.join(evidence, 'dll-inventory.json');
    await writeFile(inventoryPath, JSON.stringify(inventory, null, 2) + '\n', { flag: 'wx' });
    provenance.dllInventorySHA256 = await sha256(inventoryPath);
    await writeFile(
      path.join(evidence, 'provenance.json'),
      JSON.stringify(provenance, null, 2) + '\n',
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
    throw new Error('Expected snapshot, build, materialize-dlls or stage');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv[2]);
}
