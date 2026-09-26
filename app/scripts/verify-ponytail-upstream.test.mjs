import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

let verifierModule;
try {
  verifierModule = await import('./verify-ponytail-upstream.mjs');
} catch {
  verifierModule = undefined;
}

const { PONYTAIL_PIN, sha256Normalized, verifyPonytailUpstream } = verifierModule ?? {};

function requireVerifier() {
  assert.equal(
    typeof verifyPonytailUpstream,
    'function',
    'verify-ponytail-upstream.mjs must export verifyPonytailUpstream',
  );
  return verifyPonytailUpstream;
}

function makeFixture({ includeUpstream = true, missing = [], changes = {}, gitMetadata } = {}) {
  assert.ok(PONYTAIL_PIN, 'verifier module must export its pinned baseline');
  const repoRoot = path.resolve('fixture-repo');
  const upstreamRoot = path.join(repoRoot, 'app', 'third_party', 'ponytail');
  const generated = 'fixture Ponytail instructions\n';
  const sourceText = {
    upstreamSkill: '# fixture skill\r\n',
    upstreamAudit: '# fixture audit\r\n',
    upstreamLicense: 'MIT fixture license\r\n',
    upstreamBuilder: 'fixture original instructions builder\n',
    upstreamConfig: 'fixture original configuration\n',
    upstreamPackage: '{"version":"4.10.0"}\n',
    installedSkill: '# fixture skill\n',
    installedAudit: '# fixture audit\n',
    installedLicense: 'MIT fixture license\n',
    installedGenerated: generated,
  };
  const hashes = {
    upstreamSkill: sha256Normalized(sourceText.upstreamSkill),
    upstreamAudit: sha256Normalized(sourceText.upstreamAudit),
    upstreamLicense: sha256Normalized(sourceText.upstreamLicense),
    upstreamBuilder: sha256Normalized(sourceText.upstreamBuilder),
    upstreamBuilderConfig: sha256Normalized(sourceText.upstreamConfig),
    upstreamPackage: sha256Normalized(sourceText.upstreamPackage),
    installedSkill: sha256Normalized(sourceText.installedSkill),
    installedAudit: sha256Normalized(sourceText.installedAudit),
    installedLicense: sha256Normalized(sourceText.installedLicense),
    generatedInstructions: sha256Normalized(sourceText.installedGenerated),
  };
  const provenance = [
    `Repository: ${PONYTAIL_PIN.repository}`,
    `Pinned release: ${PONYTAIL_PIN.release}`,
    `Pinned commit: ${PONYTAIL_PIN.commit}`,
    `full-instructions SHA-256: ${hashes.generatedInstructions}`,
  ].join('\n');
  const auditProvenance = [
    `Repository: ${PONYTAIL_PIN.repository}`,
    `Pinned release: ${PONYTAIL_PIN.release}`,
    `Pinned commit: ${PONYTAIL_PIN.commit}`,
    `audit SKILL.md SHA-256: ${hashes.installedAudit}`,
  ].join('\n');
  const vendorProvenance = [
    `Repository: ${PONYTAIL_PIN.repository}`,
    `Pinned release: ${PONYTAIL_PIN.release}`,
    `Pinned commit: ${PONYTAIL_PIN.commit}`,
    `skills/ponytail/SKILL.md SHA-256: ${hashes.upstreamSkill}`,
    `skills/ponytail-audit/SKILL.md SHA-256: ${hashes.upstreamAudit}`,
    `LICENSE SHA-256: ${hashes.upstreamLicense}`,
    `hooks/ponytail-instructions.js SHA-256: ${hashes.upstreamBuilder}`,
    `hooks/ponytail-config.js SHA-256: ${hashes.upstreamBuilderConfig}`,
    `package.json SHA-256: ${hashes.upstreamPackage}`,
  ].join('\n');
  hashes.vendorProvenance = sha256Normalized(vendorProvenance);
  hashes.provenance = sha256Normalized(provenance);
  hashes.auditProvenance = sha256Normalized(auditProvenance);

  const pin = { ...PONYTAIL_PIN, hashes };
  const paths = {
    'upstream/skills/ponytail/SKILL.md': sourceText.upstreamSkill,
    'upstream/skills/ponytail-audit/SKILL.md': sourceText.upstreamAudit,
    'upstream/LICENSE': sourceText.upstreamLicense,
    'upstream/hooks/ponytail-instructions.js': sourceText.upstreamBuilder,
    'upstream/hooks/ponytail-config.js': sourceText.upstreamConfig,
    'upstream/package.json': sourceText.upstreamPackage,
    'upstream/UPSTREAM.md': vendorProvenance,
    'repo/app/.jarvis/skills/ponytail/SKILL.md': sourceText.installedSkill,
    'repo/app/.jarvis/skills/ponytail/LICENSE.txt': sourceText.installedLicense,
    'repo/app/.jarvis/skills/ponytail/full-instructions.md': sourceText.installedGenerated,
    'repo/app/.jarvis/skills/ponytail/UPSTREAM.md': provenance,
    'repo/app/.jarvis/skills/ponytail-audit/SKILL.md': sourceText.installedAudit,
    'repo/app/.jarvis/skills/ponytail-audit/UPSTREAM.md': auditProvenance,
  };
  const files = new Map();
  const exists = new Set(includeUpstream ? [upstreamRoot] : []);
  if (includeUpstream && gitMetadata) exists.add(path.join(upstreamRoot, '.git'));
  for (const [key, value] of Object.entries(paths)) {
    if (missing.includes(key)) continue;
    const changedValue = Object.hasOwn(changes, key) ? changes[key] : value;
    const fullPath = key.startsWith('upstream/')
      ? path.join(upstreamRoot, key.slice('upstream/'.length))
      : path.join(repoRoot, key.slice('repo/'.length));
    files.set(fullPath, Buffer.from(changedValue, 'utf8'));
    exists.add(fullPath);
  }

  const reads = [];
  const io = {
    exists: (candidate) => exists.has(candidate),
    readFile: (candidate) => {
      reads.push(candidate);
      const bytes = files.get(candidate);
      if (!bytes) throw Object.assign(new Error(`ENOENT: ${candidate}`), { code: 'ENOENT' });
      return bytes;
    },
    runGit: (_root, args) => {
      if (!gitMetadata) throw new Error('git should not run for a content-only fixture');
      const result = gitMetadata[args.join(' ')];
      if (result === undefined) throw new Error(`unexpected git command: ${args.join(' ')}`);
      return result;
    },
  };
  return { repoRoot, upstreamRoot, pin, io, reads, generated };
}

test('exports the offline Ponytail verifier API', () => {
  requireVerifier();
  assert.equal(typeof sha256Normalized, 'function');
  assert.equal(PONYTAIL_PIN.commit, '1d95ff7d39de12d87014ea40d4e22201bddc501b');
});

test('normalizes Windows line endings before hashing text artifacts', () => {
  requireVerifier();
  assert.equal(sha256Normalized('one\r\ntwo\r\n'), sha256Normalized('one\ntwo\n'));
});

test('fails honestly when the vendored root is missing without falling back to work checkouts', () => {
  const verify = requireVerifier();
  const fixture = makeFixture({ includeUpstream: false });
  let builderCalled = false;
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => {
      builderCalled = true;
      return fixture.generated;
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(report.upstreamRoot.present, false);
  assert.equal(report.checks.find((check) => check.id === 'upstream-root').status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'installed.skill').status, 'pass');
  assert.equal(builderCalled, false);
  assert.ok(fixture.reads.every((candidate) => !candidate.includes('work')));
});

test('passes only when pinned upstream files, installed artifacts, provenance, and builder output agree', () => {
  const verify = requireVerifier();
  const fixture = makeFixture();
  let builderCalls = 0;
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => {
      builderCalls += 1;
      return fixture.generated;
    },
  });

  assert.equal(report.status, 'pass', JSON.stringify(report.failures, null, 2));
  assert.equal(builderCalls, 1);
  assert.equal(
    report.checks.every((check) => check.status === 'pass'),
    true,
  );
});

test('uses app/third_party/ponytail by default and verifies its pinned provenance manifest', () => {
  const verify = requireVerifier();
  const fixture = makeFixture();
  const report = verify({
    repoRoot: fixture.repoRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => fixture.generated,
  });

  assert.equal(report.upstreamRoot.path, 'app/third_party/ponytail');
  assert.equal(report.status, 'pass', JSON.stringify(report.failures, null, 2));
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.vendor-provenance').status,
    'pass',
  );
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.vendor-provenance.pin-facts').status,
    'pass',
  );
});

test('rejects a vendor provenance manifest with false pin facts even when its own hash is pinned', () => {
  const verify = requireVerifier();
  const vendorProvenance = [
    `Repository: ${PONYTAIL_PIN.repository}`,
    `Pinned release: ${PONYTAIL_PIN.release}`,
    'Pinned commit: wrong-commit',
    `skills/ponytail/SKILL.md SHA-256: ${PONYTAIL_PIN.hashes.upstreamSkill}`,
  ].join('\n');
  const fixture = makeFixture({ changes: { 'upstream/UPSTREAM.md': vendorProvenance } });
  fixture.pin.hashes.vendorProvenance = sha256Normalized(vendorProvenance);
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => fixture.generated,
  });

  assert.equal(report.status, 'fail');
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.vendor-provenance').status,
    'pass',
  );
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.vendor-provenance.pin-facts').code,
    'provenance-facts-mismatch',
  );
});

test('fails on a changed vendored builder and does not execute it', () => {
  const verify = requireVerifier();
  const fixture = makeFixture({
    changes: { 'upstream/hooks/ponytail-instructions.js': 'modified builder\n' },
  });
  let builderCalled = false;
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => {
      builderCalled = true;
      return fixture.generated;
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(report.checks.find((check) => check.id === 'upstream.builder').status, 'fail');
  assert.equal(builderCalled, false);
});

test('fails when the hash-verified builder output differs from the installed artifact', () => {
  const verify = requireVerifier();
  const fixture = makeFixture();
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => 'different generated instructions\n',
  });

  assert.equal(report.status, 'fail');
  assert.equal(
    report.checks.find((check) => check.id === 'builder.output').code,
    'builder-output-mismatch',
  );
});

test('fails on a missing required upstream audit skill without running the builder', () => {
  const verify = requireVerifier();
  const fixture = makeFixture({ missing: ['upstream/skills/ponytail-audit/SKILL.md'] });
  let builderCalled = false;
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => {
      builderCalled = true;
      return fixture.generated;
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.audit').code,
    'missing-artifact',
  );
  assert.equal(builderCalled, false);
});

test('requires exact pinned Git metadata when the vendored source has a Git checkout', () => {
  const verify = requireVerifier();
  const fixture = makeFixture({
    gitMetadata: {
      'rev-parse HEAD': 'wrong-commit',
      'describe --tags --exact-match': PONYTAIL_PIN.release,
      'status --porcelain': '',
    },
  });
  let builderCalled = false;
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => {
      builderCalled = true;
      return fixture.generated;
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(
    report.checks.find((check) => check.id === 'upstream.git-commit').code,
    'git-metadata-mismatch',
  );
  assert.equal(builderCalled, false);
});

test('accepts a clean vendored Git checkout at the exact pinned tag and commit', () => {
  const verify = requireVerifier();
  const fixture = makeFixture({
    gitMetadata: {
      'rev-parse HEAD': PONYTAIL_PIN.commit,
      'describe --tags --exact-match': PONYTAIL_PIN.release,
      'status --porcelain': '',
    },
  });
  const report = verify({
    repoRoot: fixture.repoRoot,
    upstreamRoot: fixture.upstreamRoot,
    pin: fixture.pin,
    io: fixture.io,
    runBuilder: () => fixture.generated,
  });

  assert.equal(report.status, 'pass');
  assert.equal(report.upstreamRoot.gitMetadata, 'present');
  assert.equal(
    report.upstreamRoot.revisionEvidence,
    'pinned-git-metadata-and-critical-file-content-hashes',
  );
  assert.equal(
    report.checks
      .filter((check) => check.id.startsWith('upstream.git-'))
      .every((check) => check.status === 'pass'),
    true,
  );
});
