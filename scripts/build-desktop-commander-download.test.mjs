import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function zipEntries(archive) {
  const command =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
    '$zip=[IO.Compression.ZipFile]::OpenRead($env:VS_DOWNLOAD); try { ' +
    "ConvertTo-Json -InputObject @($zip.Entries | Where-Object { !$_.FullName.EndsWith('/') } | ForEach-Object { $_.FullName }) -Compress " +
    '} finally { $zip.Dispose() }';
  return JSON.parse(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, VS_DOWNLOAD: archive },
    }),
  ).map((entry) => entry.replaceAll('\\', '/'));
}

test('download build refreshes a relocatable allowlisted Plugin3 ZIP', {
  skip: process.platform !== 'win32',
}, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'vibespace-desktop-download-test-'));
  try {
    const archive = path.join(temp, 'vibespace-desktop-commander.zip');
    await writeFile(archive, 'stale package must be replaced');
    const built = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'build-desktop-commander-download.mjs')],
      {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
        env: {
          ...process.env,
          VIBESPACE_CONNECTOR_BUILD_DIR: path.join(temp, 'staging'),
          VIBESPACE_CONNECTOR_DOWNLOAD_OUTPUT: archive,
        },
      },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);
    assert.ok((await stat(archive)).size > 0);

    const entries = zipEntries(archive);
    for (const expected of [
      'setup-runtime.mjs',
      'supervisor.mjs',
      'plugin3/src/codex-reader.mjs',
      'plugin3/src/native-patch.mjs',
      'plugin3/runtime/desktop-commander-v3/dist/tools/process-lifecycle.js',
      'plugin3/runtime/desktop-commander-v3/dist/utils/process-output.js',
    ]) {
      assert.ok(entries.includes(expected), `download ZIP is missing ${expected}`);
    }
    assert.ok(!entries.some((entry) => /(^|\/)(?:state|work|evidence|node_modules)(\/|$)/i.test(entry)));
    assert.ok(!entries.some((entry) => /\.candidate-state|(?:^|\/)tunnel\.yaml$/i.test(entry)));
  } finally {
    const resolved = path.resolve(temp);
    const prefix = path.resolve(tmpdir()) + path.sep;
    assert.ok(
      resolved.startsWith(prefix) &&
        path.basename(resolved).startsWith('vibespace-desktop-download-test-'),
    );
    await rm(resolved, { recursive: true, force: true });
  }
});
