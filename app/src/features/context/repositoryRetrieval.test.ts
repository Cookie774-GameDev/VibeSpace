import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphSnapshotV2 } from './contracts';
import {
  createRepositoryRetrievalService,
  type RepositoryRetrievalDependencies,
  type RepositoryRetrievalFileRead,
} from './repositoryRetrieval';
import type { StructuralParserPort } from '@/features/repository-intelligence';

async function contentHash(content: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function snapshot(accountId = 'account-1'): ContextGraphSnapshotV2 {
  const paths = ['src/auth.ts', 'src/user.ts', '.env'];
  return {
    version: 2,
    map: {
      version: 2,
      id: 'map-1',
      accountId,
      projectId: 'project-1',
      name: 'Repository',
      status: 'active',
      sourceIds: ['source-1'],
      summary: '',
      recommendedEntryPoints: [],
      statistics: {
        sourceCount: 1,
        entityCount: 3,
        edgeCount: 1,
        noteCount: 0,
        attachmentCount: 0,
        staleSourceCount: 0,
      },
      createdAt: 1,
      updatedAt: 1,
      knowledgeRevision: 1,
    },
    sources: [
      {
        version: 2,
        id: 'source-1',
        accountId,
        mapId: 'map-1',
        kind: 'local_folder',
        label: 'Repository',
        status: 'ready',
        localRoot: 'opaque-root',
        createdAt: 1,
        updatedAt: 1,
        sourceRevision: 'repo-1',
        parserVersion: 1,
      },
    ],
    entities: paths.map((path, index) => ({
      version: 2,
      id: `entity-${index + 1}`,
      accountId,
      mapId: 'map-1',
      sourceId: 'source-1',
      kind: 'file' as const,
      label: path,
      path,
      summary: index === 0 ? 'Authentication entry point' : undefined,
      sourceRevision: 'repo-1',
      provenanceIds: [`provenance-${index + 1}`],
      createdAt: 1,
      updatedAt: 1,
    })),
    edges: [
      {
        version: 2,
        id: 'edge-1',
        accountId,
        mapId: 'map-1',
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-2',
        kind: 'imports',
        provenanceIds: ['provenance-edge-1'],
        confidence: 1,
        sourceRevision: 'repo-1',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    provenance: [
      ...paths.map((path, index) => ({
        version: 2 as const,
        id: `provenance-${index + 1}`,
        accountId,
        mapId: 'map-1',
        targetKind: 'entity' as const,
        targetId: `entity-${index + 1}`,
        sourceId: 'source-1',
        sourceKind: 'local_folder' as const,
        path,
        extractedAt: 1,
        parser: 'tree-sitter-typescript',
        confidence: 1,
        sourceRevision: 'repo-1',
      })),
      {
        version: 2,
        id: 'provenance-edge-1',
        accountId,
        mapId: 'map-1',
        targetKind: 'edge',
        targetId: 'edge-1',
        sourceId: 'source-1',
        sourceKind: 'local_folder',
        path: 'src/auth.ts',
        lineStart: 1,
        lineEnd: 1,
        extractedAt: 1,
        parser: 'tree-sitter-typescript',
        confidence: 1,
        sourceRevision: 'repo-1',
      },
    ],
  };
}

async function fixture() {
  const contents = new Map([
    ['src/auth.ts', "import { User } from './user';\nexport function auth(user: User) { return !!user; }"],
    ['src/user.ts', 'export interface User { id: string }'],
    ['.env', 'TOKEN=do-not-read'],
  ]);
  const files = new Map<string, RepositoryRetrievalFileRead>();
  for (const [path, content] of contents) {
    files.set(path, {
      path,
      content,
      contentHash: await contentHash(content),
      byteLength: new TextEncoder().encode(content).byteLength,
      language: 'typescript',
      ignored: false,
      generated: false,
      secretRisk: path === '.env',
      trusted: true,
    });
  }
  const parse = vi.fn<StructuralParserPort['parse']>(async (file) => ({
    path: file.path,
    language: file.language,
    contentHash: file.contentHash,
    signatureTokens: 10,
    metadataTokens: 5,
    symbols: [
      {
        name: file.path.includes('auth') ? 'auth' : 'User',
        kind: file.path.includes('auth') ? 'function' : 'type',
        startLine: file.path.includes('auth') ? 2 : 1,
        endLine: file.path.includes('auth') ? 2 : 1,
        exported: true,
      },
    ],
    incomingReferences: file.path.includes('user') ? 1 : 0,
    outgoingReferences: file.path.includes('auth') ? 1 : 0,
    parserId: `web-tree-sitter:${file.language}`,
    parserVersion: 'pinned-test',
    astHash: `ast:${file.contentHash}`,
  }));
  const inspectFiles = vi.fn<RepositoryRetrievalDependencies['inspectFiles']>(
    async ({ paths }) => paths.map((path) => ({ ...files.get(path)!, content: undefined })),
  );
  const readFile = vi.fn<RepositoryRetrievalDependencies['readFile']>(
    async ({ rootId, path, expectedContentHash }) => {
      expect(rootId).toBe('root-1');
      expect(files.get(path)?.contentHash).toBe(expectedContentHash);
      return files.get(path)!;
    },
  );
  const dependencies: RepositoryRetrievalDependencies = {
    loadActiveContextMap: async () => snapshot(),
    resolveRepository: async () => ({
      rootId: 'root-1',
      repositoryRevision: 'repo-1',
      sourceIds: ['source-1'],
    }),
    inspectFiles,
    readFile,
    countTokens: async () => 20,
    parser: { parse },
  };
  return { dependencies, files, parse, inspectFiles, readFile };
}

describe('repository retrieval seam', () => {
  it('returns bounded source-backed context and never reads secret-risk files', async () => {
    const { dependencies, parse, inspectFiles, readFile } = await fixture();
    const service = createRepositoryRetrievalService(dependencies);
    const result = await service.retrieve({
      accountId: 'account-1',
      projectId: 'project-1',
      taskText: 'change auth user behavior',
      tokenBudget: 100,
      activePaths: ['src/auth.ts'],
    });

    expect(inspectFiles).toHaveBeenCalledWith({
      rootId: 'root-1',
      paths: expect.arrayContaining(['src/auth.ts', 'src/user.ts', '.env']),
    });
    expect(readFile.mock.calls.map(([input]) => input.path)).toEqual([
      'src/auth.ts',
      'src/user.ts',
    ]);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      mapId: 'map-1',
      repositoryRevision: 'repo-1',
      items: [
        {
          path: 'src/auth.ts',
          whySelected: expect.arrayContaining(['active_file', 'task_relevance']),
          evidence: {
            entityId: 'entity-1',
            provenanceId: 'provenance-1',
            parserId: 'web-tree-sitter:typescript',
          },
        },
        {
          path: 'src/user.ts',
          evidence: { entityId: 'entity-2', provenanceId: 'provenance-2' },
        },
      ],
      relationships: [
        {
          sourceEntityId: 'entity-1',
          targetEntityId: 'entity-2',
          evidence: { provenanceId: 'provenance-edge-1' },
        },
      ],
      exclusions: expect.arrayContaining([{ path: '.env', reason: 'secret_risk' }]),
      totalTokens: 40,
      remainingTokens: 60,
    });
  });

  it('parses only changed hashes and does not rebuild unchanged repository files', async () => {
    const { dependencies, files, parse } = await fixture();
    const service = createRepositoryRetrievalService(dependencies);
    const request = {
      accountId: 'account-1',
      projectId: 'project-1',
      taskText: 'change auth user behavior',
      tokenBudget: 100,
      activePaths: ['src/auth.ts'],
    } as const;

    const first = await service.retrieve(request);
    const second = await service.retrieve(request);
    expect(first.parsedChangedPaths).toEqual(['src/auth.ts', 'src/user.ts']);
    expect(second.parsedChangedPaths).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(2);

    const previous = files.get('src/auth.ts')!;
    const content = `${previous.content}\nexport const changed = true;`;
    files.set('src/auth.ts', {
      ...previous,
      content,
      contentHash: await contentHash(content),
      byteLength: new TextEncoder().encode(content).byteLength,
    });
    const third = await service.retrieve(request);
    expect(third.parsedChangedPaths).toEqual(['src/auth.ts']);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it('fails closed on account/map authority mismatch before file inspection', async () => {
    const { dependencies, inspectFiles, readFile } = await fixture();
    dependencies.loadActiveContextMap = async () => snapshot('other-account');
    const service = createRepositoryRetrievalService(dependencies);
    await expect(
      service.retrieve({
        accountId: 'account-1',
        projectId: 'project-1',
        taskText: 'inspect auth',
        tokenBudget: 100,
      }),
    ).rejects.toThrow(/authority mismatch/i);
    expect(inspectFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('inspects only the configured metadata-ranked candidate ceiling', async () => {
    const { dependencies, inspectFiles } = await fixture();
    dependencies.maximumCandidates = 2;
    const service = createRepositoryRetrievalService(dependencies);
    await service.retrieve({
      accountId: 'account-1',
      projectId: 'project-1',
      taskText: 'auth',
      tokenBudget: 100,
      activePaths: ['src/auth.ts'],
    });
    expect(inspectFiles.mock.calls[0]?.[0].paths).toHaveLength(2);
  });
});
