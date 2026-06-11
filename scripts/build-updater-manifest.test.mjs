import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/build-updater-manifest.mjs');

test('builds a manifest from signed platforms and skips unsigned artifacts', async () => {
  const assetsDir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-updater-'));
  const outfile = path.join(assetsDir, 'latest.json');

  try {
    await writeFile(path.join(assetsDir, 'VibeSpace-0.1.25-Windows-x64.exe'), 'installer');
    await writeFile(path.join(assetsDir, 'VibeSpace-0.1.25-Windows-x64.exe.sig'), 'signature');
    await writeFile(path.join(assetsDir, 'Jarvis.One_aarch64.app.tar.gz'), 'unsigned mac archive');

    await execFileAsync(process.execPath, [
      script,
      '--version',
      '0.1.25',
      '--assets-dir',
      assetsDir,
      '--base-url',
      'https://example.test/releases/v0.1.25',
      '--outfile',
      outfile,
    ]);

    const manifest = JSON.parse(await readFile(outfile, 'utf8'));
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64']);
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'signature');
    assert.equal(
      manifest.platforms['windows-x86_64'].url,
      'https://example.test/releases/v0.1.25/VibeSpace-0.1.25-Windows-x64.exe',
    );
  } finally {
    await rm(assetsDir, { recursive: true, force: true });
  }
});
