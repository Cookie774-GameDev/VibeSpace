import { describe, expect, it, vi } from 'vitest';
import {
  createStructuralRepositoryService,
  type StructuralParserPort,
  type StructuralRepositoryFile,
} from './index';

const file = (
  path: string,
  contentHash: string,
  overrides: Partial<StructuralRepositoryFile> = {},
): StructuralRepositoryFile => ({
  path,
  language: 'typescript',
  content: 'export function authenticate() { return true; }',
  contentHash,
  fullTokens: 500,
  trusted: true,
  ignored: false,
  generated: false,
  secretRisk: false,
  ...overrides,
});

describe('structural repository service', () => {
  it('parses only changed hashes, removes deleted paths, and creates a bounded pack', async () => {
    const parse = vi.fn<StructuralParserPort['parse']>(async (input) => ({
      path: input.path,
      language: input.language,
      contentHash: input.contentHash,
      signatureTokens: 100,
      metadataTokens: 20,
      symbols: [],
      incomingReferences: input.path.endsWith('auth.ts') ? 6 : 0,
      outgoingReferences: 1,
      parserId: 'tree-sitter-typescript',
      parserVersion: 'pinned-test',
      astHash: `ast:${input.contentHash}`,
    }));
    const service = createStructuralRepositoryService({ parse });

    await service.update({
      repositoryCommit: 'commit-1',
      changedFiles: [file('src/auth.ts', 'hash-1'), file('src/unused.ts', 'hash-2')],
      deletedPaths: [],
    });
    await service.update({
      repositoryCommit: 'commit-2',
      changedFiles: [file('src/auth.ts', 'hash-1')],
      deletedPaths: ['src/unused.ts'],
    });

    expect(parse).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toMatchObject({
      revision: 2,
      repositoryCommit: 'commit-2',
      files: [{ path: 'src/auth.ts', contentHash: 'hash-1' }],
    });
    expect(
      service.buildContext({
        tokenBudget: 150,
        signals: { 'src/auth.ts': { taskRelevance: 1 } },
        filePolicies: {
          'src/auth.ts': {
            fullTokens: 500,
            trusted: true,
            ignored: false,
            generated: false,
            secretRisk: false,
          },
        },
      }),
    ).toMatchObject({
      entries: [{ path: 'src/auth.ts', representation: 'signatures', tokens: 100 }],
      totalTokens: 100,
      remainingTokens: 50,
    });
  });

  it('rejects parser identity mismatches and changed/deleted conflicts', async () => {
    const service = createStructuralRepositoryService({
      parse: async (input) => ({
        path: 'wrong.ts',
        language: input.language,
        contentHash: input.contentHash,
        signatureTokens: 1,
        metadataTokens: 1,
        symbols: [],
        incomingReferences: 0,
        outgoingReferences: 0,
        parserId: 'parser',
        parserVersion: '1',
        astHash: 'ast',
      }),
    });
    await expect(
      service.update({
        repositoryCommit: 'commit-1',
        changedFiles: [file('src/auth.ts', 'hash-1')],
        deletedPaths: [],
      }),
    ).rejects.toThrow(/parser result/i);
    await expect(
      service.update({
        repositoryCommit: 'commit-2',
        changedFiles: [file('src/auth.ts', 'hash-2')],
        deletedPaths: ['src/auth.ts'],
      }),
    ).rejects.toThrow(/conflicting/i);
  });

  it('keeps the previous snapshot when any changed-file parse fails', async () => {
    const service = createStructuralRepositoryService({
      parse: async (input) => {
        if (input.path === 'src/broken.ts') throw new Error('parser failed');
        return {
          path: input.path,
          language: input.language,
          contentHash: input.contentHash,
          signatureTokens: 20,
          metadataTokens: 10,
          symbols: [],
          incomingReferences: 0,
          outgoingReferences: 0,
          parserId: 'parser',
          parserVersion: '1',
          astHash: `ast:${input.contentHash}`,
        };
      },
    });
    await service.update({
      repositoryCommit: 'commit-1',
      changedFiles: [file('src/stable.ts', 'hash-1')],
      deletedPaths: [],
    });

    await expect(
      service.update({
        repositoryCommit: 'commit-2',
        changedFiles: [file('src/good.ts', 'hash-2'), file('src/broken.ts', 'hash-3')],
        deletedPaths: ['src/stable.ts'],
      }),
    ).rejects.toThrow(/parser failed/i);

    expect(service.snapshot()).toMatchObject({
      revision: 1,
      repositoryCommit: 'commit-1',
      files: [{ path: 'src/stable.ts' }],
    });
  });
});
