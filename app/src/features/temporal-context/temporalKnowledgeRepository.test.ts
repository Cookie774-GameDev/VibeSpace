import { describe, expect, it } from 'vitest';
import type { TemporalKnowledgeSnapshot } from './contracts';
import {
  openTemporalKnowledgeRepository,
  type TemporalKnowledgeStoragePort,
} from './temporalKnowledgeRepository';

const fact = {
  id: 'fact-1',
  accountId: 'account-1',
  projectId: 'project-1',
  subjectRef: 'entity-1',
  predicate: 'implements',
  valueRef: 'authentication',
  sourceEvidenceRef: 'provenance-1',
  sourceRevision: 'commit-1',
  observedAt: 1,
};

describe('temporal knowledge repository', () => {
  it('persists an optimistic mutation and restores it after restart', async () => {
    let stored: TemporalKnowledgeSnapshot | undefined;
    const keys = new Map<string, TemporalKnowledgeSnapshot>();
    const storage: TemporalKnowledgeStoragePort = {
      load: async () => stored,
      compareAndSwap: async (input) => {
        const duplicate = keys.get(input.idempotencyKey);
        if (duplicate) return { status: 'duplicate', snapshot: duplicate };
        if ((stored?.revision ?? 0) !== input.expectedRevision) {
          return { status: 'conflict', currentRevision: stored?.revision ?? 0 };
        }
        stored = input.snapshot;
        keys.set(input.idempotencyKey, input.snapshot);
        return { status: 'stored', snapshot: input.snapshot };
      },
    };
    const repository = await openTemporalKnowledgeRepository(storage, {
      accountId: 'account-1',
      projectId: 'project-1',
    });
    await repository.execute({
      expectedRevision: 0,
      idempotencyKey: 'introduce-fact-1',
      command: { kind: 'introduce', fact },
    });

    const restarted = await openTemporalKnowledgeRepository(storage, {
      accountId: 'account-1',
      projectId: 'project-1',
    });
    expect(restarted.snapshot()).toMatchObject({
      revision: 1,
      facts: [{ id: 'fact-1', state: 'current' }],
    });
  });

  it('does not advance memory when durable storage reports a conflict', async () => {
    const repository = await openTemporalKnowledgeRepository(
      {
        load: async () => undefined,
        compareAndSwap: async () => ({ status: 'conflict', currentRevision: 2 }),
      },
      { accountId: 'account-1', projectId: 'project-1' },
    );
    await expect(
      repository.execute({
        expectedRevision: 0,
        idempotencyKey: 'introduce-fact-1',
        command: { kind: 'introduce', fact },
      }),
    ).rejects.toThrow(/conflict/i);
    expect(repository.snapshot()).toMatchObject({ revision: 0, facts: [] });
  });
});
