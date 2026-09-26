#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..', '..');

export const PONYTAIL_PIN = Object.freeze({
  repository: 'https://github.com/DietrichGebert/ponytail',
  release: 'v4.10.0',
  commit: '1d95ff7d39de12d87014ea40d4e22201bddc501b',
  hashes: Object.freeze({
    upstreamSkill: '1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',
    upstreamAudit: '5560b8e383dbe2ddfddc873a1e2bf2e586e23e0cd7d995537482b2315331f6d1',
    upstreamLicense: 'fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab',
    upstreamBuilder: '23c050103f28dbe6bad953ae21d98cd06d720a20f33d4716e9de419f947d495e',
    upstreamBuilderConfig: '0a8daf96cf9ac703dc4cb7b5065253567e513c951d60b8eb94a0fe727514aeca',
    upstreamPackage: '2a45fda7a379871c5e6e49636989766f304a5dd77931cd70869669272401e3c5',
    installedSkill: '1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2',
    installedAudit: '5560b8e383dbe2ddfddc873a1e2bf2e586e23e0cd7d995537482b2315331f6d1',
    installedLicense: 'fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab',
    generatedInstructions: 'da4fb09cff2f6726691ce6591cebc38c95597d79da132e49c6fa2665c4e8a3ff',
    vendorProvenance: 'e8332cab2b869ecb84a3b281abfc190ad68b4875640985b9222bb92b597242c3',
    provenance: 'b45b7b16eec2525602936ce440302400a648f4e4a4196f568925b75b3810c540',
    auditProvenance: '0226090b877607e425154a1196a64046e5e4e0b6ba74a08628d4913901edfc55',
  }),
});

const VENDOR_ARTIFACTS = [
  {
    id: 'upstream.skill',
    label: 'Pinned upstream Ponytail skill',
    relativePath: 'skills/ponytail/SKILL.md',
    hashKey: 'upstreamSkill',
  },
  {
    id: 'upstream.audit',
    label: 'Pinned upstream Ponytail audit skill',
    relativePath: 'skills/ponytail-audit/SKILL.md',
    hashKey: 'upstreamAudit',
  },
  {
    id: 'upstream.license',
    label: 'Pinned upstream license',
    relativePath: 'LICENSE',
    hashKey: 'upstreamLicense',
  },
  {
    id: 'upstream.builder',
    label: 'Original full-mode instruction builder',
    relativePath: 'hooks/ponytail-instructions.js',
    hashKey: 'upstreamBuilder',
  },
  {
    id: 'upstream.builder-config',
    label: 'Original builder mode configuration',
    relativePath: 'hooks/ponytail-config.js',
    hashKey: 'upstreamBuilderConfig',
  },
  {
    id: 'upstream.package',
    label: 'Upstream package metadata used to load the CommonJS builder',
    relativePath: 'package.json',
    hashKey: 'upstreamPackage',
  },
  {
    id: 'upstream.vendor-provenance',
    label: 'Vendored upstream provenance manifest',
    relativePath: 'UPSTREAM.md',
    hashKey: 'vendorProvenance',
  },
];

const INSTALLED_ARTIFACTS = [
  {
    id: 'installed.skill',
    label: 'Installed Ponytail skill',
    relativePath: 'app/.jarvis/skills/ponytail/SKILL.md',
    hashKey: 'installedSkill',
  },
  {
    id: 'installed.license',
    label: 'Installed Ponytail license',
    relativePath: 'app/.jarvis/skills/ponytail/LICENSE.txt',
    hashKey: 'installedLicense',
  },
  {
    id: 'installed.audit',
    label: 'Installed Ponytail audit skill',
    relativePath: 'app/.jarvis/skills/ponytail-audit/SKILL.md',
    hashKey: 'installedAudit',
  },
  {
    id: 'installed.generated-instructions',
    label: 'Installed full-mode builder output',
    relativePath: 'app/.jarvis/skills/ponytail/full-instructions.md',
    hashKey: 'generatedInstructions',
  },
  {
    id: 'installed.provenance',
    label: 'Installed Ponytail provenance',
    relativePath: 'app/.jarvis/skills/ponytail/UPSTREAM.md',
    hashKey: 'provenance',
  },
  {
    id: 'installed.audit-provenance',
    label: 'Installed Ponytail audit provenance',
    relativePath: 'app/.jarvis/skills/ponytail-audit/UPSTREAM.md',
    hashKey: 'auditProvenance',
  },
];

const defaultIo = Object.freeze({
  exists: existsSync,
  readFile: readFileSync,
  runGit: (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim(),
});

export function sha256Normalized(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return createHash('sha256').update(text.replace(/\r\n?/gu, '\n'), 'utf8').digest('hex');
}

function relativePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function attachBytes(check, bytes) {
  Object.defineProperty(check, '_bytes', { value: Buffer.from(bytes), enumerable: false });
  return check;
}

function checkFile({ id, label, root, relative, expectedHash, io }) {
  const absolute = path.join(root, relative);
  let bytes;
  try {
    bytes = io.readFile(absolute);
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return {
      id,
      label,
      path: relativePath(root, absolute),
      status: 'fail',
      code: missing ? 'missing-artifact' : 'read-error',
      message: missing
        ? 'Required artifact is missing.'
        : `Could not read artifact: ${error.message}`,
      expectedSha256: expectedHash,
    };
  }

  const actualHash = sha256Normalized(bytes);
  const matches = actualHash === expectedHash;
  return attachBytes(
    {
      id,
      label,
      path: relativePath(root, absolute),
      status: matches ? 'pass' : 'fail',
      code: matches ? 'pinned-hash-match' : 'hash-mismatch',
      message: matches
        ? 'Normalized SHA-256 matches the pinned baseline.'
        : 'Normalized SHA-256 differs from the pinned baseline.',
      expectedSha256: expectedHash,
      actualSha256: actualHash,
      normalization: 'UTF-8 text with CRLF and CR normalized to LF',
      bytes: bytes.length,
    },
    bytes,
  );
}

function checkMissingVendorArtifact({ id, label, relative, upstreamRoot, repoRoot, expectedHash }) {
  return {
    id,
    label,
    path: relativePath(repoRoot, path.join(upstreamRoot, relative)),
    status: 'fail',
    code: 'upstream-root-missing',
    message: 'Not checked because the required local vendored upstream root is missing.',
    expectedSha256: expectedHash,
  };
}

function addCheck(report, check) {
  report.checks.push(check);
  return check;
}

function checkProvenanceContent({ report, id, label, check, pin, referencedHash }) {
  if (check.status !== 'pass') return;
  const text = check._bytes.toString('utf8').replace(/\r\n?/gu, '\n');
  const factsMatch =
    text.includes(pin.repository) &&
    text.includes(pin.release) &&
    text.includes(pin.commit) &&
    text.includes(referencedHash);
  addCheck(report, {
    id,
    label,
    path: check.path,
    status: factsMatch ? 'pass' : 'fail',
    code: factsMatch ? 'pinned-provenance-facts-match' : 'provenance-facts-mismatch',
    message: factsMatch
      ? 'Provenance names the pinned repository, release, commit, and referenced artifact hash.'
      : 'Provenance is missing a required repository, release, commit, or artifact hash.',
  });
}

function compareCopies({ report, id, label, source, installed }) {
  const sourceCheck = report.checks.find((check) => check.id === source);
  const installedCheck = report.checks.find((check) => check.id === installed);
  if (sourceCheck?.status !== 'pass' || installedCheck?.status !== 'pass') {
    addCheck(report, {
      id,
      label,
      status: 'fail',
      code: 'copy-parity-unverified',
      message:
        'Copy parity cannot be verified while either artifact is missing or differs from its pin.',
    });
    return;
  }

  const sourceBytes = sourceCheck._bytes;
  const installedBytes = installedCheck._bytes;
  const matches = sha256Normalized(sourceBytes) === sha256Normalized(installedBytes);
  addCheck(report, {
    id,
    label,
    status: matches ? 'pass' : 'fail',
    code: matches ? 'copy-content-match' : 'copy-content-mismatch',
    message: matches
      ? 'Installed content matches the pinned upstream file.'
      : 'Installed content differs from the pinned upstream file.',
    source: sourceCheck.path,
    installed: installedCheck.path,
  });
}

function checkGitProvenance(report) {
  const gitPath = path.join(report.upstreamRoot.pathAbsolute, '.git');
  if (!report.io.exists(gitPath)) {
    report.upstreamRoot.revisionEvidence = 'critical-file-content-hashes';
    report.upstreamRoot.gitMetadata = 'not-present';
    return;
  }

  report.upstreamRoot.gitMetadata = 'present';
  const revision = [
    {
      id: 'upstream.git-commit',
      label: 'Vendored upstream commit',
      args: ['rev-parse', 'HEAD'],
      expected: report.pin.commit,
    },
    {
      id: 'upstream.git-tag',
      label: 'Vendored upstream exact release tag',
      args: ['describe', '--tags', '--exact-match'],
      expected: report.pin.release,
    },
    {
      id: 'upstream.git-clean',
      label: 'Vendored upstream working tree',
      args: ['status', '--porcelain'],
      expected: '',
    },
  ];

  for (const item of revision) {
    try {
      const actual = report.io.runGit(report.upstreamRoot.pathAbsolute, item.args);
      const matches = actual === item.expected;
      addCheck(report, {
        id: item.id,
        label: item.label,
        path: relativePath(report.repoRoot, report.upstreamRoot.pathAbsolute),
        status: matches ? 'pass' : 'fail',
        code: matches ? 'pinned-git-metadata-match' : 'git-metadata-mismatch',
        message: matches
          ? 'Git metadata matches the pinned release.'
          : 'Git metadata differs from the pinned release.',
        expected: item.expected || '(clean)',
        actual: actual || '(clean)',
      });
    } catch (error) {
      addCheck(report, {
        id: item.id,
        label: item.label,
        path: relativePath(report.repoRoot, report.upstreamRoot.pathAbsolute),
        status: 'fail',
        code: 'git-metadata-read-error',
        message: `Could not verify vendored Git metadata: ${error.message}`,
      });
    }
  }
  report.upstreamRoot.revisionEvidence = 'pinned-git-metadata-and-critical-file-content-hashes';
}

function runPinnedBuilder(upstreamRoot) {
  const requireFromUpstream = createRequire(path.join(upstreamRoot, 'package.json'));
  const builderPath = path.join(upstreamRoot, 'hooks', 'ponytail-instructions.js');
  const builder = requireFromUpstream(builderPath);
  if (typeof builder.getPonytailInstructions !== 'function') {
    throw new Error('Pinned upstream builder does not export getPonytailInstructions().');
  }
  return builder.getPonytailInstructions('full');
}

export function verifyPonytailUpstream({
  repoRoot = defaultRepoRoot,
  upstreamRoot = path.join(repoRoot, 'app', 'third_party', 'ponytail'),
  pin = PONYTAIL_PIN,
  io = defaultIo,
  runBuilder = runPinnedBuilder,
} = {}) {
  const report = {
    schema: 'vibespace.ponytail-upstream-verification.v1',
    createdAt: new Date().toISOString(),
    status: 'pass',
    verification: 'offline-only',
    repoRoot,
    pin: {
      repository: pin.repository,
      release: pin.release,
      commit: pin.commit,
    },
    upstreamRoot: {
      path: relativePath(repoRoot, upstreamRoot),
      pathAbsolute: upstreamRoot,
      present: io.exists(upstreamRoot),
    },
    checks: [],
    failures: [],
    summary: { passed: 0, failed: 0 },
    io,
    pin,
  };

  addCheck(report, {
    id: 'upstream-root',
    label: 'Required local vendored upstream root',
    path: report.upstreamRoot.path,
    status: report.upstreamRoot.present ? 'pass' : 'fail',
    code: report.upstreamRoot.present ? 'present' : 'missing-artifact',
    message: report.upstreamRoot.present
      ? 'Required local vendored upstream root is present.'
      : 'Required local vendored upstream root is missing; no work checkout or network fallback is used.',
  });

  const sourceChecks = new Map();
  for (const artifact of VENDOR_ARTIFACTS) {
    const check = report.upstreamRoot.present
      ? checkFile({
          id: artifact.id,
          label: artifact.label,
          root: upstreamRoot,
          relative: artifact.relativePath,
          expectedHash: pin.hashes[artifact.hashKey],
          io,
        })
      : checkMissingVendorArtifact({
          id: artifact.id,
          label: artifact.label,
          relative: artifact.relativePath,
          upstreamRoot,
          repoRoot,
          expectedHash: pin.hashes[artifact.hashKey],
        });
    sourceChecks.set(artifact.id, addCheck(report, check));
  }

  const installedChecks = new Map();
  for (const artifact of INSTALLED_ARTIFACTS) {
    installedChecks.set(
      artifact.id,
      addCheck(
        report,
        checkFile({
          id: artifact.id,
          label: artifact.label,
          root: repoRoot,
          relative: artifact.relativePath,
          expectedHash: pin.hashes[artifact.hashKey],
          io,
        }),
      ),
    );
  }

  checkProvenanceContent({
    report,
    id: 'upstream.vendor-provenance.pin-facts',
    label: 'Vendored Ponytail provenance pin facts',
    check: sourceChecks.get('upstream.vendor-provenance'),
    pin,
    referencedHash: pin.hashes.upstreamSkill,
  });
  checkProvenanceContent({
    report,
    id: 'provenance.pin-facts',
    label: 'Ponytail provenance pin facts',
    check: installedChecks.get('installed.provenance'),
    pin,
    referencedHash: pin.hashes.generatedInstructions,
  });
  checkProvenanceContent({
    report,
    id: 'audit-provenance.pin-facts',
    label: 'Ponytail audit provenance pin facts',
    check: installedChecks.get('installed.audit-provenance'),
    pin,
    referencedHash: pin.hashes.installedAudit,
  });

  if (report.upstreamRoot.present) {
    checkGitProvenance(report);
  } else {
    report.upstreamRoot.revisionEvidence = 'missing-vendored-root';
    report.upstreamRoot.gitMetadata = 'unavailable';
  }

  compareCopies({
    report,
    id: 'copy.skill-parity',
    label: 'Installed and upstream Ponytail skill parity',
    source: 'upstream.skill',
    installed: 'installed.skill',
  });
  compareCopies({
    report,
    id: 'copy.license-parity',
    label: 'Installed and upstream license parity',
    source: 'upstream.license',
    installed: 'installed.license',
  });
  compareCopies({
    report,
    id: 'copy.audit-parity',
    label: 'Installed and upstream audit skill parity',
    source: 'upstream.audit',
    installed: 'installed.audit',
  });

  const allSourceArtifactsMatch = [...sourceChecks.values()].every(
    (check) => check.status === 'pass',
  );
  const gitChecks = report.checks.filter((check) => check.id.startsWith('upstream.git-'));
  const gitMetadataMatches = gitChecks.every((check) => check.status === 'pass');
  if (!report.upstreamRoot.present || !allSourceArtifactsMatch || !gitMetadataMatches) {
    addCheck(report, {
      id: 'builder.output',
      label: 'Original builder output parity',
      status: 'fail',
      code: 'builder-not-executed-untrusted-or-missing-source',
      message:
        'Builder output was not generated because the vendored source is missing or failed pinned hash checks.',
    });
  } else {
    try {
      const generated = Buffer.from(runBuilder(upstreamRoot), 'utf8');
      const generatedHash = sha256Normalized(generated);
      const installedCheck = installedChecks.get('installed.generated-instructions');
      const installedBytes = installedCheck?.status === 'pass' ? installedCheck._bytes : undefined;
      const matchesPin = generatedHash === pin.hashes.generatedInstructions;
      const matchesInstalled =
        installedBytes !== undefined &&
        sha256Normalized(generated) === sha256Normalized(installedBytes);
      const matches = matchesPin && matchesInstalled;
      addCheck(report, {
        id: 'builder.output',
        label: 'Original builder output parity',
        status: matches ? 'pass' : 'fail',
        code: matches ? 'builder-output-match' : 'builder-output-mismatch',
        message: matches
          ? 'Original upstream full-mode output matches both the pinned hash and installed artifact.'
          : 'Original upstream full-mode output differs from its pinned hash or installed artifact.',
        expectedSha256: pin.hashes.generatedInstructions,
        actualSha256: generatedHash,
        installedPath: installedCheck?.path,
      });
    } catch (error) {
      addCheck(report, {
        id: 'builder.output',
        label: 'Original builder output parity',
        status: 'fail',
        code: 'builder-execution-error',
        message: `Could not execute the hash-verified upstream builder: ${error.message}`,
      });
    }
  }

  report.failures = report.checks
    .filter((check) => check.status === 'fail')
    .map(({ id, code, path: artifactPath, message }) => ({
      id,
      code,
      path: artifactPath,
      message,
    }));
  report.summary = {
    passed: report.checks.filter((check) => check.status === 'pass').length,
    failed: report.failures.length,
  };
  report.status = report.failures.length === 0 ? 'pass' : 'fail';
  delete report.io;
  delete report.pin;
  delete report.upstreamRoot.pathAbsolute;
  return report;
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const report = verifyPonytailUpstream();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'pass') process.exitCode = 1;
}
