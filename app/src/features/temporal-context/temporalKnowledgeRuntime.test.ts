import { describe, expect, it } from 'vitest';
import { createTemporalKnowledgeIndex } from './temporalKnowledge';

describe('repository temporal knowledge contract', () => {
  it('keeps superseded repository evidence recoverable', () => {
    const index = createTemporalKnowledgeIndex({
      accountId: 'account-1',
      projectId: 'project-1',
    });
    index.introduce({
      expectedRevision: 0,
      fact: {
        id: 'fact-old',
        accountId: 'account-1',
        projectId: 'project-1',
        subjectRef: 'entity-1',
        predicate: 'repository_content_hash',
        valueRef: `sha256:${'a'.repeat(64)}`,
        sourceEvidenceRef: 'provenance-old',
        sourceRevision: 'revision-1',
        observedAt: 1,
      },
    });
    index.supersede({
      expectedRevision: 1,
      previousFactId: 'fact-old',
      replacement: {
        id: 'fact-new',
        accountId: 'account-1',
        projectId: 'project-1',
        subjectRef: 'entity-1',
        predicate: 'repository_content_hash',
        valueRef: `sha256:${'b'.repeat(64)}`,
        sourceEvidenceRef: 'provenance-new',
        sourceRevision: 'revision-2',
        observedAt: 2,
      },
    });

    expect(index.get('fact-old')).toMatchObject({
      state: 'superseded',
      validUntil: 2,
      supersededById: 'fact-new',
    });
    expect(index.get('fact-new')).toMatchObject({
      state: 'current',
      supersedesId: 'fact-old',
    });
  });
});
