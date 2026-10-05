import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsPromises, {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  measureTree,
  prepareSiyuanRuntime,
  sha256File,
  validateExtractedClosure,
  validatePackagedClosure,
} from './prepare-siyuan-runtime.mjs';

const sevenZip = process.env.VIBESPACE_7Z_PATH ?? 'C:\\Program Files\\7-Zip\\7z.exe';

async function withInstallerFixture(run, fault) {
  return withFixture(async (fixture) => {
    const outer = path.join(fixture.root, 'installer-contents');
    const pluginDir = path.join(outer, '$PLUGINSDIR');
    const payload = path.join(pluginDir, 'app-64.7z');
    await mkdir(pluginDir, { recursive: true });
    const guidePath = path.join('resources', 'guide', 'inside.md');
    await mkdir(path.dirname(path.join(fixture.extracted, guidePath)), { recursive: true });
    await writeFile(path.join(fixture.extracted, guidePath), 'pinned inner guide');
    const component = {
      id: 'guide',
      path: 'resources/guide',
      ...(await measureTree(fixture.extracted, 'resources/guide')),
    };
    fixture.closure.closure.components.push(component);
    fixture.closure.closure.fileCount += component.files;
    fixture.closure.closure.uncompressedBytes += component.bytes;
    if (fault === 'corrupt') {
      await writeFile(payload, 'not a 7z application payload');
    } else if (fault !== 'missing') {
      if (fault === 'mutated') {
        await writeFile(
          path.join(fixture.extracted, 'resources', 'kernel', 'kernel.exe'),
          'changed inner kernel',
        );
      }
      execFileSync(sevenZip, ['a', '-t7z', payload, 'resources', 'LICENSE'], {
        cwd: fixture.extracted,
        windowsHide: true,
        stdio: 'pipe',
        timeout: 10000,
      });
    }
    // Loose NSIS guide videos are outside the pinned app-64.7z closure.
    const videoPath = path.join('resources', 'guide', 'assets', 'outer-only.mp4');
    await mkdir(path.dirname(path.join(outer, videoPath)), { recursive: true });
    await writeFile(path.join(outer, videoPath), 'opaque envelope-only video');
    const installer = path.join(fixture.root, 'fixture.exe');
    execFileSync(sevenZip, ['a', '-t7z', installer, '$PLUGINSDIR', 'resources'], {
      cwd: outer,
      windowsHide: true,
      stdio: 'pipe',
      timeout: 10000,
    });
    fixture.closure.source.installerBytes = (await stat(installer)).size;
    fixture.closure.source.installerSha256 = await sha256File(installer);
    await writeFile(fixture.closurePath, JSON.stringify(fixture.closure));
    const cacheDir = path.join(fixture.root, 'owned-cache');
    await mkdir(cacheDir);
    const options = {
      installerPath: installer,
      sevenZipPath: sevenZip,
      cacheDir,
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    };
    return run({ ...fixture, installer, cacheDir, options });
  });
}

test(
  'verified installer uses the complete inner closure without mixing outer guide assets',
  { skip: process.platform !== 'win32' },
  async () => {
    await withInstallerFixture(async (fixture) => {
      const result = await prepareSiyuanRuntime(fixture.options);
      assert.equal(result.reused, false);
      await validatePackagedClosure(fixture.outputDir, fixture.closure);
      assert.equal(
        await readFile(path.join(fixture.outputDir, 'kernel', 'kernel.exe'), 'utf8'),
        'kernel',
      );
      assert.equal(
        await readFile(path.join(fixture.outputDir, 'guide', 'inside.md'), 'utf8'),
        'pinned inner guide',
      );
      await assert.rejects(
        stat(path.join(fixture.outputDir, 'guide', 'assets', 'outer-only.mp4')),
        { code: 'ENOENT' },
      );
      assert.deepEqual(await readdir(fixture.cacheDir), []);
    });
  },
);

test(
  'installer fingerprint mismatch fails before creating an extraction directory',
  { skip: process.platform !== 'win32' },
  async () => {
    await withInstallerFixture(async (fixture) => {
      fixture.closure.source.installerSha256 = '0'.repeat(64);
      await writeFile(fixture.closurePath, JSON.stringify(fixture.closure));
      await assert.rejects(prepareSiyuanRuntime(fixture.options), /installer SHA-256/u);
      assert.deepEqual(await readdir(fixture.cacheDir), []);
      await assert.rejects(stat(fixture.outputDir), { code: 'ENOENT' });
    });
  },
);

for (const fault of ['missing', 'corrupt']) {
  test(
    `rejects ${fault} nested payload and removes only its own extraction directory`,
    { skip: process.platform !== 'win32' },
    async () => {
      await withInstallerFixture(async (fixture) => {
        await writeFile(path.join(fixture.cacheDir, 'peer-cache.txt'), 'preserve peer cache');
        await assert.rejects(
          prepareSiyuanRuntime(fixture.options),
          fault === 'missing' ? /nested application archive/u : /Command failed/u,
        );
        assert.deepEqual(await readdir(fixture.cacheDir), ['peer-cache.txt']);
        await assert.rejects(stat(fixture.outputDir), { code: 'ENOENT' });
      }, fault);
    },
  );
}

test(
  'verified envelope with mutated inner bytes still fails the pinned component closure',
  { skip: process.platform !== 'win32' },
  async () => {
    await withInstallerFixture(async (fixture) => {
      await assert.rejects(
        prepareSiyuanRuntime(fixture.options),
        /component verification failed: kernel/u,
      );
      assert.deepEqual(await readdir(fixture.cacheDir), []);
      await assert.rejects(stat(fixture.outputDir), { code: 'ENOENT' });
    }, 'mutated');
  },
);

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vibespace-siyuan-prepare-'));
  try {
    const extracted = path.join(root, 'extracted');
    const outputParent = path.join(root, 'output');
    await mkdir(path.join(extracted, 'resources', 'kernel'), { recursive: true });
    await mkdir(path.join(extracted, 'resources', 'stage'), { recursive: true });
    await mkdir(outputParent);
    await writeFile(path.join(extracted, 'resources', 'kernel', 'kernel.exe'), 'kernel');
    await writeFile(path.join(extracted, 'resources', 'stage', 'index.html'), '<main>stage</main>');
    await writeFile(path.join(extracted, 'LICENSE'), 'AGPL fixture');
    const componentInputs = [
      ['kernel', 'resources/kernel'],
      ['stage', 'resources/stage'],
      ['license', 'LICENSE'],
    ];
    const components = [];
    for (const [id, componentPath] of componentInputs) {
      components.push({
        id,
        path: componentPath,
        ...(await measureTree(extracted, componentPath)),
      });
    }
    const closure = {
      schemaVersion: 1,
      source: {
        tag: 'v-fixture',
        commitSha: 'a'.repeat(40),
        installerName: 'fixture.exe',
        installerBytes: 1,
        installerSha256: 'b'.repeat(64),
      },
      closure: {
        status: 'derived-not-bundled',
        uncompressedBytes: components.reduce((sum, component) => sum + component.bytes, 0),
        fileCount: components.reduce((sum, component) => sum + component.files, 0),
        components,
        criticalBinaries: [],
      },
    };
    const closurePath = path.join(root, 'closure.json');
    const manifestPath = path.join(root, 'manifest.json');
    const sourceOfferPath = path.join(root, 'source-offer.md');
    await writeFile(closurePath, JSON.stringify(closure));
    await writeFile(
      manifestPath,
      JSON.stringify({ runtime: { tag: 'v-fixture', commitSha: 'a'.repeat(40) } }),
    );
    await writeFile(sourceOfferPath, 'Fixture source offer');
    return await run({
      root,
      extracted,
      outputParent,
      outputDir: path.join(outputParent, 'runtime'),
      closure,
      closurePath,
      manifestPath,
      sourceOfferPath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('measures a deterministic path-bound tree digest', async () => {
  await withFixture(async ({ extracted }) => {
    const measured = await measureTree(extracted, 'resources/kernel');
    const fileSha = createHash('sha256').update('kernel').digest('hex');
    const expected = createHash('sha256')
      .update(`resources/kernel/kernel.exe\0${Buffer.byteLength('kernel')}\0${fileSha}\n`)
      .digest('hex');
    assert.equal(measured.treeSha256, expected);
  });
});

test('validates and atomically materializes only the measured closure', async () => {
  await withFixture(async (fixture) => {
    await validateExtractedClosure(fixture.extracted, fixture.closure);
    const result = await prepareSiyuanRuntime({
      sourceDir: fixture.extracted,
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    });
    assert.equal(result.reused, false);
    await validatePackagedClosure(fixture.outputDir, fixture.closure);
    assert.equal(
      await readFile(path.join(fixture.outputDir, 'kernel', 'kernel.exe'), 'utf8'),
      'kernel',
    );
    assert.equal(
      await readFile(path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_SOURCE_OFFER.md'), 'utf8'),
      'Fixture source offer',
    );

    const reused = await prepareSiyuanRuntime({
      sourceDir: path.join(fixture.root, 'does-not-exist'),
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    });
    assert.equal(reused.reused, true);
  });
});

test('refreshes copied metadata only after the prepared closure and ready authority verify', async () => {
  await withFixture(async (fixture) => {
    await prepareSiyuanRuntime({
      sourceDir: fixture.extracted,
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    });
    const updatedManifest = JSON.stringify({
      runtime: { tag: 'v-fixture', commitSha: 'a'.repeat(40) },
      packaging: { runtimeBundled: true },
    });
    await writeFile(fixture.manifestPath, updatedManifest);
    await writeFile(fixture.sourceOfferPath, 'Updated fixture source offer');

    const result = await prepareSiyuanRuntime({
      sourceDir: path.join(fixture.root, 'must-not-be-read'),
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    });

    assert.equal(result.reused, true);
    assert.equal(
      await readFile(path.join(fixture.outputDir, 'siyuan-runtime-manifest.json'), 'utf8'),
      updatedManifest,
    );
    assert.equal(
      await readFile(path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_SOURCE_OFFER.md'), 'utf8'),
      'Updated fixture source offer',
    );
    await validatePackagedClosure(fixture.outputDir, fixture.closure);
  });
});

test('rejects ready-marker drift without refreshing or rebuilding the existing output', async () => {
  await withFixture(async (fixture) => {
    await prepareSiyuanRuntime({
      sourceDir: fixture.extracted,
      outputDir: fixture.outputDir,
      allowedOutputParent: fixture.outputParent,
      closureManifestPath: fixture.closurePath,
      runtimeManifestPath: fixture.manifestPath,
      sourceOfferPath: fixture.sourceOfferPath,
    });
    const readyPath = path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_READY.json');
    const ready = JSON.parse(await readFile(readyPath, 'utf8'));
    await writeFile(readyPath, JSON.stringify({ ...ready, fingerprint: '0'.repeat(64) }));

    await assert.rejects(
      prepareSiyuanRuntime({
        sourceDir: path.join(fixture.root, 'must-not-be-read'),
        outputDir: fixture.outputDir,
        allowedOutputParent: fixture.outputParent,
        closureManifestPath: fixture.closurePath,
        runtimeManifestPath: fixture.manifestPath,
        sourceOfferPath: fixture.sourceOfferPath,
      }),
      /exists but is not the verified closure/u,
    );
    assert.equal(JSON.parse(await readFile(readyPath, 'utf8')).fingerprint, '0'.repeat(64));
  });
});

test('rejects a mutated upstream component before materialization', async () => {
  await withFixture(async (fixture) => {
    await writeFile(path.join(fixture.extracted, 'resources', 'kernel', 'kernel.exe'), 'mutated');
    await assert.rejects(
      validateExtractedClosure(fixture.extracted, fixture.closure),
      /component verification failed: kernel/u,
    );
  });
});

test('refuses an output path outside the exact allowed parent', async () => {
  await withFixture(async (fixture) => {
    await assert.rejects(
      prepareSiyuanRuntime({
        sourceDir: fixture.extracted,
        outputDir: path.join(fixture.outputParent, 'nested', 'runtime'),
        allowedOutputParent: fixture.outputParent,
        closureManifestPath: fixture.closurePath,
        runtimeManifestPath: fixture.manifestPath,
        sourceOfferPath: fixture.sourceOfferPath,
      }),
      /must be one exact direct child/u,
    );
  });
});

test('fails instead of overwriting an unverified existing output', async () => {
  await withFixture(async (fixture) => {
    await mkdir(fixture.outputDir);
    await writeFile(path.join(fixture.outputDir, 'unexpected.txt'), 'preserve me');
    await assert.rejects(
      prepareSiyuanRuntime({
        sourceDir: fixture.extracted,
        outputDir: fixture.outputDir,
        allowedOutputParent: fixture.outputParent,
        closureManifestPath: fixture.closurePath,
        runtimeManifestPath: fixture.manifestPath,
        sourceOfferPath: fixture.sourceOfferPath,
      }),
      /exists but is not the verified closure/u,
    );
    assert.equal(
      await readFile(path.join(fixture.outputDir, 'unexpected.txt'), 'utf8'),
      'preserve me',
    );
  });
});

function preparationOptions(fixture) {
  return {
    sourceDir: fixture.extracted,
    outputDir: fixture.outputDir,
    allowedOutputParent: fixture.outputParent,
    closureManifestPath: fixture.closurePath,
    runtimeManifestPath: fixture.manifestPath,
    sourceOfferPath: fixture.sourceOfferPath,
  };
}

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

for (const destination of ['outside', 'inside']) {
  test(`output confinement: rejects a prepared directory link ${destination} its parent`, async () => {
    await withFixture(async (fixture) => {
      const options = preparationOptions(fixture);
      await prepareSiyuanRuntime(options);
      const target = path.join(
        destination === 'outside' ? fixture.root : fixture.outputParent,
        'retained-runtime',
      );
      await rename(fixture.outputDir, target);
      await symlink(target, fixture.outputDir, directoryLinkType);
      const link = await readlink(fixture.outputDir);
      const before = await measureTree(target, '.');
      await writeFile(fixture.sourceOfferPath, 'Must not replace retained source offer');

      await assert.rejects(
        prepareSiyuanRuntime({
          ...options,
          sourceDir: path.join(fixture.root, 'must-not-be-read'),
        }),
        /symlink|junction|physical directory/iu,
      );
      assert.equal((await lstat(fixture.outputDir)).isSymbolicLink(), true);
      assert.equal(await readlink(fixture.outputDir), link);
      assert.deepEqual(await measureTree(target, '.'), before);
    });
  });
}

test('output confinement: rejects a dangling output link without materializing or removing it', async () => {
  await withFixture(async (fixture) => {
    const target = path.join(fixture.root, 'missing-runtime');
    await symlink(target, fixture.outputDir, directoryLinkType);
    const link = await readlink(fixture.outputDir);

    await assert.rejects(
      prepareSiyuanRuntime(preparationOptions(fixture)),
      /symlink|junction|physical directory/iu,
    );
    assert.equal((await lstat(fixture.outputDir)).isSymbolicLink(), true);
    assert.equal(await readlink(fixture.outputDir), link);
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    assert.deepEqual(await readdir(fixture.outputParent), ['runtime']);
  });
});

for (const prepared of [true, false]) {
  test(`output confinement: rejects a linked allowed parent with ${prepared ? 'existing' : 'absent'} output`, async () => {
    await withFixture(async (fixture) => {
      const options = preparationOptions(fixture);
      if (prepared) await prepareSiyuanRuntime(options);
      const target = path.join(fixture.root, 'retained-output-parent');
      await rename(fixture.outputParent, target);
      await symlink(target, fixture.outputParent, directoryLinkType);
      const link = await readlink(fixture.outputParent);
      const before = await measureTree(target, '.');
      await writeFile(fixture.sourceOfferPath, 'Must not write through linked parent');

      await assert.rejects(prepareSiyuanRuntime(options), /symlink|junction|physical directory/iu);
      assert.equal(await readlink(fixture.outputParent), link);
      assert.deepEqual(await measureTree(target, '.'), before);
    });
  });
}

test('output confinement: rejects a linked ancestor of the allowed parent before reuse', async () => {
  await withFixture(async (fixture) => {
    await prepareSiyuanRuntime(preparationOptions(fixture));
    const target = path.join(fixture.root, 'retained-tree');
    await mkdir(target);
    await rename(fixture.outputParent, path.join(target, 'output'));
    const alias = path.join(fixture.root, 'linked-tree');
    await symlink(target, alias, directoryLinkType);
    const allowedOutputParent = path.join(alias, 'output');
    const before = await measureTree(target, '.');
    await writeFile(fixture.sourceOfferPath, 'Must not write through linked ancestor');

    await assert.rejects(
      prepareSiyuanRuntime({
        ...preparationOptions(fixture),
        allowedOutputParent,
        outputDir: path.join(allowedOutputParent, 'runtime'),
      }),
      /symlink|junction|physical directory/iu,
    );
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.deepEqual(await measureTree(target, '.'), before);
  });
});

test('output confinement: failed materialization cleans only its ordinary owned stage', async () => {
  await withFixture(async (fixture) => {
    // Both source components are valid, but they map to the same packaged filename.
    await writeFile(path.join(fixture.extracted, 'resources', 'LICENSE'), 'AGPL fixture');
    const component = {
      id: 'duplicate-license',
      path: 'resources/LICENSE',
      ...(await measureTree(fixture.extracted, 'resources/LICENSE')),
    };
    fixture.closure.closure.components.push(component);
    fixture.closure.closure.uncompressedBytes += component.bytes;
    fixture.closure.closure.fileCount += component.files;
    await writeFile(fixture.closurePath, JSON.stringify(fixture.closure));
    await writeFile(path.join(fixture.outputParent, 'peer.txt'), 'preserve peer output');

    await assert.rejects(prepareSiyuanRuntime(preparationOptions(fixture)), {
      code: 'ERR_FS_CP_EEXIST',
    });
    assert.deepEqual(await readdir(fixture.outputParent), ['peer.txt']);
    assert.equal(
      await readFile(path.join(fixture.outputParent, 'peer.txt'), 'utf8'),
      'preserve peer output',
    );
    await assert.rejects(lstat(fixture.outputDir), { code: 'ENOENT' });
  });
});

// Hold a real filesystem operation's continuation; all mutation stays in the fixture.
async function withFsContinuation(method, afterOperation, run) {
  const original = fsPromises[method];
  fsPromises[method] = async (...args) => {
    const result = await original(...args);
    await afterOperation(...args);
    return result;
  };
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    fsPromises[method] = original;
    syncBuiltinESMExports();
  }
}

for (const replacement of ['link', 'directory', 'missing']) {
  test(`output identity: rejects ${replacement} replacement during an awaited metadata read`, async () => {
    await withFixture(async (fixture) => {
      const options = preparationOptions(fixture);
      await prepareSiyuanRuntime(options);
      const before = await measureTree(fixture.outputDir, '.');
      const retained = path.join(fixture.root, 'retained-runtime');
      await writeFile(fixture.sourceOfferPath, 'Must not refresh a replaced output');
      let replaced = false;
      let error;
      await withFsContinuation(
        'readFile',
        async (target) => {
          if (replaced || target !== path.join(fixture.outputDir, 'siyuan-runtime-manifest.json'))
            return;
          replaced = true;
          await rename(fixture.outputDir, retained);
          if (replacement === 'link') {
            await symlink(retained, fixture.outputDir, directoryLinkType);
          } else if (replacement === 'directory') {
            await cp(retained, fixture.outputDir, { recursive: true, force: false });
          }
        },
        async () => {
          try {
            await prepareSiyuanRuntime(options);
          } catch (caught) {
            error = caught;
          }
        },
      );

      assert.equal(replaced, true, 'the held metadata read must actually run');
      assert.deepEqual(await measureTree(retained, '.'), before);
      if (replacement === 'missing') {
        await assert.rejects(lstat(fixture.outputDir), { code: 'ENOENT' });
        assert.deepEqual(await readdir(fixture.outputParent), []);
      } else {
        assert.deepEqual(
          await measureTree(replacement === 'link' ? retained : fixture.outputDir, '.'),
          before,
        );
        if (replacement === 'link')
          assert.equal((await lstat(fixture.outputDir)).isSymbolicLink(), true);
      }
      assert.ok(error, 'replacement must reject instead of returning verified reuse or rebuilding');
    });
  });
}

test('output identity: rejects replacement during the last unchanged metadata read', async () => {
  await withFixture(async (fixture) => {
    const options = preparationOptions(fixture);
    await prepareSiyuanRuntime(options);
    const before = await measureTree(fixture.outputDir, '.');
    const retained = path.join(fixture.root, 'retained-runtime');
    let reads = 0;
    let error;
    await withFsContinuation(
      'readFile',
      async (target) => {
        if (target !== path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_READY.json')) return;
        reads += 1;
        if (reads !== 2) return; // First read verifies authority, second is the refresh no-op.
        await rename(fixture.outputDir, retained);
        await symlink(retained, fixture.outputDir, directoryLinkType);
      },
      async () => {
        try {
          await prepareSiyuanRuntime(options);
        } catch (caught) {
          error = caught;
        }
      },
    );
    assert.equal(reads, 2, 'the final no-op metadata read must actually run');
    assert.deepEqual(await measureTree(retained, '.'), before);
    assert.ok(error, 'unchanged bytes must not certify a replaced output');
  });
});

for (const replacement of ['link', 'directory']) {
  test(`output identity: ${replacement} replacement after temporary write blocks publication and cleanup`, async () => {
    await withFixture(async (fixture) => {
      const options = preparationOptions(fixture);
      await prepareSiyuanRuntime(options);
      await writeFile(fixture.sourceOfferPath, 'Must not publish through replaced output');
      const retained = path.join(fixture.root, 'retained-runtime');
      let temporaryName;
      let error;
      await withFsContinuation(
        'writeFile',
        async (target) => {
          if (
            temporaryName ||
            path.dirname(target) !== fixture.outputDir ||
            !path.basename(target).startsWith('.siyuan-metadata-')
          )
            return;
          temporaryName = path.basename(target);
          await rename(fixture.outputDir, retained);
          if (replacement === 'link') {
            await symlink(retained, fixture.outputDir, directoryLinkType);
          } else {
            await cp(retained, fixture.outputDir, { recursive: true, force: false });
            await writeFile(
              path.join(fixture.outputDir, temporaryName),
              'Preserve replacement peer temporary',
            );
          }
        },
        async () => {
          try {
            await prepareSiyuanRuntime(options);
          } catch (caught) {
            error = caught;
          }
        },
      );
      assert.ok(temporaryName, 'the held temporary write must actually run');
      assert.equal(
        await readFile(path.join(retained, 'VIBESPACE_SIYUAN_SOURCE_OFFER.md'), 'utf8'),
        'Fixture source offer',
      );
      assert.equal(
        await readFile(path.join(retained, temporaryName), 'utf8'),
        'Must not publish through replaced output',
      );
      if (replacement === 'directory') {
        assert.equal(
          await readFile(path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_SOURCE_OFFER.md'), 'utf8'),
          'Fixture source offer',
        );
        assert.equal(
          await readFile(path.join(fixture.outputDir, temporaryName), 'utf8'),
          'Preserve replacement peer temporary',
        );
      } else {
        assert.equal((await lstat(fixture.outputDir)).isSymbolicLink(), true);
      }
      assert.ok(error, 'replaced output must reject and retain ambiguous temporary artifacts');
    });
  });
}

test('output identity: removed output with drifted ready authority is not rebuilt', async () => {
  await withFixture(async (fixture) => {
    const options = preparationOptions(fixture);
    await prepareSiyuanRuntime(options);
    const readyPath = path.join(fixture.outputDir, 'VIBESPACE_SIYUAN_READY.json');
    const ready = JSON.parse(await readFile(readyPath, 'utf8'));
    await writeFile(readyPath, JSON.stringify({ ...ready, fingerprint: '0'.repeat(64) }));
    const before = await measureTree(fixture.outputDir, '.');
    const retained = path.join(fixture.root, 'retained-runtime');
    let replaced = false;
    let error;
    await withFsContinuation(
      'readFile',
      async (target) => {
        if (replaced || target !== readyPath) return;
        replaced = true;
        await rename(fixture.outputDir, retained);
      },
      async () => {
        try {
          await prepareSiyuanRuntime(options);
        } catch (caught) {
          error = caught;
        }
      },
    );
    assert.equal(replaced, true);
    assert.deepEqual(await measureTree(retained, '.'), before);
    await assert.rejects(lstat(fixture.outputDir), { code: 'ENOENT' });
    assert.deepEqual(await readdir(fixture.outputParent), []);
    assert.ok(error, 'authority rejection must not rebuild a concurrently removed output');
  });
});
