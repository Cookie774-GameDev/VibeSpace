import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// DLL header schema fixture only; never loaded and never claimed as native evidence.
function dllHeaderFixture() {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ');
  bytes.writeUInt32LE(64, 60);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x2002, 86);
  return bytes;
}

async function fixtureDllEvidence(target, evidence, dllNames) {
  const { sha256 } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  const directory = path.join(evidence, 'materialized-dlls');
  await mkdir(directory);
  const files = [];
  for (const name of dllNames) {
    const bytes = dllHeaderFixture();
    await writeFile(path.join(target, name), bytes);
    await writeFile(path.join(directory, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: await sha256(path.join(directory, name)) });
  }
  const sourceSHA = '1'.repeat(40);
  const inventory = {
    sourceSHA,
    executableSHA256: await sha256(path.join(target, 'jarvis.exe')),
    directory,
    files,
  };
  await writeFile(path.join(evidence, 'dll-inventory.json'), JSON.stringify(inventory));
  await writeFile(
    path.join(evidence, 'provenance.json'),
    JSON.stringify({
      sourceCommitSHA: sourceSHA,
      dllInventorySHA256: await sha256(path.join(evidence, 'dll-inventory.json')),
    }),
  );
  const reports = [
    `Dump of file ${path.join(target, 'jarvis.exe')}\nFile Type: EXECUTABLE IMAGE\n  Image has the following dependencies:\n    KERNEL32.dll\n${dllNames.map((name) => `    ${name}\n`).join('')}`,
  ];
  for (const name of dllNames)
    reports.push(
      `Dump of file ${path.join(directory, name)}\nFile Type: DLL\n  Image has the following dependencies:\n    KERNEL32.dll\n`,
    );
  await writeFile(path.join(evidence, 'dll-dependencies.txt'), reports.join('\n'));
  return inventory;
}

test('DLL closure covers transitive imports and never classifies DirectML or MSVC runtime as system DLLs', async () => {
  const { parseDllReports, verifyDllImports } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  const report =
    'Dump of file C:\\target\\jarvis.exe\nFile Type: EXECUTABLE IMAGE\n  Image has the following dependencies:\n    KERNEL32.dll\n    DirectML.dll\n\nDump of file C:\\target\\DirectML.dll\nFile Type: DLL\n  Image has the following dependencies:\n    api-ms-win-core-synch-l1-2-0.dll\n    MSVCP140.dll\n\nDump of file C:\\target\\MSVCP140.dll\nFile Type: DLL\n  Image has the following dependencies:\n    ucrtbase.dll\n';
  const modules = parseDllReports(report);
  assert.throws(() => verifyDllImports(modules, { files: [] }), /DLL closure is empty/u);
  assert.throws(
    () => verifyDllImports(modules, { files: [{ name: 'DirectML.dll' }] }),
    /MSVCP140|msvcp140/u,
  );
  const edges = verifyDllImports(modules, {
    files: [{ name: 'DirectML.dll' }, { name: 'MSVCP140.dll' }],
  });
  assert.equal(edges.filter((edge) => edge.kind === 'packaged').length, 2);
  assert.equal(edges.filter((edge) => edge.kind === 'windows-system-contract').length, 3);
  assert.throws(
    () => parseDllReports(report + '\nDump of file C:\\other\\DirectML.dll\n'),
    /Duplicate/u,
  );
  assert.throws(
    () => parseDllReports('Dump of file C:\\target\\jarvis.exe\nFile Type: EXECUTABLE IMAGE\n'),
    /empty/u,
  );
  assert.throws(
    () =>
      verifyDllImports(modules, {
        files: [
          { name: 'DirectML.dll' },
          { name: 'MSVCP140.dll' },
          { name: 'missing-inspection.dll' },
        ],
      }),
    /not inspected/u,
  );
});

test('DLL materialization binds approved fresh build/toolchain sources and rejects unsupported entries', async () => {
  const { materializeDlls, sha256 } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-native-qa-dll-'));
  try {
    const target = path.join(fixture, 'target/debug');
    const redist = path.join(fixture, 'VS/VC/Redist/MSVC/14.51/x64/Microsoft.VC145.CRT');
    await mkdir(target, { recursive: true });
    await mkdir(redist, { recursive: true });
    await writeFile(path.join(target, 'DirectML.dll'), dllHeaderFixture());
    await writeFile(path.join(redist, 'MSVCP140.dll'), dllHeaderFixture());
    const options = {
      sourceSHA: '1'.repeat(40),
      executableSHA256: '2'.repeat(64),
      msvcRedistRoot: redist,
    };
    const directory = path.join(fixture, 'materialized');
    const inventory = await materializeDlls(target, directory, options);
    assert.equal(inventory.files.length, 2);
    assert.deepEqual(inventory.files.map((file) => file.origin).sort(), [
      'cargo-output',
      'msvc-redist',
    ]);
    for (const file of inventory.files)
      assert.equal(await sha256(path.join(directory, file.name)), file.sha256);
    await assert.rejects(() => materializeDlls(target, directory, options), /already exists/u);
    await mkdir(path.join(target, 'directory.dll'));
    await assert.rejects(
      () => materializeDlls(target, path.join(fixture, 'unsupported'), options),
      /Unsupported DLL source/u,
    );
    const ownedDirectory = path.resolve(target, 'directory.dll');
    assert.ok(ownedDirectory.startsWith(path.resolve(fixture) + path.sep));
    await rm(ownedDirectory, { recursive: true });
    await writeFile(path.join(target, 'bad.dll'), 'not a PE DLL');
    await assert.rejects(
      () => materializeDlls(target, path.join(fixture, 'invalid'), options),
      /PE|DLL/u,
    );
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(fixture).startsWith('vibespace-native-qa-dll-'));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('artifact staging refuses an inspected but unbundled required DLL', async () => {
  const { stageArtifact } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  const { createHash } = await import('node:crypto');
  const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-native-qa-link-'));
  try {
    const target = path.join(fixture, 'target/debug');
    const evidence = path.join(fixture, 'evidence');
    const contents = {
      'jarvis.exe': 'opaque unit packaging fixture; never executed',
      'resources/desktop-connector/runtime.zip': 'opaque unit runtime fixture',
      'resources/siyuan-runtime/VIBESPACE_SIYUAN_READY.json': '{}',
    };
    contents['resources/desktop-connector/manifest.json'] = JSON.stringify({
      platform: 'win32-x64',
      sha256: createHash('sha256')
        .update(contents['resources/desktop-connector/runtime.zip'])
        .digest('hex'),
    });
    for (const [name, contentsOfFile] of Object.entries(contents)) {
      await mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await writeFile(path.join(target, name), contentsOfFile);
    }
    await mkdir(path.join(target, '_up_'));
    await mkdir(evidence);
    const inputFiles = Object.entries(contents)
      .filter(([name]) => name.startsWith('resources/'))
      .map(([name, content]) => ({
        path: `app/src-tauri/${name}`,
        sha256: createHash('sha256').update(content).digest('hex'),
      }));
    await writeFile(
      path.join(evidence, 'input-manifest.json'),
      JSON.stringify({ files: inputFiles }),
    );
    await writeFile(path.join(evidence, 'provenance.json'), '{}');
    await writeFile(
      path.join(evidence, 'dll-dependencies.txt'),
      `Dump of file ${path.join(target, 'jarvis.exe')}\nFile Type: EXECUTABLE IMAGE\n  Image has the following dependencies:\n    DirectML.dll\n\nDump of file ${path.join(target, 'DirectML.dll')}\nFile Type: DLL\n`,
    );
    const output = path.join(fixture, 'work/artifact');
    await assert.rejects(() => stageArtifact(fixture, target, output, evidence), /DLL|closure/u);
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(fixture).startsWith('vibespace-native-qa-link-'));
    await rm(fixture, { recursive: true, force: true });
  }
});

test('logged subprocesses record their actual exit status, including a successful PowerShell return', async () => {
  const { runLoggedCommand } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  assert.equal(typeof runLoggedCommand, 'function');
  const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-qa-process-'));
  try {
    const script = path.join(fixture, 'returns-without-exit.ps1');
    await writeFile(script, "Write-Output 'PREFLIGHT_RETURNED'");
    const options = (name) => ({
      cwd: fixture,
      logFile: path.join(fixture, `${name}.log`),
      resultFile: path.join(fixture, `${name}.json`),
    });
    const admitted = await runLoggedCommand(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', script],
      options('preflight'),
    );
    assert.equal(admitted.code, 0);
    assert.match(await readFile(options('preflight').logFile, 'utf8'), /PREFLIGHT_RETURNED/u);
    const next = await runLoggedCommand(
      process.execPath,
      ['-e', "console.log('NEXT_PROCESS_REACHED'); console.error('STDERR_CAPTURED')"],
      options('next'),
    );
    assert.equal(next.code, 0);
    const log = await readFile(options('next').logFile, 'utf8');
    assert.match(log, /NEXT_PROCESS_REACHED/u);
    assert.match(log, /STDERR_CAPTURED/u);
    await assert.rejects(
      runLoggedCommand(
        process.execPath,
        ['-e', "console.error('REAL_FAILURE'); process.exit(17)"],
        options('failed'),
      ),
      /exit code 17/u,
    );
    assert.equal(JSON.parse(await readFile(options('failed').resultFile, 'utf8')).code, 17);
    assert.match(await readFile(options('failed').logFile, 'utf8'), /REAL_FAILURE/u);
    await assert.rejects(
      runLoggedCommand(path.join(fixture, 'missing-command'), [], options('not-found')),
      /spawn|ENOENT/u,
    );
    assert.equal(
      JSON.parse(await readFile(options('not-found').resultFile, 'utf8')).spawnError.code,
      'ENOENT',
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test(
  'zero subprocess exit cannot certify a missing or non-executable output',
  { skip: process.platform !== 'win32' },
  async () => {
    const { runLoggedCommand, inspectBuiltExecutable } = await import(
      pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
    );
    assert.equal(typeof inspectBuiltExecutable, 'function');
    const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-qa-output-'));
    try {
      await runLoggedCommand(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: fixture,
        logFile: path.join(fixture, 'empty.log'),
        resultFile: path.join(fixture, 'empty.json'),
      });
      await assert.rejects(inspectBuiltExecutable(path.join(fixture, 'jarvis.exe')), {
        code: 'ENOENT',
      });
      const text = path.join(fixture, 'not-an-executable.txt');
      await writeFile(text, 'ordinary text, never an executable');
      await assert.rejects(inspectBuiltExecutable(text), /PE|executable/u);
      // Read the real Node executable's header only; never fabricate or execute jarvis.exe.
      const knownExecutable = await inspectBuiltExecutable(process.execPath);
      assert.equal(knownExecutable.machine, 'x86_64');
      assert.ok(knownExecutable.bytes > 0);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
);

const proofInputs = [
  'source_sha',
  'cargo_lock_sha256',
  'windows_config_sha256',
  'connector_source_sha256',
];

function blockAt(source, header) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const start = lines.indexOf(header);
  assert.ok(start >= 0, `Missing YAML block: ${header.trim()}`);
  const indent = header.length - header.trimStart().length;
  let end = start + 1;
  while (
    end < lines.length &&
    (!lines[end].trim() || lines[end].startsWith(' '.repeat(indent + 1)))
  ) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

function assertJobEnvContexts(jobEnv) {
  // GitHub's contexts reference: jobs.<job_id>.env excludes runner, env, job and steps.
  const allowed = new Set(['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs']);
  for (const expression of jobEnv.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
    for (const reference of expression[1].matchAll(/\b([a-z_][a-z_0-9]*)\s*(?:\.|\[)/giu)) {
      assert.ok(
        allowed.has(reference[1].toLowerCase()),
        `Unsupported job env context: ${reference[1]}`,
      );
    }
  }
}

test('job environment rejects runner and other step-only expression contexts', async () => {
  const qa = await readFile(path.join(root, '.github/workflows/native-windows-qa.yml'), 'utf8');
  assertJobEnvContexts(blockAt(qa, '    env:'));
  for (const context of ['runner', 'env', 'job', 'steps']) {
    for (const reference of [`${context}.temp`, `${context}['temp']`]) {
      assert.throws(
        () => assertJobEnvContexts('      MISPLACED: $' + `{{ ${reference} }}`),
        /Unsupported job env context/u,
      );
    }
  }
  assert.doesNotThrow(() => assertJobEnvContexts('      VALID: $' + '{{ github.workspace }}'));
});

test('runner paths export through GITHUB_ENV before preparation and preserve the isolated directories', async () => {
  const qa = await readFile(path.join(root, '.github/workflows/native-windows-qa.yml'), 'utf8');
  const step = blockAt(qa, '      - name: Initialize isolated runner paths');
  assert.ok(qa.indexOf(step.split('\n')[0]) < qa.indexOf('-Phase before-prepare'));
  assert.ok(qa.indexOf(step.split('\n')[0]) < qa.indexOf('npm run prepare:desktop-connector'));
  const script = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length);
  assert.doesNotMatch(script, /\$\{\{/u);
  const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-qa-env-'));
  try {
    const runnerTemp = path.join(fixture, 'runner temp ü');
    const envFile = path.join(fixture, 'github-env.txt');
    await mkdir(runnerTemp);
    await writeFile(envFile, 'EXISTING=preserved\n');
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: envFile },
    });
    assert.deepEqual((await readFile(envFile, 'utf8')).trim().split(/\r?\n/u), [
      'EXISTING=preserved',
      `VIBESPACE_CONNECTOR_BUILD_DIR=${path.join(runnerTemp, 'native-windows-qa-connector')}`,
      `VIBESPACE_SIYUAN_CACHE_DIR=${path.join(runnerTemp, 'native-windows-qa-siyuan')}`,
    ]);
    assert.throws(() =>
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 10000,
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, RUNNER_TEMP: '', GITHUB_ENV: envFile },
      }),
    );
    assert.throws(() =>
      execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 10000,
        windowsHide: true,
        stdio: 'pipe',
        env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: '' },
      }),
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('registered CI opts into the same-commit Windows QA call without requiring ordinary CI inputs', async () => {
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const dispatch = blockAt(ci, '  workflow_dispatch:');
  assert.match(
    blockAt(dispatch, '      nativeWindowsQa:'),
    /required: false\s+type: boolean\s+default: false/u,
  );
  for (const name of proofInputs) {
    assert.match(
      blockAt(dispatch, `      ${name}:`),
      /required: false\s+type: string\s+default: ''/u,
    );
  }
  const call = blockAt(ci, '  native-windows-qa:');
  assert.match(
    call,
    /if: github\.event_name == 'workflow_dispatch' && inputs\.nativeWindowsQa == true/u,
  );
  assert.match(call, /uses: \.\/\.github\/workflows\/native-windows-qa\.yml\s*\n/u);
  assert.match(call, /permissions:\s*\n      contents: read\s*\n/u);
  assert.doesNotMatch(call, /secrets|runs-on:|steps:|needs:|@/u);
  for (const name of proofInputs) {
    assert.ok(call.includes(`      ${name}: $` + `{{ inputs.${name} }}`), `Pass ${name} unchanged`);
  }
});

test('reusable Windows QA requires all four string proofs and declares no secrets', async () => {
  const qa = await readFile(path.join(root, '.github/workflows/native-windows-qa.yml'), 'utf8');
  const { createHash } = await import('node:crypto');
  // Only the authenticated historical local workflow may use the four-input schema.
  const withLifecycle = createHash('sha256').update(qa, 'utf8').digest('hex') !==
    '3e0542e0f50b1b68f0f2dd797db42118bd0f1de3745e85a8a7282ff3f4a9fa12';
  const validateInvocation = (source) => {
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const inputs = blockAt(source, `  ${trigger}:`);
      assert.doesNotMatch(inputs, /secrets:/u);
      assert.deepEqual(
        [...inputs.matchAll(/^      ([a-z_0-9]+):$/gmu)].map((match) => match[1]),
        withLifecycle ? [...proofInputs, 'foundry_lifecycle_enabled'] : proofInputs,
      );
      for (const name of proofInputs) {
        assert.match(blockAt(inputs, `      ${name}:`), /required: true\s+type: string/u);
      }
      if (withLifecycle) {
        assert.match(
          blockAt(inputs, '      foundry_lifecycle_enabled:'),
          /required: false\s+type: boolean\s+default: false\s*$/u,
        );
      }
    }
  };
  validateInvocation(qa);
  if (withLifecycle) {
    let bothRemoved = qa;
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      const inputs = blockAt(bothRemoved, `  ${trigger}:`);
      const lifecycle = blockAt(inputs, '      foundry_lifecycle_enabled:');
      bothRemoved = bothRemoved.replace(inputs, inputs.replace(lifecycle, ''));
    }
    assert.throws(() => validateInvocation(bothRemoved));
  }
  // Execute this same contract against unsafe variants of the actual workflow.
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    const inputs = blockAt(qa, `  ${trigger}:`);
    const lifecycle = withLifecycle ? blockAt(inputs, '      foundry_lifecycle_enabled:') : undefined;
    const unsafeVariants = [
      inputs + '\n      unreviewed_input:\n        required: false\n        type: boolean\n',
      inputs + '\n    secrets:\n      unreviewed_secret:\n        required: false\n',
    ];
    if (withLifecycle) {
      unsafeVariants.push(
      inputs.replace(lifecycle, lifecycle.replace('default: false', 'default: true')),
      inputs.replace(lifecycle, lifecycle.replace('required: false', 'required: true')),
      inputs.replace(lifecycle, lifecycle.replace('type: boolean', 'type: string')),
      inputs.replace(lifecycle, ''),
      );
    }
    for (const proof of proofInputs) {
      const original = blockAt(inputs, `      ${proof}:`);
      unsafeVariants.push(inputs.replace(original, original.replace('required: true', 'required: false')));
    }
    for (const unsafe of unsafeVariants) {
      assert.throws(() => validateInvocation(qa.replace(inputs, unsafe)));
    }
  }
});

test('opted-in QA rejects missing or malformed proofs before checkout or resource preparation', async () => {
  const qa = await readFile(path.join(root, '.github/workflows/native-windows-qa.yml'), 'utf8');
  const step = blockAt(qa, '      - name: Validate immutable source inputs');
  assert.ok(qa.indexOf(step.split('\n')[0]) < qa.indexOf('      - uses: actions/checkout@'));
  // Execute the actual input validator only; do not change this machine's Git settings.
  const validator = step.slice(step.indexOf('          if ($env:QA_SOURCE_SHA'));
  assert.ok(validator.startsWith('          if ($env:QA_SOURCE_SHA'));
  const names = [
    'QA_SOURCE_SHA',
    'QA_CARGO_LOCK_SHA256',
    'QA_WINDOWS_CONFIG_SHA256',
    'QA_CONNECTOR_SHA256',
  ];
  const valid = ['a'.repeat(40), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
  const cases = [valid];
  for (let index = 0; index < names.length; index += 1) {
    for (const invalid of ['', 'A'.repeat(index === 0 ? 40 : 64)]) {
      cases.push(valid.map((value, position) => (position === index ? invalid : value)));
    }
  }
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `& {
    $cases = ConvertFrom-Json ${quote(JSON.stringify(cases))}
    $names = ConvertFrom-Json ${quote(JSON.stringify(names))}
    $validator = [scriptblock]::Create(${quote(validator)})
    $results = foreach ($case in $cases) {
      for ($index = 0; $index -lt $names.Count; $index++) {
        [Environment]::SetEnvironmentVariable($names[$index], $case[$index], 'Process')
      }
      try { & $validator; $true } catch { $false }
    }
    ConvertTo-Json -InputObject @($results)
  }`;
  const results = JSON.parse(
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }),
  );
  assert.deepEqual(results, [true, ...Array(8).fill(false)]);
});

test('Windows QA workflow only builds and uploads with read-only repository access', async () => {
  const workflowPath = path.join(root, '.github/workflows/native-windows-qa.yml');
  assert.ok(existsSync(workflowPath), 'A separate build-only Windows workflow is required');
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /on:\s*\n  workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /\n  (push|pull_request|schedule|create):/u);
  assert.match(workflow, /permissions:\s*\n  contents: read\s*\n/u);
  assert.doesNotMatch(
    workflow,
    /contents: write|secrets\.|tauri-action|gh release|sign-windows|deploy/iu,
  );
  assert.match(workflow, /runs-on: windows-latest/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /git config --global core.autocrlf false/u);
  assert.match(workflow, /toolchain: 1\.96\.0/u);
  for (const match of workflow.matchAll(/uses: ([^\s#]+)/gu)) {
    assert.match(match[1], /@[a-f0-9]{40}$/u, 'Every action uses a full pinned commit');
  }
  const cargo = workflow.indexOf('node scripts/native-windows-qa.mjs build');
  assert.ok(cargo > workflow.indexOf('npm run prepare:desktop-connector'));
  assert.ok(cargo > workflow.indexOf('npm run prepare:siyuan-runtime'));
  const helper = await readFile(path.join(root, 'scripts/native-windows-qa.mjs'), 'utf8');
  const { NATIVE_QA_CARGO_ARGS } = await import(
    pathToFileURL(path.join(root, 'scripts/native-windows-qa.mjs')).href
  );
  assert.deepEqual(NATIVE_QA_CARGO_ARGS, [
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
  assert.match(helper, /'-Phase',\s*'before-cargo'/u);
  assert.ok(helper.includes("await runLoggedCommand('cargo', NATIVE_QA_CARGO_ARGS"));
  assert.ok(helper.includes('await inspectBuiltExecutable(executable)'));
  assert.doesNotMatch(
    blockAt(workflow, '      - name: Admit and build debug executable'),
    /\$LASTEXITCODE/u,
  );
  assert.match(workflow, /include-hidden-files: true/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.match(workflow, /retention-days: 3/u);
});

test('resource admission refuses insufficient RAM, commit or disk without executing a build', () => {
  const preflight = path.join(root, 'scripts/native-windows-qa-preflight.ps1');
  assert.ok(existsSync(preflight), 'Remote preflight must exist');
  const command = `& { . '${preflight.replaceAll("'", "''")}'; @(
    (Test-NativeQaAdmission -AvailableMiB 8704 -CommitAvailableMiB 11264 -DiskAvailableMiB 12288),
    (Test-NativeQaAdmission -AvailableMiB 8703 -CommitAvailableMiB 11264 -DiskAvailableMiB 12288),
    (Test-NativeQaAdmission -AvailableMiB 8704 -CommitAvailableMiB 11263 -DiskAvailableMiB 12288),
    (Test-NativeQaAdmission -AvailableMiB 8704 -CommitAvailableMiB 11264 -DiskAvailableMiB 12287)
  ) | ConvertTo-Json -Depth 4 }`;
  const results = JSON.parse(
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    }),
  );
  assert.deepEqual(
    results.map((result) => result.admitted),
    [true, false, false, false],
  );
  assert.deepEqual(results[1].reasons, ['insufficient_available_ram']);
  assert.deepEqual(results[2].reasons, ['insufficient_commit_headroom']);
  assert.deepEqual(results[3].reasons, ['insufficient_disk']);
});

test('artifact package preserves DLL/resource paths and identifies every payload byte', async () => {
  const helper = path.join(root, 'scripts/native-windows-qa.mjs');
  assert.ok(existsSync(helper), 'Artifact provenance helper must exist');
  const { stageArtifact, hashInputs } = await import(pathToFileURL(helper).href);
  const fixture = await mkdtemp(path.join(tmpdir(), 'vibespace-native-qa-test-'));
  try {
    const target = path.join(fixture, 'target/debug');
    const files = {
      'jarvis.exe': 'fixture executable, never run',
      'DirectML.dll': dllHeaderFixture(),
      'resources/desktop-connector/runtime.zip': 'fixture archive, never opened',
      'resources/siyuan-runtime/VIBESPACE_SIYUAN_READY.json': '{}',
      'resources/siyuan-runtime/%SystemDrive%/assets/.required': 'retain hidden payload',
      '_up_/_up_/docs/oss/licenses/NOTICE.txt': 'license',
    };
    const { createHash } = await import('node:crypto');
    files['resources/desktop-connector/manifest.json'] = JSON.stringify({
      platform: 'win32-x64',
      sha256: createHash('sha256')
        .update(files['resources/desktop-connector/runtime.zip'])
        .digest('hex'),
    });
    for (const [relative, content] of Object.entries(files)) {
      const destination = path.join(target, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const output = path.join(fixture, 'work/native-windows-qa/artifact');
    const evidence = path.join(fixture, 'evidence');
    await mkdir(evidence);
    const resourceInputs = Object.entries(files)
      .filter(([name]) => name.startsWith('resources/') || name.startsWith('_up_/'))
      .map(([name, content]) => ({
        path: path.posix.normalize(`app/src-tauri/${name.replaceAll('_up_', '..')}`),
        sha256: createHash('sha256').update(content).digest('hex'),
      }));
    await writeFile(
      path.join(evidence, 'input-manifest.json'),
      JSON.stringify({ files: resourceInputs }),
    );
    await fixtureDllEvidence(target, evidence, ['DirectML.dll']);
    const manifest = await stageArtifact(fixture, target, output, evidence);
    assert.deepEqual(
      manifest.files.map((file) => file.path).sort(),
      Object.keys(files)
        .map((file) => `binary/${file}`)
        .sort(),
    );
    assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.deepEqual(
      await readFile(path.join(output, 'binary/DirectML.dll')),
      files['DirectML.dll'],
    );
    assert.ok(manifest.evidenceFiles.some((file) => file.path === 'dll-inventory.json'));
    assert.equal(
      manifest.dllClosure.dependencies.filter((edge) => edge.kind === 'packaged').length,
      1,
    );
    const copiedDLL = path.join(evidence, 'materialized-dlls/DirectML.dll');
    const changedDLL = dllHeaderFixture();
    changedDLL[127] = 1;
    await writeFile(copiedDLL, changedDLL);
    await assert.rejects(
      () =>
        stageArtifact(fixture, target, path.join(fixture, 'work/dll-tamper/artifact'), evidence),
      /DLL inventory hash/u,
    );
    await writeFile(copiedDLL, dllHeaderFixture());
    const reportPath = path.join(evidence, 'dll-dependencies.txt');
    const originalReport = await readFile(reportPath, 'utf8');
    await writeFile(
      reportPath,
      originalReport.replace(
        path.join(target, 'jarvis.exe'),
        path.join(fixture, 'elsewhere/jarvis.exe'),
      ),
    );
    await assert.rejects(
      () =>
        stageArtifact(
          fixture,
          target,
          path.join(fixture, 'work/wrong-inspection/artifact'),
          evidence,
        ),
      /inspection path mismatch/u,
    );
    await writeFile(reportPath, originalReport);
    await assert.rejects(() => hashInputs(fixture, ['../outside']), /outside|relative/u);
    await assert.rejects(() => stageArtifact(fixture, target, output, evidence), /exist/u);
    await writeFile(
      path.join(target, '_up_/_up_/docs/oss/licenses/NOTICE.txt'),
      'changed after freeze',
    );
    await assert.rejects(
      () => stageArtifact(fixture, target, path.join(fixture, 'work/tampered/artifact'), evidence),
      /frozen input/u,
    );
    await writeFile(path.join(target, '_up_/_up_/docs/oss/licenses/NOTICE.txt'), 'license');
    const hiddenResource = path.join(
      target,
      'resources/siyuan-runtime/%SystemDrive%/assets/.required',
    );
    await rm(hiddenResource);
    await assert.rejects(
      () =>
        stageArtifact(fixture, target, path.join(fixture, 'work/incomplete/artifact'), evidence),
      /Missing frozen resource closure/u,
    );
    await writeFile(hiddenResource, 'retain hidden payload');
    await rm(path.join(target, 'resources/desktop-connector/runtime.zip'));
    await assert.rejects(
      () => stageArtifact(fixture, target, path.join(fixture, 'work/missing/artifact'), evidence),
      /ENOENT/u,
    );
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(tmpdir()) + path.sep));
    assert.ok(path.basename(fixture).startsWith('vibespace-native-qa-test-'));
    await rm(fixture, { recursive: true, force: true });
  }
});
