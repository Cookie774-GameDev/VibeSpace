import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('manual Windows QA workflow only builds and uploads with read-only repository access', async () => {
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
