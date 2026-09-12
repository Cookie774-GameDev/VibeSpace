import { describe, expect, it } from 'vitest';
import type { ContextGraphSnapshotV2 } from '@/features/context/contracts';
import type { TemporalKnowledgeFact } from './contracts';
import { projectTemporalKnowledgeToContextMap } from './contextMapBridge';

const snapshot: ContextGraphSnapshotV2 = {
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
    knowledgeRevision: 3,
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
      sourceRevision: 'commit-1',
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
      sourceRevision: 'commit-1',
    },
  ],
};

const fact = (overrides: Partial<TemporalKnowledgeFact> = {}): TemporalKnowledgeFact => ({
  id: 'fact-1',
  accountId: 'account-1',
  projectId: 'project-1',
  subjectRef: 'entity-1',
  predicate: 'implements',
  valueRef: 'authentication',
  sourceEvidenceRef: 'provenance-1',
  sourceRevision: 'commit-1',
  observedAt: 1,
  state: 'current',
  validFrom: 1,
  validUntil: null,
  supersedesId: null,
  supersededById: null,
  lastVerifiedAt: 1,
  verificationEvidenceRef: 'provenance-1',
  stateEvidenceRef: 'provenance-1',
  ...overrides,
});

describe('temporal Context Map bridge', () => {
  it('projects current evidence and excludes historical facts by default', () => {
    expect(
      projectTemporalKnowledgeToContextMap({
        snapshot,
        projectId: 'project-1',
        knowledgeRevision: 4,
        facts: [fact(), fact({ id: 'fact-2', state: 'superseded', validUntil: 3 })],
      }),
    ).toMatchObject({
      mapId: 'map-1',
      knowledgeRevision: 4,
      nodes: [{ factId: 'fact-1', entity: { id: 'entity-1' } }],
      excluded: [{ factId: 'fact-2', reason: 'historical' }],
    });
  });

  it('fails closed on scope mismatch and records missing evidence', () => {
    expect(() =>
      projectTemporalKnowledgeToContextMap({
        snapshot,
        projectId: 'other-project',
        knowledgeRevision: 4,
        facts: [],
      }),
    ).toThrow(/scope/i);
    expect(
      projectTemporalKnowledgeToContextMap({
        snapshot,
        projectId: 'project-1',
        knowledgeRevision: 4,
        facts: [fact({ sourceEvidenceRef: 'missing' })],
      }).excluded,
    ).toEqual([{ factId: 'fact-1', reason: 'missing_provenance' }]);
  });
});
