import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildUpdaterManifest } from './build-updater-manifest.mjs';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/build-updater-manifest.mjs');
const VERSION = '2.3.4';
const PUB_DATE = '2026-07-30T20:15:30.000Z';
const windowsTest = process.platform === 'win32' ? test : test.skip;
const MINISIGN_SIGNATURE = [
  'untrusted comment: signature from minisign secret key',
  'RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=',
  'trusted comment: timestamp:1555779966\tfile:test',
  'QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==',
].join('\n');
const SIGNATURE = Buffer.from(MINISIGN_SIGNATURE, 'utf8').toString('base64');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function withAssets(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibespace-updater-'));
  const assetsDir = path.join(root, 'assets');
  await mkdir(assetsDir);
  try {
    return await run({ assetsDir, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function addArtifact(assetsDir, name, signature = SIGNATURE) {
  await writeFile(path.join(assetsDir, name), `artifact:${name}`);
  if (signature !== null) {
    await writeFile(path.join(assetsDir, `${name}.sig`), signature);
  }
}

function invocationArgs(
  assetsDir,
  {
    baseUrl = `https://example.test/releases/v${VERSION}`,
    outfile = path.join(assetsDir, 'latest.json'),
    pubDate = PUB_DATE,
    version = VERSION,
  } = {},
) {
  return [
    script,
    '--version',
    version,
    '--assets-dir',
    assetsDir,
    '--base-url',
    baseUrl,
    '--outfile',
    outfile,
    '--pub-date',
    pubDate,
  ];
}

async function buildManifest(assetsDir, options) {
  const args = invocationArgs(assetsDir, options);
  const outfile = args[args.indexOf('--outfile') + 1];
  const result = await execFileAsync(process.execPath, args);
  return {
    ...result,
    bytes: await readFile(outfile, 'utf8'),
    manifest: JSON.parse(await readFile(outfile, 'utf8')),
    outfile,
  };
}

async function expectFailure(assetsDir, options, pattern) {
  await assert.rejects(
    execFileAsync(process.execPath, invocationArgs(assetsDir, options)),
    (error) => {
      assert.match(`${error.stdout ?? ''}\n${error.stderr ?? ''}`, pattern);
      return true;
    },
  );
}

async function captureFailure(promise) {
  try {
    await promise;
    assert.fail('expected updater manifest generation to fail');
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    return error;
  }
}

function buildDirect(assetsDir, hooks = {}, options = {}) {
  return buildUpdaterManifest(
    {
      assetsDir,
      baseUrl: `https://example.test/releases/v${VERSION}`,
      outfile: options.outfile ?? path.join(assetsDir, 'latest.json'),
      pubDate: PUB_DATE,
      version: VERSION,
    },
    hooks,
  );
}

async function holdFileWithoutDeleteSharing(value) {
  const command = [
    '$stream = [System.IO.File]::Open(',
    '$env:VIBESPACE_TEST_LOCK_PATH,',
    '[System.IO.FileMode]::Open,',
    '[System.IO.FileAccess]::Read,',
    '[System.IO.FileShare]::ReadWrite',
    ');',
    "[Console]::Out.WriteLine('LOCKED');",
    '[Console]::Out.Flush();',
    '[Console]::In.ReadLine() | Out-Null;',
    '$stream.Dispose();',
  ].join(' ');
  const child = spawn('pwsh.exe', ['-NoProfile', '-Command', command], {
    env: { ...process.env, VIBESPACE_TEST_LOCK_PATH: value },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (!chunk.includes('LOCKED')) return;
      child.stdout.off('data', onData);
      child.off('error', reject);
      child.off('exit', onEarlyExit);
      resolve();
    };
    const onEarlyExit = (code) => {
      reject(new Error(`file-lock helper exited before locking (${code}): ${stderr}`));
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', onEarlyExit);
  });
  return async () => {
    child.stdin.end('\n');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
  };
}

test('selects deterministic version-bound artifacts for every updater platform', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, 'A-VibeSpace_9.9.9_aarch64.app.tar.gz');
    await addArtifact(assetsDir, 'A-VibeSpace_9.9.9_amd64.AppImage');
    await addArtifact(assetsDir, `VibeSpace_${VERSION}_amd64.AppImage`);
    await addArtifact(assetsDir, 'VibeSpace_aarch64.app.tar.gz');
    await addArtifact(assetsDir, 'VibeSpace_x64.app.tar.gz');
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);

    const first = await buildManifest(assetsDir);
    const second = await buildManifest(assetsDir, {
      outfile: path.join(assetsDir, 'latest-again.json'),
    });

    assert.deepEqual(Object.keys(first.manifest.platforms), [
      'windows-x86_64',
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-x86_64',
    ]);
    assert.equal(first.manifest.pub_date, PUB_DATE);
    assert.equal(
      first.manifest.platforms['windows-x86_64'].url,
      `https://example.test/releases/v${VERSION}/VibeSpace-${VERSION}-Windows-x64.exe`,
    );
    assert.equal(
      first.manifest.platforms['darwin-aarch64'].url,
      `https://example.test/releases/v${VERSION}/VibeSpace_aarch64.app.tar.gz`,
    );
    assert.equal(
      first.manifest.platforms['darwin-x86_64'].url,
      `https://example.test/releases/v${VERSION}/VibeSpace_x64.app.tar.gz`,
    );
    assert.equal(
      first.manifest.platforms['linux-x86_64'].url,
      `https://example.test/releases/v${VERSION}/VibeSpace_${VERSION}_amd64.AppImage`,
    );
    assert.equal(first.bytes, second.bytes);
  });
});

test('rejects artifacts for a different release version without writing a manifest', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, 'VibeSpace-9.9.9-Windows-x64.exe');

    await expectFailure(assetsDir, undefined, /no signed updater artifacts found/iu);
    await assert.rejects(readFile(path.join(assetsDir, 'latest.json'), 'utf8'), { code: 'ENOENT' });
  });
});

test('accepts only canonical SemVer values compatible with Tauri semver::Version', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, 'VibeSpace_0.0.0_x64-setup.exe');
    const valid = await buildManifest(assetsDir, { version: '0.0.0' });
    assert.equal(valid.manifest.version, '0.0.0');
    const prerelease = '1.2.3-alpha.1+build.01';
    await addArtifact(assetsDir, `VibeSpace_${prerelease}_x64-setup.exe`);
    const validPrerelease = await buildManifest(assetsDir, {
      outfile: path.join(assetsDir, 'prerelease.json'),
      version: prerelease,
    });
    assert.equal(validPrerelease.manifest.version, prerelease);

    for (const invalid of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-alpha..1',
      '1.2.3-alpha.',
      '1.2.3+build..1',
      '1.2.3+build.',
      '1.2.3-',
      '1.2.3+',
      '18446744073709551616.0.0',
    ]) {
      await expectFailure(assetsDir, { version: invalid }, /semantic version/u);
    }
  });
});

test('preserves explicit VibeSpace and legacy Jarvis naming variants', async () => {
  const variants = [
    ['windows-x86_64', `VibeSpace-${VERSION}-Windows-x64.exe`],
    ['windows-x86_64', `VibeSpace_${VERSION}_x64-setup.exe`],
    ['windows-x86_64', `Jarvis-One-${VERSION}-Windows-x64.exe`],
    ['windows-x86_64', `Jarvis One_${VERSION}_x64-setup.exe`],
    ['darwin-aarch64', `VibeSpace_${VERSION}_aarch64.app.tar.gz`],
    ['darwin-aarch64', 'VibeSpace_aarch64.app.tar.gz'],
    ['darwin-aarch64', `Jarvis One_${VERSION}_aarch64.app.tar.gz`],
    ['darwin-aarch64', `VibeSpace-${VERSION}-macOS-aarch64.tar.gz`],
    ['darwin-aarch64', `Jarvis-One-${VERSION}-macOS-aarch64.tar.gz`],
    ['darwin-x86_64', `VibeSpace_${VERSION}_x64.app.tar.gz`],
    ['darwin-x86_64', 'VibeSpace_x64.app.tar.gz'],
    ['darwin-x86_64', `Jarvis One_${VERSION}_x64.app.tar.gz`],
    ['darwin-x86_64', `VibeSpace-${VERSION}-macOS-x86_64.tar.gz`],
    ['darwin-x86_64', `Jarvis-One-${VERSION}-macOS-x86_64.tar.gz`],
    ['linux-x86_64', `VibeSpace_${VERSION}_amd64.AppImage`],
    ['linux-x86_64', `Jarvis One_${VERSION}_amd64.AppImage`],
    ['linux-x86_64', `VibeSpace-${VERSION}-Linux-x86_64.AppImage`],
    ['linux-x86_64', `Jarvis-One-${VERSION}-Linux-x86_64.AppImage`],
  ];

  for (const [platform, name] of variants) {
    await withAssets(async ({ assetsDir }) => {
      await addArtifact(assetsDir, name);
      const { manifest } = await buildManifest(assetsDir);
      assert.deepEqual(Object.keys(manifest.platforms), [platform], name);
      assert.equal(
        manifest.platforms[platform].url,
        `https://example.test/releases/v${VERSION}/${encodeURIComponent(name)}`,
        name,
      );
    });
  }
});

test('rejects ambiguous version-matched artifacts instead of using pattern or directory order', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    await addArtifact(assetsDir, `VibeSpace_${VERSION}_x64-setup.exe`);

    await expectFailure(assetsDir, undefined, /ambiguous windows-x86_64 artifacts/iu);
  });
});

test('requires a credential-free HTTPS base URL without query or fragment data', async () => {
  for (const baseUrl of [
    `http://example.test/releases/v${VERSION}`,
    `https://user:secret@example.test/releases/v${VERSION}`,
    `https://example.test/releases/v${VERSION}?token=secret`,
    `https://example.test/releases/v${VERSION}#fragment`,
  ]) {
    await withAssets(async ({ assetsDir }) => {
      await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
      const error = await captureFailure(
        execFileAsync(process.execPath, invocationArgs(assetsDir, { baseUrl })),
      );
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, /base URL must be a credential-free HTTPS URL/iu);
      assert.doesNotMatch(output, /user:secret|token=secret/iu);
    });
  }
});

test('fails when a recognized updater artifact has no regular signature file', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    await addArtifact(assetsDir, `VibeSpace_${VERSION}_aarch64.app.tar.gz`, null);

    await expectFailure(assetsDir, undefined, /missing signature.*aarch64\.app\.tar\.gz/iu);
  });
});

test('rejects empty and oversized signatures without logging their contents', async () => {
  const cases = [
    {
      signature: ' \r\n\t',
      pattern: /signature must be nonempty/iu,
    },
    {
      signature: `SIGNING_MATERIAL_MUST_NOT_BE_LOGGED_${'A'.repeat(16 * 1024)}`,
      pattern: /signature exceeds 16384 bytes/iu,
    },
  ];

  for (const { signature, pattern } of cases) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      await addArtifact(assetsDir, artifact, signature);
      const error = await captureFailure(
        execFileAsync(process.execPath, invocationArgs(assetsDir)),
      );
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, pattern);
      assert.doesNotMatch(output, /SIGNING_MATERIAL_MUST_NOT_BE_LOGGED/iu);
    });
  }
});

test('treats artifact and signature timestamps as non-authoritative metadata', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    await addArtifact(assetsDir, artifact);
    await utimes(
      path.join(assetsDir, artifact),
      new Date('2026-07-30T20:00:00.900Z'),
      new Date('2026-07-30T20:00:00.900Z'),
    );
    await utimes(
      path.join(assetsDir, `${artifact}.sig`),
      new Date('2026-07-30T20:00:00.100Z'),
      new Date('2026-07-30T20:00:00.100Z'),
    );

    const { manifest } = await buildManifest(assetsDir);
    assert.equal(
      manifest.platforms['windows-x86_64'].url,
      `https://example.test/releases/v${VERSION}/${artifact}`,
    );
  });
});

test('rejects deterministic signature replacement after its handle-bound read', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async afterSignatureRead({ signaturePath }) {
          await rename(signaturePath, `${signaturePath}.replaced`);
          await writeFile(signaturePath, SIGNATURE);
        },
      }),
      /identity or metadata changed/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
  });
});

test('detects same-size artifact byte mutation even when timestamps are restored', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const artifactPath = path.join(assetsDir, artifact);
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);
    const original = await readFile(artifactPath);
    const timestamp = new Date('2026-07-30T20:00:00.000Z');
    await utimes(artifactPath, timestamp, timestamp);

    await assert.rejects(
      buildDirect(assetsDir, {
        async afterSignatureRead() {
          const replacement = Buffer.alloc(original.length, 0x58);
          await writeFile(artifactPath, replacement);
          await utimes(artifactPath, timestamp, timestamp);
        },
      }),
      /artifact byte content changed/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
  });
});

test('detects same-size signature byte mutation even when timestamps are restored', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const signaturePath = path.join(assetsDir, `${artifact}.sig`);
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);
    const original = await readFile(signaturePath);
    const artifactTimestamp = new Date('2026-07-30T20:00:00.000Z');
    const timestamp = new Date('2026-07-30T20:00:01.000Z');
    await utimes(path.join(assetsDir, artifact), artifactTimestamp, artifactTimestamp);
    await utimes(signaturePath, timestamp, timestamp);

    await assert.rejects(
      buildDirect(assetsDir, {
        async afterSignatureRead() {
          const replacement = Buffer.alloc(original.length, 0x59);
          await writeFile(signaturePath, replacement);
          await utimes(signaturePath, timestamp, timestamp);
        },
      }),
      /signature byte content changed/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
  });
});

test('revalidates artifact, assets root, outfile parent, and target before publication', async () => {
  for (const mutation of ['artifact', 'assets', 'parent', 'target']) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const artifactPath = path.join(assetsDir, artifact);
      const outputParent = path.join(assetsDir, 'manifests');
      const outfile = path.join(outputParent, 'latest.json');
      const previous = '{"version":"previous"}\n';
      await mkdir(outputParent);
      await addArtifact(assetsDir, artifact);
      await writeFile(outfile, previous);

      await assert.rejects(
        buildDirect(
          assetsDir,
          {
            async beforePublish() {
              if (mutation === 'artifact') await writeFile(artifactPath, 'changed');
              if (mutation === 'assets') await writeFile(path.join(assetsDir, 'concurrent'), 'x');
              if (mutation === 'parent') {
                await writeFile(path.join(outputParent, 'concurrent'), 'x');
              }
              if (mutation === 'target') await writeFile(outfile, '{"version":"replaced"}\n');
            },
          },
          { outfile },
        ),
        /byte content changed|identity or metadata changed|path chain identity changed|outfile identity/iu,
      );
      assert.equal(
        await readFile(outfile, 'utf8'),
        mutation === 'target' ? '{"version":"replaced"}\n' : previous,
      );
    });
  }
});

test('rejects deterministic output-parent replacement before temporary creation', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outputParent = path.join(assetsDir, 'manifests');
    const replacedParent = path.join(assetsDir, 'manifests-replaced');
    const outfile = path.join(outputParent, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await mkdir(outputParent);
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(
        assetsDir,
        {
          async beforeTemporaryWrite() {
            await rename(outputParent, replacedParent);
            await mkdir(outputParent);
          },
        },
        { outfile },
      ),
      /identity(?: or metadata)? changed|EPERM|operation not permitted/iu,
    );
    try {
      assert.equal(await readFile(path.join(replacedParent, 'latest.json'), 'utf8'), previous);
      await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      assert.equal(await readFile(outfile, 'utf8'), previous);
    }
  });
});

test('rejects an intermediate outfile-parent junction swap instead of publishing outside assets', async () => {
  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const canonicalParent = path.join(assetsDir, 'manifests');
    const aliasRoot = path.join(root, 'alias-root');
    const displacedAlias = path.join(root, 'alias-root-original');
    const requestedAssetsDir = path.join(aliasRoot, 'assets');
    const outsideRoot = path.join(root, 'outside-root');
    const outsideParent = path.join(outsideRoot, 'assets', 'manifests');
    const outfile = path.join(requestedAssetsDir, 'manifests', 'latest.json');
    const outsideOutfile = path.join(outsideParent, 'latest.json');
    await mkdir(canonicalParent);
    await mkdir(outsideParent, { recursive: true });
    await symlink(root, aliasRoot, 'junction');
    await addArtifact(assetsDir, artifact);
    let hookRan = false;

    await assert.rejects(
      buildDirect(
        requestedAssetsDir,
        {
          async beforeTemporaryWrite() {
            hookRan = true;
            await rename(aliasRoot, displacedAlias);
            await symlink(outsideRoot, aliasRoot, 'junction');
          },
        },
        { outfile },
      ),
      (error) => {
        assert.equal(hookRan, true, 'the swap runs after initial secure binding');
        assert.match(error.message, /outfile parent path chain|identity changed/iu);
        return true;
      },
    );
    await assert.rejects(readFile(outsideOutfile, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(canonicalParent, 'latest.json'), 'utf8'), {
      code: 'ENOENT',
    });
  });
});

test('rejects a final-boundary outfile-parent junction swap and restores the prior manifest', async () => {
  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const canonicalParent = path.join(assetsDir, 'manifests');
    const aliasRoot = path.join(root, 'final-alias-root');
    const displacedAlias = path.join(root, 'final-alias-root-original');
    const requestedAssetsDir = path.join(aliasRoot, 'assets');
    const outsideRoot = path.join(root, 'final-outside-root');
    const outsideParent = path.join(outsideRoot, 'assets', 'manifests');
    const outfile = path.join(requestedAssetsDir, 'manifests', 'latest.json');
    const canonicalOutfile = path.join(canonicalParent, 'latest.json');
    const outsideOutfile = path.join(outsideParent, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await mkdir(canonicalParent);
    await mkdir(outsideParent, { recursive: true });
    await symlink(root, aliasRoot, 'junction');
    await addArtifact(assetsDir, artifact);
    await writeFile(canonicalOutfile, previous);

    await assert.rejects(
      buildDirect(
        requestedAssetsDir,
        {
          async beforeFinalPublish() {
            await rename(aliasRoot, displacedAlias);
            await symlink(outsideRoot, aliasRoot, 'junction');
          },
        },
        { outfile },
      ),
      /(?:assets directory|outfile parent) path chain identity changed/iu,
    );
    assert.equal(await readFile(canonicalOutfile, 'utf8'), previous);
    await assert.rejects(readFile(outsideOutfile, 'utf8'), { code: 'ENOENT' });
  });
});

test('verifies temporary manifest readback bytes before publication', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforePublish({ temporary }) {
          const original = await readFile(temporary);
          const timestamps = await stat(temporary);
          await writeFile(temporary, Buffer.alloc(original.length, 0x5a));
          await utimes(temporary, timestamps.atime, timestamps.mtime);
        },
      }),
      /temporary manifest byte content changed/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
  });
});

test('restores the known-good target and preserves a final-boundary conflicting target as residue', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    const conflicting = '{"version":"conflicting"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforeFinalPublish() {
          await writeFile(outfile, conflicting);
        },
      }),
      /target appeared or changed at the final publication boundary/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
    const residues = (await readdir(assetsDir)).filter((name) => name.includes('.conflict-'));
    assert.equal(residues.length, 1);
    assert.equal(await readFile(path.join(assetsDir, residues[0]), 'utf8'), conflicting);
  });
});

test('does not restore from a replaced backup pathname during rollback', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    const conflicting = '{"version":"conflicting"}\n';
    const attackerBackup = '{"version":"attacker-backup"}\n';
    let replacedBackup;
    let restoreHookRan = false;
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforeFinalPublish() {
          await writeFile(outfile, conflicting);
        },
        async beforeRestore({ backup }) {
          restoreHookRan = true;
          await rename(backup, `${backup}.bound-original`);
          await writeFile(backup, attackerBackup);
          replacedBackup = backup;
        },
      }),
      (error) => {
        assert.equal(restoreHookRan, true, 'rollback reaches the bound-backup validation seam');
        assert.match(
          error.message,
          /target appeared or changed at the final publication boundary|path chain identity changed/iu,
        );
        return true;
      },
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
    assert.equal(await readFile(replacedBackup, 'utf8'), attackerBackup);
  });
});

test('does not overwrite a target that appears at the final no-replace boundary', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const conflicting = '{"version":"conflicting"}\n';
    await addArtifact(assetsDir, artifact);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforeFinalPublish() {
          await writeFile(outfile, conflicting);
        },
      }),
      /target appeared or changed at the final publication boundary/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), conflicting);
  });
});

test('rolls back post-link target mutation with and without a prior manifest', async () => {
  for (const hasPrior of [true, false]) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const outfile = path.join(assetsDir, 'latest.json');
      const previous = '{"version":"previous"}\n';
      const attackerBytes = `{"version":"post-link-${hasPrior ? 'prior' : 'absent'}"}\n`;
      await addArtifact(assetsDir, artifact);
      if (hasPrior) await writeFile(outfile, previous);

      await assert.rejects(
        buildDirect(assetsDir, {
          async afterPublishLink() {
            await writeFile(outfile, attackerBytes);
          },
        }),
        /published manifest byte content changed at the final publication boundary/iu,
      );
      if (hasPrior) {
        assert.equal(await readFile(outfile, 'utf8'), previous);
      } else {
        await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
      }
      const conflicts = (await readdir(assetsDir)).filter((name) => name.includes('.conflict-'));
      assert.equal(conflicts.length, 1);
      assert.equal(await readFile(path.join(assetsDir, conflicts[0]), 'utf8'), attackerBytes);
    });
  }
});

test('revalidates artifact and signature bytes after both final publication hooks', async () => {
  for (const hasPrior of [true, false]) {
    for (const hookName of ['afterTargetLinked', 'afterPublishLink']) {
      for (const kind of ['artifact', 'signature']) {
        await withAssets(async ({ assetsDir }) => {
          const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
          const artifactPath = path.join(assetsDir, artifact);
          const mutationPath = kind === 'artifact' ? artifactPath : `${artifactPath}.sig`;
          const outfile = path.join(assetsDir, 'latest.json');
          const previous = '{"version":"previous"}\n';
          await addArtifact(assetsDir, artifact);
          if (hasPrior) await writeFile(outfile, previous);
          const original = await readFile(mutationPath);
          const timestamps = await stat(mutationPath);

          await assert.rejects(
            buildDirect(assetsDir, {
              async [hookName]() {
                await writeFile(mutationPath, Buffer.alloc(original.length, 0x53));
                await utimes(mutationPath, timestamps.atime, timestamps.mtime);
              },
            }),
            new RegExp(`${kind} byte content changed`, 'iu'),
          );
          if (hasPrior) {
            assert.equal(await readFile(outfile, 'utf8'), previous);
          } else {
            await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
          }
          assert.equal(
            (await readdir(assetsDir)).filter((name) => name.includes('.conflict-')).length,
            1,
          );
        });
      }
    }
  }
});

test('rejects byte-identical file and hardlink substitution after publication link', async () => {
  for (const substitution of ['file', 'hardlink']) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const outfile = path.join(assetsDir, 'latest.json');
      const previous = '{"version":"previous"}\n';
      await addArtifact(assetsDir, artifact);
      await writeFile(outfile, previous);

      await assert.rejects(
        buildDirect(assetsDir, {
          async afterPublishLink() {
            const proposed = await readFile(outfile);
            await rename(outfile, `${outfile}.linked-original`);
            if (substitution === 'file') {
              await writeFile(outfile, proposed);
            } else {
              const attacker = path.join(assetsDir, 'attacker-equal-bytes');
              await writeFile(attacker, proposed);
              await link(attacker, outfile);
              await unlink(attacker);
            }
          },
        }),
        /published manifest identity changed at the final publication boundary/iu,
      );
      assert.equal(await readFile(outfile, 'utf8'), previous);
    });
  }
});

test('rejects an outfile-parent junction swap after publication link', async () => {
  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const canonicalParent = path.join(assetsDir, 'manifests');
    const aliasRoot = path.join(root, 'post-link-alias');
    const displacedAlias = path.join(root, 'post-link-alias-original');
    const requestedAssetsDir = path.join(aliasRoot, 'assets');
    const outsideRoot = path.join(root, 'post-link-outside');
    const outsideParent = path.join(outsideRoot, 'assets', 'manifests');
    const requestedOutfile = path.join(requestedAssetsDir, 'manifests', 'latest.json');
    const canonicalOutfile = path.join(canonicalParent, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await mkdir(canonicalParent);
    await mkdir(outsideParent, { recursive: true });
    await symlink(root, aliasRoot, 'junction');
    await addArtifact(assetsDir, artifact);
    await writeFile(canonicalOutfile, previous);

    await assert.rejects(
      buildDirect(
        requestedAssetsDir,
        {
          async afterPublishLink() {
            await rename(aliasRoot, displacedAlias);
            await symlink(outsideRoot, aliasRoot, 'junction');
          },
        },
        { outfile: requestedOutfile },
      ),
      /(?:assets directory|outfile parent) path chain identity changed during manifest generation/iu,
    );
    assert.equal(await readFile(canonicalOutfile, 'utf8'), previous);
    await assert.rejects(readFile(path.join(outsideParent, 'latest.json'), 'utf8'), {
      code: 'ENOENT',
    });
  });
});

test('reports a valid commit truthfully when temporary unlink cleanup fails', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    let replacedTemporary;
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    const result = await buildDirect(assetsDir, {
      async afterPublishLink({ temporary }) {
        const moved = `${temporary}.bound-original`;
        await rename(temporary, moved);
        await unlink(moved);
        await mkdir(temporary);
        replacedTemporary = temporary;
      },
    });

    assert.equal(result.manifest.version, VERSION);
    assert.equal(JSON.parse(await readFile(outfile, 'utf8')).version, VERSION);
    assert.equal((await stat(replacedTemporary)).isDirectory(), true);
  });
});

test('preserves a regular-file replacement at the temporary cleanup pathname', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const attackerBytes = 'attacker-owned-regular-temp';
    let replacedTemporary;
    await addArtifact(assetsDir, artifact);

    const result = await buildDirect(assetsDir, {
      async afterPublishLink({ temporary }) {
        const moved = `${temporary}.bound-original`;
        await rename(temporary, moved);
        await unlink(moved);
        await writeFile(temporary, attackerBytes);
        replacedTemporary = temporary;
      },
    });

    assert.equal(result.manifest.version, VERSION);
    assert.equal(JSON.parse(await readFile(outfile, 'utf8')).version, VERSION);
    assert.equal(await readFile(replacedTemporary, 'utf8'), attackerBytes);
  });
});

windowsTest('truthfully commits when unlink fails for the verified owned temporary hardlink', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const artifactPath = path.join(assetsDir, artifact);
    const outfile = path.join(assetsDir, 'latest.json');
    let releaseLock;
    let temporary;
    await addArtifact(assetsDir, artifact);

    try {
      const result = await buildDirect(assetsDir, {
        async afterPublishLink(context) {
          temporary = context.temporary;
          releaseLock = await holdFileWithoutDeleteSharing(temporary);
        },
      });

      assert.equal(result.manifest.version, VERSION);
      assert.equal(JSON.parse(await readFile(outfile, 'utf8')).version, VERSION);
      assert.equal((await stat(outfile)).nlink, 2);
      assert.equal((await stat(temporary)).nlink, 2);
      assert.equal(
        (await readdir(assetsDir)).some((name) => name.includes('.transaction-')),
        true,
      );
    } finally {
      await releaseLock?.();
    }

    const committed = await readFile(outfile, 'utf8');
    await unlink(artifactPath);
    await unlink(`${artifactPath}.sig`);
    await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
    assert.equal(await readFile(outfile, 'utf8'), committed);
    assert.equal(
      (await readdir(assetsDir)).some(
        (name) => name.includes('.transaction-') || name.includes('.tmp'),
      ),
      false,
    );
  });
});

test('reports a valid commit truthfully when backup or displaced cleanup fails', async () => {
  for (const kind of ['backup', 'displaced']) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const outfile = path.join(assetsDir, 'latest.json');
      let cleanupHookRan = false;
      let replacedPath;
      await addArtifact(assetsDir, artifact);
      await writeFile(outfile, '{"version":"previous"}\n');

      const result = await buildDirect(assetsDir, {
        async beforeCleanup(paths) {
          cleanupHookRan = true;
          const selected = paths[kind];
          await rename(selected, `${selected}.bound-original`);
          await mkdir(selected);
          replacedPath = selected;
        },
      });

      assert.equal(cleanupHookRan, true, `${kind} cleanup hook ran`);
      assert.equal(result.manifest.version, VERSION);
      assert.equal(JSON.parse(await readFile(outfile, 'utf8')).version, VERSION);
      assert.equal((await stat(replacedPath)).isDirectory(), true);
    });
  }
});

test('rejects a writer-impossible displaced journal with no proposed manifest', async () => {
  await withAssets(async ({ assetsDir }) => {
    const transactionId = '11111111-1111-4111-8111-111111111111';
    const previous = '{"version":"previous"}\n';
    const outfile = path.join(assetsDir, 'latest.json');
    const backupName = `.latest.json.backup-${transactionId}`;
    const displacedName = `.latest.json.displaced-${transactionId}`;
    const journalName = `.latest.json.transaction-${transactionId}.json`;
    await writeFile(path.join(assetsDir, backupName), previous);
    await writeFile(path.join(assetsDir, displacedName), previous);
    await writeFile(
      path.join(assetsDir, journalName),
      `${JSON.stringify({
        schema: 1,
        state: 'displaced',
        target: 'latest.json',
        prior: {
          backup: backupName,
          displaced: displacedName,
          sha256: sha256(previous),
        },
        proposed: null,
      })}\n`,
    );

    await assert.rejects(
      buildDirect(assetsDir),
      /publication journal is not a supported displaced-target recovery record/iu,
    );
    await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
    for (const name of [backupName, displacedName, journalName]) {
      assert.equal((await stat(path.join(assetsDir, name))).isFile(), true);
    }
  });
});

test('fails closed on non-regular transaction journals', async () => {
  for (const kind of ['directory', 'junction']) {
    await withAssets(async ({ assetsDir, root }) => {
      const transactionId = '22222222-2222-4222-8222-222222222222';
      const journal = path.join(assetsDir, `.latest.json.transaction-${transactionId}.json`);
      if (kind === 'directory') {
        await mkdir(journal);
      } else {
        const target = path.join(root, 'journal-junction-target');
        await mkdir(target);
        await symlink(target, journal, 'junction');
      }

      await assert.rejects(buildDirect(assetsDir), /publication journal must be a regular file/iu);
    });
  }
});

test('fails closed on orphan updater publication residue without a journal', async () => {
  const transactionId = '33333333-3333-4333-8333-333333333333';
  const nextId = '44444444-4444-4444-8444-444444444444';
  for (const residue of [
    `.latest.json.backup-${transactionId}`,
    `.latest.json.displaced-${transactionId}`,
    `.latest.json.123.${transactionId}.tmp`,
    `.latest.json.transaction-${transactionId}.json.next-${nextId}`,
  ]) {
    await withAssets(async ({ assetsDir }) => {
      await writeFile(path.join(assetsDir, residue), 'orphan');

      await assert.rejects(
        buildDirect(assetsDir),
        /unresolved updater publication residue exists without a valid journal/iu,
      );
      assert.equal(await readFile(path.join(assetsDir, residue), 'utf8'), 'orphan');
    });
  }
});

test('writes a recoverable journal before an interruption after target displacement', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const artifactPath = path.join(assetsDir, artifact);
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async afterTargetDisplaced() {
          throw Object.assign(new Error('simulated publication interruption'), {
            simulateCrash: true,
          });
        },
      }),
      /simulated publication interruption/iu,
    );
    await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
    assert.equal(
      (await readdir(assetsDir)).some((name) => name.includes('.transaction-')),
      true,
    );

    await unlink(artifactPath);
    await unlink(`${artifactPath}.sig`);
    await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
    assert.equal(await readFile(outfile, 'utf8'), previous);
    assert.equal(
      (await readdir(assetsDir)).some(
        (name) =>
          name.includes('.transaction-') ||
          name.includes('.backup-') ||
          name.includes('.displaced-'),
      ),
      false,
    );
  });
});

test('recovers when interruption follows prior-target rename before displaced-state durability', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const artifactPath = path.join(assetsDir, artifact);
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async afterTargetRenameBeforeJournal() {
          throw Object.assign(new Error('simulated rename-to-journal interruption'), {
            simulateCrash: true,
          });
        },
      }),
      /simulated rename-to-journal interruption/iu,
    );
    await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });

    await unlink(artifactPath);
    await unlink(`${artifactPath}.sig`);
    await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
    assert.equal(await readFile(outfile, 'utf8'), previous);
    assert.equal(
      (await readdir(assetsDir)).some(
        (name) =>
          name.includes('.transaction-') ||
          name.includes('.backup-') ||
          name.includes('.displaced-') ||
          name.includes('.tmp'),
      ),
      false,
    );
  });
});

test('admits a bound target when interruption follows link before linked-state durability', async () => {
  for (const hasPrior of [true, false]) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const artifactPath = path.join(assetsDir, artifact);
      const outfile = path.join(assetsDir, 'latest.json');
      await addArtifact(assetsDir, artifact);
      if (hasPrior) await writeFile(outfile, '{"version":"previous"}\n');

      await assert.rejects(
        buildDirect(assetsDir, {
          async afterTargetLinkBeforeJournal() {
            throw Object.assign(new Error('simulated link-to-journal interruption'), {
              simulateCrash: true,
            });
          },
        }),
        /simulated link-to-journal interruption/iu,
      );
      const committed = await readFile(outfile, 'utf8');
      assert.equal(JSON.parse(committed).version, VERSION);

      await unlink(artifactPath);
      await unlink(`${artifactPath}.sig`);
      await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
      assert.equal(await readFile(outfile, 'utf8'), committed);
      assert.equal(
        (await readdir(assetsDir)).some(
          (name) =>
            name.includes('.transaction-') ||
            name.includes('.backup-') ||
            name.includes('.displaced-') ||
            name.includes('.tmp'),
        ),
        false,
      );
    });
  }
});

test('admits a journal-bound commit after interruption at the linked state', async () => {
  for (const hasPrior of [true, false]) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const artifactPath = path.join(assetsDir, artifact);
      const outfile = path.join(assetsDir, 'latest.json');
      await addArtifact(assetsDir, artifact);
      if (hasPrior) await writeFile(outfile, '{"version":"previous"}\n');

      await assert.rejects(
        buildDirect(assetsDir, {
          async afterTargetLinked() {
            throw Object.assign(new Error('simulated linked-state interruption'), {
              simulateCrash: true,
            });
          },
        }),
        /simulated linked-state interruption/iu,
      );
      const committed = await readFile(outfile, 'utf8');
      assert.equal(JSON.parse(committed).version, VERSION);
      assert.equal(
        (await readdir(assetsDir)).some((name) => name.includes('.transaction-')),
        true,
      );

      await unlink(artifactPath);
      await unlink(`${artifactPath}.sig`);
      await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
      assert.equal(await readFile(outfile, 'utf8'), committed);
      assert.equal(
        (await readdir(assetsDir)).some(
          (name) =>
            name.includes('.transaction-') ||
            name.includes('.tmp') ||
            name.includes('.backup-') ||
            name.includes('.displaced-'),
        ),
        false,
      );
    });
  }
});

test('recovers journal-bound prepared state with and without a prior manifest', async () => {
  for (const hasPrior of [true, false]) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const artifactPath = path.join(assetsDir, artifact);
      const outfile = path.join(assetsDir, 'latest.json');
      const previous = '{"version":"previous"}\n';
      await addArtifact(assetsDir, artifact);
      if (hasPrior) await writeFile(outfile, previous);

      await assert.rejects(
        buildDirect(assetsDir, {
          async afterJournalPrepared() {
            throw Object.assign(new Error('simulated prepared-state interruption'), {
              simulateCrash: true,
            });
          },
        }),
        /simulated prepared-state interruption/iu,
      );
      assert.equal(
        (await readdir(assetsDir)).some((name) => name.includes('.transaction-')),
        true,
      );

      await unlink(artifactPath);
      await unlink(`${artifactPath}.sig`);
      await assert.rejects(buildDirect(assetsDir), /no signed updater artifacts found/iu);
      if (hasPrior) {
        assert.equal(await readFile(outfile, 'utf8'), previous);
      } else {
        await assert.rejects(readFile(outfile, 'utf8'), { code: 'ENOENT' });
      }
      assert.equal(
        (await readdir(assetsDir)).some(
          (name) => name.includes('.transaction-') || name.includes('.backup-'),
        ),
        false,
      );
    });
  }
});

test('re-hashes temporary bytes at the final boundary before linking them into place', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforeFinalPublish({ temporary }) {
          const original = await readFile(temporary);
          const timestamps = await stat(temporary);
          await writeFile(temporary, Buffer.alloc(original.length, 0x51));
          await utimes(temporary, timestamps.atime, timestamps.mtime);
        },
      }),
      /temporary manifest byte content changed/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
  });
});

test('re-hashes artifact and signature bytes at the final boundary before publication', async () => {
  for (const kind of ['artifact', 'signature']) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const artifactPath = path.join(assetsDir, artifact);
      const mutationPath = kind === 'artifact' ? artifactPath : `${artifactPath}.sig`;
      const outfile = path.join(assetsDir, 'latest.json');
      const previous = '{"version":"previous"}\n';
      await addArtifact(assetsDir, artifact);
      await writeFile(outfile, previous);
      const original = await readFile(mutationPath);
      const artifactTimestamp = new Date('2026-07-30T20:00:00.000Z');
      const signatureTimestamp = new Date('2026-07-30T20:00:01.000Z');
      await utimes(artifactPath, artifactTimestamp, artifactTimestamp);
      await utimes(`${artifactPath}.sig`, signatureTimestamp, signatureTimestamp);

      await assert.rejects(
        buildDirect(assetsDir, {
          async beforeFinalPublish() {
            await writeFile(mutationPath, Buffer.alloc(original.length, 0x52));
            const timestamp = kind === 'artifact' ? artifactTimestamp : signatureTimestamp;
            await utimes(mutationPath, timestamp, timestamp);
          },
        }),
        new RegExp(`${kind} byte content changed`, 'iu'),
      );
      assert.equal(await readFile(outfile, 'utf8'), previous);
    });
  }
});

test('preserves an attacker-replaced temporary path instead of deleting it during cleanup', async () => {
  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    const outfile = path.join(assetsDir, 'latest.json');
    const previous = '{"version":"previous"}\n';
    const attackerBytes = 'attacker-owned-temp';
    let temporary;
    await addArtifact(assetsDir, artifact);
    await writeFile(outfile, previous);

    await assert.rejects(
      buildDirect(assetsDir, {
        async beforePublish(context) {
          temporary = context.temporary;
          await rename(temporary, `${temporary}.bound-original`);
          await writeFile(temporary, attackerBytes);
        },
      }),
      /temporary manifest identity or metadata changed|outfile parent (?:path chain identity changed|identity or metadata changed)/iu,
    );
    assert.equal(await readFile(outfile, 'utf8'), previous);
    assert.equal(await readFile(temporary, 'utf8'), attackerBytes);
  });
});

test('rejects malformed Tauri signature content without replacing an existing manifest', async () => {
  const invalidSignatures = [
    'SIGNING_MATERIAL_MUST_NOT_BE_LOGGED',
    Buffer.from('not a minisign signature', 'utf8').toString('base64'),
    '/w==',
  ];

  for (const signature of invalidSignatures) {
    await withAssets(async ({ assetsDir }) => {
      const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
      const outfile = path.join(assetsDir, 'latest.json');
      const previousManifest = '{"version":"previous"}\n';
      await addArtifact(assetsDir, artifact, signature);
      await writeFile(outfile, previousManifest);

      const error = await captureFailure(
        execFileAsync(process.execPath, invocationArgs(assetsDir)),
      );
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
      assert.match(output, /signature is not a valid Tauri updater signature/iu);
      assert.doesNotMatch(output, /SIGNING_MATERIAL_MUST_NOT_BE_LOGGED/iu);
      assert.equal(await readFile(outfile, 'utf8'), previousManifest);
    });
  }
});

test('documents structural Minisign parsing as non-cryptographic validation', async () => {
  const source = await readFile(script, 'utf8');
  assert.match(source, /validates only the serialized Tauri\/Minisign record structure/iu);
  assert.match(source, /does not cryptographically verify the signature/iu);
  assert.match(source, /Tauri client remains the cryptographic verification boundary/iu);
});

test('rejects matching directories and symlinks rather than ignoring or following them', async () => {
  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    await mkdir(path.join(assetsDir, `VibeSpace_${VERSION}_amd64.AppImage`));

    await expectFailure(assetsDir, undefined, /linux-x86_64 artifact must be a regular file/iu);
  });

  await withAssets(async ({ assetsDir, root }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    const target = path.join(root, 'mac-archive');
    await mkdir(target);
    await symlink(
      target,
      path.join(assetsDir, `VibeSpace_${VERSION}_aarch64.app.tar.gz`),
      'junction',
    );

    await expectFailure(assetsDir, undefined, /darwin-aarch64 artifact must be a regular file/iu);
  });

  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    await writeFile(path.join(assetsDir, artifact), 'installer');
    const target = path.join(root, 'signature');
    await mkdir(target);
    await symlink(target, path.join(assetsDir, `${artifact}.sig`), 'junction');

    await expectFailure(assetsDir, undefined, /signature must be a regular file/iu);
  });
});

test('rejects multiply linked artifact and signature identities', async () => {
  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    await addArtifact(assetsDir, artifact);
    await link(path.join(assetsDir, artifact), path.join(root, 'artifact-link'));
    await expectFailure(assetsDir, undefined, /artifact must not be multiply linked/iu);
  });

  await withAssets(async ({ assetsDir, root }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    await addArtifact(assetsDir, artifact);
    await link(path.join(assetsDir, `${artifact}.sig`), path.join(root, 'signature-link'));
    await expectFailure(assetsDir, undefined, /signature must not be multiply linked/iu);
  });
});

test('contains atomic output inside assets and rejects an existing output symlink', async () => {
  await withAssets(async ({ assetsDir, root }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    const outside = path.join(root, 'outside.json');

    await expectFailure(assetsDir, { outfile: outside }, /outfile must be contained/iu);
    await assert.rejects(readFile(outside, 'utf8'), { code: 'ENOENT' });
  });

  await withAssets(async ({ assetsDir }) => {
    const artifact = `VibeSpace-${VERSION}-Windows-x64.exe`;
    await addArtifact(assetsDir, artifact);

    await expectFailure(
      assetsDir,
      { outfile: path.join(assetsDir, artifact) },
      /outfile must have a \.json extension/iu,
    );
    assert.equal(await readFile(path.join(assetsDir, artifact), 'utf8'), `artifact:${artifact}`);
  });

  await withAssets(async ({ assetsDir, root }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, path.join(assetsDir, 'latest.json'), 'junction');

    await expectFailure(assetsDir, undefined, /outfile must not be a symbolic link/iu);
  });

  await withAssets(async ({ assetsDir, root }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, 'do-not-overwrite');
    await link(outside, path.join(assetsDir, 'latest.json'));

    await expectFailure(assetsDir, undefined, /outfile must not be multiply linked/iu);
    assert.equal(await readFile(outside, 'utf8'), 'do-not-overwrite');
  });

  await withAssets(async ({ assetsDir }) => {
    await addArtifact(assetsDir, `VibeSpace-${VERSION}-Windows-x64.exe`);
    const { stderr, stdout } = await buildManifest(assetsDir);
    const names = await readdir(assetsDir);

    assert.equal(
      names.some(
        (name) =>
          name.includes('.tmp') || name.includes('.backup-') || name.includes('.displaced-'),
      ),
      false,
    );
    assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(SIGNATURE, 'u'));
  });
});
