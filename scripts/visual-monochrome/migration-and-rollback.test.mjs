import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const documentPath = path.join(repoRoot, 'docs/appearance/monochrome/migration-and-rollback.md');
const generatorPath = path.join(repoRoot, 'scripts/visual-monochrome/generate-theme-contract.mjs');
const proofBlockPattern = /```json migration-proof\r?\n([\s\S]*?)\r?\n```/gu;
const currentVerifiedEndpoint = '10ade2cb205be6aae93e239e8debd9eaf584b6de';
const expectedProofPaths = [
  'app/public/theme-prepaint.js',
  'app/src/features/appearance/themeContract.generated.ts',
  'app/src/features/appearance/themeContract.source.json',
  'app/src/features/appearance/themePrepaint.integration.test.ts',
  'app/src/features/appearance/themeSync.test.ts',
  'app/src/features/terminals/terminalTheme.test.ts',
  'app/src/lib/persistence/safeLocalStorage.test.ts',
  'app/src/stores/ui.themePersistence.test.ts',
];
const postMonochromeEvolutionPaths = new Set([
  'app/public/theme-prepaint.js',
  'app/src/features/appearance/themeContract.generated.ts',
  'app/src/features/appearance/themeContract.source.json',
  'app/src/features/appearance/themePrepaint.integration.test.ts',
  'app/src/features/appearance/themeSync.test.ts',
  'app/src/stores/ui.themePersistence.test.ts',
]);

async function readRelative(relativePath) {
  return readFile(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
}

async function sha256(relativePath) {
  const text = await readRelative(relativePath);
  return createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex').toUpperCase();
}

function sha256AtCommit(commitSha, relativePath) {
  const bytes = execFileSync('git', ['show', `${commitSha}:${relativePath}`], {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function replaceProof(document, proof) {
  return document.replace(
    /```json migration-proof\r?\n[\s\S]*?\r?\n```/u,
    `\`\`\`json migration-proof\n${JSON.stringify(proof, null, 2)}\n\`\`\``,
  );
}

function parseRollbackSteps(document) {
  const section = document.match(
    /## Compatibility-first rollback\r?\n([\s\S]*?)\r?\n## Rollback verification matrix/u,
  );
  assert.ok(section, 'compatibility-first rollback section must be bounded');
  return [...section[1].matchAll(/^(\d+)\.\s+([\s\S]*?)(?=^\d+\.\s+|(?![\s\S]))/gmu)].map(
    ([, number, text]) => ({
      number: Number(number),
      text: text.trim(),
    }),
  );
}

function assertRepositoryRelative(relativePath) {
  assert.equal(typeof relativePath, 'string');
  assert.ok(relativePath.length > 0);
  assert.equal(relativePath.includes('\\'), false);
  assert.equal(path.posix.isAbsolute(relativePath), false);
  assert.equal(/^[A-Za-z]:/u.test(relativePath), false);
  assert.equal(/^https?:\/\//iu.test(relativePath), false);
  assert.equal(relativePath.split('/').includes('..'), false);
  assert.equal(path.posix.normalize(relativePath), relativePath);
}

async function validateDocument(document) {
  const prose = document.replace(/\s+/gu, ' ');

  for (const heading of [
    '# MonoChrome migration and rollback',
    '## Forward migration',
    '## Current-version validation',
    '## First paint and detached-window compatibility',
    '## User-data non-impact',
    '## Compatibility-first rollback',
    '## Rollback verification matrix',
    '## Baselines and provenance',
    '## Machine-readable proof manifest',
  ]) {
    assert.match(
      document,
      new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'mu'),
    );
  }

  for (const literal of [
    '`light` → `monochrome`',
    '`dark` → `default`',
    '`system` → `default`',
    '`monochrome` → `default`',
    '`jarvis-ui`',
    'store version `5`',
    '`12198b85`',
    '`ba92a75a`',
    '`8bd1e58c`',
    '`7eb708e184ee4f054a49d3e70d73e80fd4eb97ae`',
    '`041c914da680d4ee5d5c091573e5582b17f18484`',
    '`cf8f766056f9f5bb318d383394f14b5d4e11ec498fa55b1c47ef78f602a81796`',
  ]) {
    assert.ok(document.includes(literal), `missing required migration evidence ${literal}`);
  }

  assert.match(
    prose,
    /The v4 → v5 migration preserves every unrelated preference, including future keys/iu,
  );
  assert.match(prose, /retains current values only when the persisted payload omits them/iu);
  assert.match(prose, /restores current function-valued methods after the merge/iu);
  assert.match(prose, /must never delete user data/iu);
  assert.match(prose, /must not resurrect Light as a selectable theme/iu);
  assert.match(prose, /blanket revert.+prohibited/iu);

  const steps = parseRollbackSteps(document);
  const stepText = steps.map(({ text }) => text.replace(/\s+/gu, ' '));
  assert.deepEqual(
    steps.map(({ number }) => number),
    [1, 2, 3, 4, 5, 6],
  );
  assert.match(stepText[0], /accepts both persisted `monochrome` and legacy `light`/iu);
  assert.match(stepText[0], /mapping each to `default`/iu);
  assert.match(stepText[1], /Preserve `jarvis-ui`, every unrelated preference/iu);
  assert.match(stepText[2], /inbound sync compatibility window/iu);
  assert.match(
    stepText[3],
    /compatibility normalization before removing the MonoChrome registry\/CSS entry/iu,
  );
  assert.match(stepText[4], /Regenerate the theme contract TypeScript and prepaint artifacts/iu);
  assert.match(stepText[5], /only after the compatibility tests and preserved-theme checks pass/iu);

  const blocks = [...document.matchAll(proofBlockPattern)];
  assert.equal(blocks.length, 1, 'migration document must contain exactly one proof manifest');
  const proof = JSON.parse(blocks[0][1]);
  assert.deepEqual(Object.keys(proof).sort(), [
    'currentVerifiedEndpoint',
    'finalAcceptedEndpoint',
    'finalAcceptedEndpointStatus',
    'forwardVerifiedRange',
    'proofFiles',
    'rollbackContract',
    'schemaVersion',
  ]);
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.currentVerifiedEndpoint, currentVerifiedEndpoint);
  assert.equal(proof.forwardVerifiedRange, `12198b85..${currentVerifiedEndpoint}`);
  assert.equal(proof.finalAcceptedEndpointStatus, 'NOT_RUN');
  assert.equal(proof.finalAcceptedEndpoint, null);
  assert.deepEqual(proof.rollbackContract, {
    orderedSteps: [
      'normalize-persisted-values',
      'preserve-user-data-and-preferences',
      'keep-sync-compatibility-window',
      'remove-registry-css-after-normalization',
      'regenerate-contract-artifacts',
      'remove-presentation-assets-after-proof',
    ],
    prohibitedSemantics: [
      'delete-user-data',
      'registry-css-before-normalization',
      'resurrect-light',
      'blanket-revert',
    ],
  });
  assert.deepEqual(
    proof.proofFiles.map(({ path: proofPath }) => proofPath),
    expectedProofPaths,
  );

  for (const item of proof.proofFiles) {
    assert.deepEqual(Object.keys(item).sort(), ['path', 'sha256']);
    assertRepositoryRelative(item.path);
    await access(path.join(repoRoot, ...item.path.split('/')));
    assert.match(item.sha256, /^[0-9A-F]{64}$/u);
    assert.equal(
      item.sha256,
      sha256AtCommit(proof.currentVerifiedEndpoint, item.path),
      `${item.path} must match the immutable currentVerifiedEndpoint`,
    );
    if (!postMonochromeEvolutionPaths.has(item.path)) {
      assert.equal(
        item.sha256,
        await sha256(item.path),
        `${item.path} accepted proof must not drift outside an authorized successor theme`,
      );
    }
  }

  const rollbackSection = document.match(
    /## Compatibility-first rollback\r?\n([\s\S]*?)\r?\n## Rollback verification matrix/u,
  )?.[1];
  assert.ok(rollbackSection);
  assert.doesNotMatch(
    rollbackSection,
    /\b(?:may|must|should|can)\s+(?:delete|erase|destroy)\s+user data\b/iu,
  );
  assert.doesNotMatch(
    rollbackSection,
    /\b(?:remove|delete)\b[\s\S]{0,120}\bregistry\/CSS\b[\s\S]{0,120}\bbefore\b[\s\S]{0,120}\bcompatibility normalization\b/iu,
  );
  assert.doesNotMatch(
    rollbackSection,
    /\b(?:may|must|should|can)\s+resurrect Light as a selectable theme\b/iu,
  );
  assert.doesNotMatch(
    rollbackSection,
    /\bblanket revert\b[\s\S]{0,120}\b(?:permitted|allowed|required|recommended)\b/iu,
  );

  assert.doesNotMatch(document, /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/Users\/|\/home\/)/u);
  assert.doesNotMatch(document, /https?:\/\//iu);
  assert.doesNotMatch(
    document,
    /(?:sk-(?:proj|live|test)-|sk_(?:live|test)_|ghp_|github_pat_|xox[baprs]-|Bearer\s+[A-Za-z0-9._~-]+|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sb_(?:secret|publishable)_|service[_-]?role|secret[_-]?key)/iu,
  );
  assert.doesNotMatch(
    document,
    /(?:Remove-Item|rm\s+-rf|git\s+reset|git\s+clean|DROP\s+(?:TABLE|DATABASE))/iu,
  );

  return proof;
}

test('migration document binds the exact v5 contract, rollback order, and immutable proof', async () => {
  const [document, sourceText] = await Promise.all([
    readFile(documentPath, 'utf8'),
    readRelative('app/src/features/appearance/themeContract.source.json'),
  ]);
  const source = JSON.parse(sourceText);

  assert.equal(source.storageKey, 'jarvis-ui');
  assert.equal(source.storeVersion, 5);
  assert.equal(source.fallbackTheme, 'default');
  assert.deepEqual(
    source.selectableThemes.map(({ id }) => id),
    ['jarvis', 'vibespace', 'default', 'monochrome', 'sakura', 'warm', 'origami'],
  );
  assert.deepEqual(source.selectableThemes.at(-1), {
    id: 'origami',
    label: 'Origami',
    description: 'Sculpted paper workspace in motion.',
  });
  assert.deepEqual(source.persistedLegacyThemes, {
    light: 'monochrome',
    dark: 'default',
    system: 'default',
  });

  await validateDocument(document);
});

test('generated TypeScript and prepaint remain synchronized with the canonical source', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, [generatorPath, '--check'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  });
});

test('validator rejects unsafe contradictions while preserving required safe statements', async () => {
  const document = await readFile(documentPath, 'utf8');
  const proof = await validateDocument(document);

  await assert.rejects(
    validateDocument(
      document.replace(
        '6. Remove MonoChrome-only presentation assets',
        '6. Operators may delete user data during rollback. Remove MonoChrome-only presentation assets',
      ),
    ),
  );
  await assert.rejects(
    validateDocument(
      document.replace(
        '6. Remove MonoChrome-only presentation assets',
        '6. Remove the registry/CSS entry before compatibility normalization. Remove MonoChrome-only presentation assets',
      ),
    ),
  );
  await assert.rejects(
    validateDocument(
      document.replace(
        'The rollback must not resurrect Light as a selectable theme.',
        'The rollback must not resurrect Light as a selectable theme. Operators may resurrect Light as a selectable theme.',
      ),
    ),
  );
  await assert.rejects(
    validateDocument(
      document.replace(
        'A blanket revert',
        'A blanket revert is permitted for emergencies. A blanket revert',
      ),
    ),
  );

  const wrongHash = structuredClone(proof);
  wrongHash.proofFiles[0].sha256 = '0'.repeat(64);
  await assert.rejects(validateDocument(replaceProof(document, wrongHash)));

  const wrongEndpoint = structuredClone(proof);
  wrongEndpoint.currentVerifiedEndpoint = '0'.repeat(40);
  wrongEndpoint.forwardVerifiedRange = `12198b85..${'0'.repeat(40)}`;
  await assert.rejects(validateDocument(replaceProof(document, wrongEndpoint)));

  const traversal = structuredClone(proof);
  traversal.proofFiles[0].path = '../private.txt';
  await assert.rejects(validateDocument(replaceProof(document, traversal)));
});
