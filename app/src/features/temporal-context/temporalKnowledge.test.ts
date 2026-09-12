import { describe, expect, it } from 'vitest';
import { createTemporalKnowledgeIndex, type TemporalKnowledgeFactInput } from './index';

const fact = (overrides: Partial<TemporalKnowledgeFactInput> = {}): TemporalKnowledgeFactInput => ({
  id: 'fact-1',
  accountId: 'account-1',
  projectId: 'project-1',
  subjectRef: 'symbol://auth/login',
  predicate: 'uses_provider',
  valueRef: 'model://provider-v1',
  sourceEvidenceRef: 'evidence://commit-1/file.ts:10',
  sourceRevision: 'commit-1',
  observedAt: 100,
  ...overrides,
});

describe('temporal knowledge index', () => {
  it('introduces an evidenced current fact and verifies it monotonically', () => {
    const index = createTemporalKnowledgeIndex({
      accountId: 'account-1',
      projectId: 'project-1',
    });

    const introduced = index.introduce({ expectedRevision: 0, fact: fact() });
    expect(introduced).toMatchObject({
      revision: 1,
      fact: {
        id: 'fact-1',
        state: 'current',
        validFrom: 100,
        validUntil: null,
        lastVerifiedAt: 100,
      },
    });
    expect(
      index.verify({
        expectedRevision: 1,
        factId: 'fact-1',
        verifiedAt: 150,
        evidenceRef: 'evidence://commit-1/recheck',
      }),
    ).toMatchObject({
      revision: 2,
      fact: { lastVerifiedAt: 150, verificationEvidenceRef: 'evidence://commit-1/recheck' },
    });
  });

  it('supersedes without deleting history and links both facts', () => {
    const index = createTemporalKnowledgeIndex({
      accountId: 'account-1',
      projectId: 'project-1',
    });
    index.introduce({ expectedRevision: 0, fact: fact() });
    index.supersede({
      expectedRevision: 1,
      previousFactId: 'fact-1',
      replacement: fact({
        id: 'fact-2',
        valueRef: 'model://provider-v2',
        sourceEvidenceRef: 'evidence://commit-2/file.ts:12',
        sourceRevision: 'commit-2',
        observedAt: 200,
      }),
    });

    expect(index.get('fact-1')).toMatchObject({
      state: 'superseded',
      validUntil: 200,
      supersededById: 'fact-2',
    });
    expect(index.get('fact-2')).toMatchObject({
      state: 'current',
      supersedesId: 'fact-1',
      validFrom: 200,
    });
  });

  it('marks disputes and unavailable source material with evidence', () => {
    const index = createTemporalKnowledgeIndex({
      accountId: 'account-1',
      projectId: 'project-1',
    });
    index.introduce({ expectedRevision: 0, fact: fact() });
    index.dispute({
      expectedRevision: 1,
      factId: 'fact-1',
      observedAt: 120,
      evidenceRef: 'evidence://review-1',
    });
    expect(index.get('fact-1')).toMatchObject({
      state: 'disputed',
      stateEvidenceRef: 'evidence://review-1',
    });
    index.markSourceUnavailable({
      expectedRevision: 2,
      sourceEvidenceRef: 'evidence://commit-1/file.ts:10',
      observedAt: 130,
      evidenceRef: 'evidence://source-deleted',
    });
    expect(index.get('fact-1')).toMatchObject({
      state: 'unavailable',
      stateEvidenceRef: 'evidence://source-deleted',
    });
  });

  it('rejects cross-scope facts, missing evidence, duplicate IDs, and stale revisions', () => {
    const index = createTemporalKnowledgeIndex({
      accountId: 'account-1',
      projectId: 'project-1',
    });
    expect(() =>
      index.introduce({
        expectedRevision: 0,
        fact: fact({ accountId: 'account-2' }),
      }),
    ).toThrow(/scope/i);
    expect(() =>
      index.introduce({
        expectedRevision: 0,
        fact: fact({ sourceEvidenceRef: '' }),
      }),
    ).toThrow(/evidence/i);
    index.introduce({ expectedRevision: 0, fact: fact() });
    expect(() => index.introduce({ expectedRevision: 1, fact: fact() })).toThrow(/already exists/i);
    expect(() =>
      index.verify({
        expectedRevision: 0,
        factId: 'fact-1',
        verifiedAt: 200,
        evidenceRef: 'evidence://stale',
      }),
    ).toThrow(/revision/i);
  });
});
