import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  const call = blockAt(qa, '  workflow_call:');
  assert.doesNotMatch(call, /secrets:/u);
  assert.deepEqual(
    [...call.matchAll(/^      ([a-z_0-9]+):$/gmu)].map((match) => match[1]),
    proofInputs,
  );
  for (const name of proofInputs) {
    assert.match(blockAt(call, `      ${name}:`), /required: true\s+type: string/u);
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
  const cargo = workflow.indexOf('cargo build --manifest-path');
  assert.ok(cargo > workflow.indexOf('npm run prepare:desktop-connector'));
  assert.ok(cargo > workflow.indexOf('npm run prepare:siyuan-runtime'));
  assert.ok(cargo > workflow.indexOf('-Phase before-cargo'));
  assert.match(workflow, /--bin jarvis --features jarvis-voice --locked -j 1/u);
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
      'DirectML.dll': 'fixture DLL, never loaded',
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
    await writeFile(path.join(evidence, 'provenance.json'), '{}');
    await writeFile(path.join(evidence, 'dll-dependencies.txt'), 'fixture inspection');
    const manifest = await stageArtifact(fixture, target, output, evidence);
    assert.deepEqual(
      manifest.files.map((file) => file.path).sort(),
      Object.keys(files)
        .map((file) => `binary/${file}`)
        .sort(),
    );
    assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/u.test(file.sha256)));
    assert.equal(
      await readFile(path.join(output, 'binary/DirectML.dll'), 'utf8'),
      files['DirectML.dll'],
    );
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
