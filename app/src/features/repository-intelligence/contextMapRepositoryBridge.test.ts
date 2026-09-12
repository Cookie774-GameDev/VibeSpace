import { describe, expect, it } from 'vitest';
import type { ContextGraphSnapshotV2 } from '@/features/context/contracts';
import type { RepositoryContextPack } from './contracts';
import { projectRepositoryPackToContextMap } from './contextMapRepositoryBridge';

const pack: RepositoryContextPack = {
  entries: [
    {
      path: 'src/auth.ts',
      language: 'typescript',
      representation: 'signatures',
      tokens: 40,
      score: 4,
      reasons: ['task_relevance'],
      symbols: [],
    },
  ],
  exclusions: [],
  totalTokens: 40,
  remainingTokens: 60,
};

const snapshot = (revision = 'commit-1'): ContextGraphSnapshotV2 => ({
  version: 2,
  map: {
    version: 2,
    id: 'map-1',
    accountId: 'account-1',
    projectId: 'project-1',
    name: 'Project',
    status: 'active',
    sourceIds: ['source-1'],
    summary: '',
    recommendedEntryPoints: [],
    statistics: {
      sourceCount: 1,
      entityCount: 1,
      edgeCount: 0,
      noteCount: 0,
      attachmentCount: 0,
      staleSourceCount: 0,
    },
    createdAt: 1,
    updatedAt: 1,
    knowledgeRevision: 1,
  },
  sources: [],
  entities: [
    {
      version: 2,
      id: 'entity-1',
      accountId: 'account-1',
      mapId: 'map-1',
      sourceId: 'source-1',
      kind: 'file',
      label: 'auth.ts',
      path: 'src/auth.ts',
      sourceRevision: revision,
      provenanceIds: ['provenance-1'],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  edges: [],
  provenance: [
    {
      version: 2,
      id: 'provenance-1',
      accountId: 'account-1',
      mapId: 'map-1',
      targetKind: 'entity',
      targetId: 'entity-1',
      sourceId: 'source-1',
      sourceKind: 'local_folder',
      path: 'src/auth.ts',
      extractedAt: 1,
      parser: 'tree-sitter-typescript',
      confidence: 1,
      sourceRevision: revision,
    },
  ],
});

describe('repository Context Map bridge', () => {
  it('creates a source-backed receipt for an exact repository revision', () => {
    expect(
      projectRepositoryPackToContextMap({
        pack,
        snapshot: snapshot(),
        repositoryCommit: 'commit-1',
      }),
    ).toMatchObject({
      receipts: [
        {
          reference: { entityId: 'entity-1', path: 'src/auth.ts' },
          representation: 'signatures',
          tokens: 40,
          sourceRevision: 'commit-1',
        },
      ],
      excluded: [],
    });
  });

  it('fails closed when Context Map evidence is stale', () => {
    expect(
      projectRepositoryPackToContextMap({
        pack,
        snapshot: snapshot('commit-old'),
        repositoryCommit: 'commit-1',
      }),
    ).toMatchObject({
      receipts: [],
      excluded: [{ path: 'src/auth.ts', reason: 'stale_evidence' }],
    });
  });
});
