import { describe, expect, it } from 'vitest';
import {
  buildRepositoryContextPack,
  rankRepositoryCandidates,
  type RepositoryCandidate,
} from './index';

const candidate = (
  path: string,
  overrides: Partial<RepositoryCandidate> = {},
): RepositoryCandidate => ({
  path,
  projectRelative: true,
  language: 'typescript',
  fullTokens: 500,
  signatureTokens: 120,
  metadataTokens: 30,
  lexicalRelevance: 0,
  taskRelevance: 0,
  incomingReferences: 0,
  outgoingReferences: 0,
  explicit: false,
  active: false,
  importedByActiveFile: false,
  userPinned: false,
  trusted: true,
  ignored: false,
  generated: false,
  secretRisk: false,
  symbols: [],
  ...overrides,
});

describe('repository intelligence', () => {
  it('ranks explicit, active, referenced, and central files with transparent reasons', () => {
    const ranked = rankRepositoryCandidates([
      candidate('src/unrelated.ts'),
      candidate('src/central.ts', {
        incomingReferences: 12,
        outgoingReferences: 4,
        taskRelevance: 0.5,
      }),
      candidate('src/active.ts', { active: true, lexicalRelevance: 0.6 }),
      candidate('src/explicit.ts', { explicit: true }),
    ]);

    expect(ranked.map(({ path }) => path)).toEqual([
      'src/explicit.ts',
      'src/active.ts',
      'src/central.ts',
      'src/unrelated.ts',
    ]);
    expect(ranked[0]?.reasons).toContain('explicitly_selected');
    expect(ranked[1]?.reasons).toContain('active_file');
    expect(ranked[2]?.reasons).toContain('reference_centrality');
  });

  it('fails closed for ignored, generated, secret-risk, untrusted, and outside-project files', () => {
    const pack = buildRepositoryContextPack({
      candidates: [
        candidate('src/allowed.ts', { taskRelevance: 1 }),
        candidate('.env', { secretRisk: true, taskRelevance: 1 }),
        candidate('dist/bundle.js', { generated: true, taskRelevance: 1 }),
        candidate('vendor/ignored.ts', { ignored: true, taskRelevance: 1 }),
        candidate('../outside.ts', { projectRelative: false, taskRelevance: 1 }),
        candidate('download/untrusted.ts', { trusted: false, taskRelevance: 1 }),
      ],
      tokenBudget: 1_000,
    });

    expect(pack.entries.map(({ path }) => path)).toEqual(['src/allowed.ts']);
    expect(pack.exclusions).toEqual(
      expect.arrayContaining([
        { path: '.env', reason: 'secret_risk' },
        { path: 'dist/bundle.js', reason: 'generated' },
        { path: 'vendor/ignored.ts', reason: 'ignored' },
        { path: '../outside.ts', reason: 'outside_project' },
        { path: 'download/untrusted.ts', reason: 'untrusted' },
      ]),
    );
  });

  it('packs full, signatures, or metadata deterministically within budget', () => {
    const pack = buildRepositoryContextPack({
      candidates: [
        candidate('src/first.ts', {
          explicit: true,
          fullTokens: 600,
          signatureTokens: 150,
          metadataTokens: 40,
        }),
        candidate('src/second.ts', {
          taskRelevance: 0.9,
          fullTokens: 500,
          signatureTokens: 130,
          metadataTokens: 35,
        }),
        candidate('src/third.ts', {
          taskRelevance: 0.8,
          fullTokens: 400,
          signatureTokens: 120,
          metadataTokens: 30,
        }),
      ],
      tokenBudget: 800,
    });

    expect(pack.entries).toEqual([
      expect.objectContaining({
        path: 'src/first.ts',
        representation: 'full',
        tokens: 600,
      }),
      expect.objectContaining({
        path: 'src/second.ts',
        representation: 'signatures',
        tokens: 130,
      }),
      expect.objectContaining({
        path: 'src/third.ts',
        representation: 'metadata',
        tokens: 30,
      }),
    ]);
    expect(pack.totalTokens).toBe(760);
    expect(pack.remainingTokens).toBe(40);
  });

  it('rejects duplicate paths and unsafe token estimates', () => {
    expect(() =>
      rankRepositoryCandidates([candidate('src/same.ts'), candidate('src/same.ts')]),
    ).toThrow(/duplicate/i);
    expect(() =>
      buildRepositoryContextPack({
        candidates: [candidate('src/bad.ts', { signatureTokens: 600, fullTokens: 500 })],
        tokenBudget: 1_000,
      }),
    ).toThrow(/token estimate/i);
  });
});
