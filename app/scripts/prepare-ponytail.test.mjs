import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createPonytailArtifact,
  preparePonytail,
  renderPonytailModule,
  writePonytailModule,
} from './prepare-ponytail.mjs';

function sha256(value) {
  return createHash('sha256').update(value.replace(/\r\n?/gu, '\n'), 'utf8').digest('hex');
}

function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibespace-ponytail-prepare-'));
  const upstreamRoot = path.join(root, 'app', 'third_party', 'ponytail');
  mkdirSync(upstreamRoot, { recursive: true });
  const source = {
    'skills/ponytail/SKILL.md': '---\nname: ponytail\ntitle: Ponytail\n---\nstock body\n',
    'skills/ponytail-audit/SKILL.md':
      '---\nname: ponytail-audit\ntitle: Ponytail Audit\n---\nread-only audit\n',
    LICENSE: 'MIT fixture\n',
    'hooks/ponytail-instructions.js': 'builder fixture\n',
    'hooks/ponytail-config.js': 'config fixture\n',
    'package.json': '{"name":"@dietrichgebert/ponytail","version":"4.10.0"}\n',
  };
  const hashes = Object.fromEntries(
    Object.entries(source).map(([relativePath, contents]) => [relativePath, sha256(contents)]),
  );
  const manifest = [
    'Repository: https://example.test/ponytail',
    'Pinned release: v4.10.0',
    'Pinned commit: fixture-commit',
    `skills/ponytail/SKILL.md SHA-256: ${hashes['skills/ponytail/SKILL.md']}`,
    `skills/ponytail-audit/SKILL.md SHA-256: ${hashes['skills/ponytail-audit/SKILL.md']}`,
    `LICENSE SHA-256: ${hashes.LICENSE}`,
    `hooks/ponytail-instructions.js SHA-256: ${hashes['hooks/ponytail-instructions.js']}`,
    `hooks/ponytail-config.js SHA-256: ${hashes['hooks/ponytail-config.js']}`,
    `package.json SHA-256: ${hashes['package.json']}`,
  ].join('\n');
  source['UPSTREAM.md'] = `${manifest}\n`;
  hashes['UPSTREAM.md'] = sha256(source['UPSTREAM.md']);
  for (const [relativePath, contents] of Object.entries(source)) {
    const absolute = path.join(upstreamRoot, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents, 'utf8');
  }
  const fullInstructions = 'PONYTAIL MODE ACTIVE — level: full\n\nstock body\n';
  const pin = {
    repository: 'https://example.test/ponytail',
    release: 'v4.10.0',
    commit: 'fixture-commit',
    hashes: {
      upstreamSkill: hashes['skills/ponytail/SKILL.md'],
      upstreamAudit: hashes['skills/ponytail-audit/SKILL.md'],
      upstreamLicense: hashes.LICENSE,
      upstreamBuilder: hashes['hooks/ponytail-instructions.js'],
      upstreamBuilderConfig: hashes['hooks/ponytail-config.js'],
      upstreamPackage: hashes['package.json'],
      vendorProvenance: hashes['UPSTREAM.md'],
      generatedInstructions: sha256(fullInstructions),
    },
  };
  return { root, upstreamRoot, source, manifest, hashes, fullInstructions, pin };
}

test('builds generated catalog data from hash-verified stock files and builder output', () => {
  const fixture = createFixture();
  try {
    let builderCalls = 0;
    const artifact = createPonytailArtifact({
      upstreamRoot: fixture.upstreamRoot,
      pin: fixture.pin,
      runBuilder: () => {
        builderCalls += 1;
        return fixture.fullInstructions;
      },
    });

    assert.equal(builderCalls, 1);
    assert.deepEqual(artifact.source, {
      repository: fixture.pin.repository,
      release: fixture.pin.release,
      commit: fixture.pin.commit,
    });
    assert.equal(artifact.instructions.full, fixture.fullInstructions);
    assert.equal(artifact.skills.ponytail.raw, fixture.source['skills/ponytail/SKILL.md']);
    assert.equal(artifact.skills.audit.raw, fixture.source['skills/ponytail-audit/SKILL.md']);
    assert.equal(artifact.skills.audit.sha256, fixture.pin.hashes.upstreamAudit);
    assert.equal(artifact.package.name, '@dietrichgebert/ponytail');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('generates the same artifact from LF and CRLF vendored skills', () => {
  const fixture = createFixture();
  try {
    const options = {
      upstreamRoot: fixture.upstreamRoot,
      pin: fixture.pin,
      runBuilder: () => fixture.fullInstructions,
    };
    const baseline = createPonytailArtifact(options);
    for (const relativePath of ['skills/ponytail/SKILL.md', 'skills/ponytail-audit/SKILL.md']) {
      writeFileSync(
        path.join(fixture.upstreamRoot, relativePath),
        fixture.source[relativePath].replace(/\n/gu, '\r\n'),
        'utf8',
      );
    }
    assert.deepEqual(createPonytailArtifact(options), baseline);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails closed on a changed upstream artifact before executing the builder', () => {
  const fixture = createFixture();
  try {
    writeFileSync(
      path.join(fixture.upstreamRoot, 'skills', 'ponytail-audit', 'SKILL.md'),
      'tampered audit\n',
      'utf8',
    );
    let builderCalled = false;
    assert.throws(
      () =>
        createPonytailArtifact({
          upstreamRoot: fixture.upstreamRoot,
          pin: fixture.pin,
          runBuilder: () => {
            builderCalled = true;
            return fixture.fullInstructions;
          },
        }),
      /Pinned upstream hash mismatch.*skills\/ponytail-audit\/SKILL\.md/u,
    );
    assert.equal(builderCalled, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails closed if builder output differs from the pinned upstream result', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        createPonytailArtifact({
          upstreamRoot: fixture.upstreamRoot,
          pin: fixture.pin,
          runBuilder: () => 'unexpected instructions',
        }),
      /Pinned full-mode builder output hash mismatch/u,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('renders the same escaped TypeScript module for the same verified artifact', async () => {
  const fixture = createFixture();
  try {
    const artifact = createPonytailArtifact({
      upstreamRoot: fixture.upstreamRoot,
      pin: fixture.pin,
      runBuilder: () => fixture.fullInstructions,
    });
    const first = await renderPonytailModule(artifact);
    const second = await renderPonytailModule(artifact);

    assert.equal(first, second);
    assert.match(first, /export const ponytailArtifact/u);
    assert.match(first, /commit: 'fixture-commit'/u);
    assert.match(first, /sha256:/u);
    assert.match(first, /read-only audit/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('check-only refuses missing or stale output without writing it', () => {
  const fixture = createFixture();
  const target = path.join(fixture.root, 'generated.ts');
  const io = {
    exists: (filePath) => {
      try {
        readFileSync(filePath);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (filePath) => readFileSync(filePath, 'utf8'),
    writeFile: (filePath, contents) => writeFileSync(filePath, contents, 'utf8'),
  };
  try {
    assert.throws(
      () => writePonytailModule({ target, expectedContents: 'expected', checkOnly: true, io }),
      /Generated Ponytail artifact is missing/u,
    );
    assert.equal(io.exists(target), false);

    writeFileSync(target, 'stale', 'utf8');
    assert.throws(
      () => writePonytailModule({ target, expectedContents: 'expected', checkOnly: true, io }),
      /Generated Ponytail artifact is stale/u,
    );
    assert.equal(readFileSync(target, 'utf8'), 'stale');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a CRLF checkout keeps the generated Ponytail module canonical for strict check-only', async () => {
  const fixture = createFixture();
  try {
    const relativeTarget = 'app/src/lib/ai/ponytail.generated.ts';
    const target = path.join(fixture.root, relativeTarget);
    const artifact = createPonytailArtifact({
      upstreamRoot: fixture.upstreamRoot,
      pin: fixture.pin,
      runBuilder: () => fixture.fullInstructions,
    });
    const expectedContents = await renderPonytailModule(artifact);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, expectedContents, 'utf8');
    writeFileSync(
      path.join(fixture.root, '.gitattributes'),
      readFileSync(new URL('../../.gitattributes', import.meta.url)),
    );
    const unrelatedContents = 'unrelated first line\nunrelated second line\n';
    writeFileSync(path.join(fixture.root, 'unrelated.txt'), unrelatedContents, 'utf8');
    const git = (...args) =>
      execFileSync(
        'git',
        ['-C', fixture.root, '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args],
        { stdio: 'pipe' },
      );
    git('init', '--quiet');
    git('add', '--', '.gitattributes', relativeTarget, 'unrelated.txt');
    const checkout = path.join(fixture.root, 'checkout');
    git('checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`);
    assert.equal(
      readFileSync(path.join(checkout, 'unrelated.txt'), 'utf8'),
      unrelatedContents.replaceAll('\n', '\r\n'),
    );
    const checkedOutTarget = path.join(checkout, relativeTarget);
    assert.equal(readFileSync(checkedOutTarget, 'utf8'), expectedContents);
    assert.equal(
      writePonytailModule({ target: checkedOutTarget, expectedContents, checkOnly: true }).status,
      'checked',
    );
    assert.equal(readFileSync(checkedOutTarget, 'utf8'), expectedContents);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('write mode only writes the declared generated artifact', () => {
  const fixture = createFixture();
  const target = path.join(fixture.root, 'app', 'src', 'lib', 'ai', 'ponytail.generated.ts');
  const touched = [];
  const io = {
    exists: () => false,
    readFile: readFileSync,
    writeFile: (filePath, contents) => {
      touched.push(filePath);
      writeFileSync(filePath, contents, 'utf8');
    },
    mkdir: mkdirSync,
  };
  try {
    const result = writePonytailModule({
      target,
      expectedContents: 'generated',
      checkOnly: false,
      io,
    });

    assert.equal(result.status, 'written');
    assert.deepEqual(touched, [target]);
    assert.equal(readFileSync(target, 'utf8'), 'generated');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('prepare refuses to write when offline pinned verification fails', async () => {
  const fixture = createFixture();
  const target = path.join(fixture.root, 'app', 'src', 'ponytail.generated.ts');
  const writes = [];
  try {
    await assert.rejects(
      preparePonytail({
        repoRoot: fixture.root,
        upstreamRoot: fixture.upstreamRoot,
        target,
        pin: fixture.pin,
        verifier: () => ({ status: 'fail', failures: [{ id: 'upstream.skill' }] }),
        io: {
          exists: () => false,
          readFile: readFileSync,
          writeFile: (...args) => writes.push(args),
          mkdir: mkdirSync,
        },
        runBuilder: () => fixture.fullInstructions,
      }),
      /Pinned Ponytail verification failed/u,
    );
    assert.deepEqual(writes, []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
