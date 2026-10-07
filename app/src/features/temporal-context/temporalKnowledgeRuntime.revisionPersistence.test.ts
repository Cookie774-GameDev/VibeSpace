import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTemporalKnowledgeIndex } from './temporalKnowledge';
import { closeDb, db, openDb } from '@/lib/db';
import type { RepositoryRetrievalResult } from '@/features/context/repositoryRetrieval';
import {
  loadRepositoryTemporalKnowledge,
  recordRepositoryTemporalKnowledge,
} from './temporalKnowledgeRuntime';

const scope = { accountId: 't01-account-a', projectId: 't01-project-a' };
const keyPrefix = 'temporal-knowledge-v1:t01-';
const hash = (letter: string) => `sha256:${letter.repeat(64)}`;
function result(letter: string, revision: number): RepositoryRetrievalResult {
  return {
    mapId: 't01-map',
    repositoryRevision: `revision-${revision}`,
    structuralRevision: revision,
    items: [
      {
        path: 'src/owned.ts',
        language: 'typescript',
        representation: 'full',
        content: `export const value = '${letter}';`,
        tokens: 10,
        whySelected: [],
        symbols: [],
        evidence: {
          mapId: 't01-map',
          entityId: 't01-entity',
          sourceId: 't01-source',
          provenanceId: `t01-provenance-${revision}`,
          sourceRevision: `source-${revision}`,
          repositoryRevision: `revision-${revision}`,
          contentHash: hash(letter),
          astHash: hash(letter),
          parserId: 'synthetic-parser',
          parserVersion: '1',
        },
      },
    ],
    relationships: [],
    exclusions: [],
    totalTokens: 10,
    remainingTokens: 990,
    parsedChangedPaths: ['src/owned.ts'],
  };
}
const record = (letter: string, revision: number, target = scope) =>
  recordRepositoryTemporalKnowledge({
    ...target,
    result: result(letter, revision),
    observedAt: revision,
  });

beforeEach(async () => {
  await openDb();
  await db.settings.where('key').startsWith(keyPrefix).delete();
});
afterEach(async () => {
  await openDb();
  await db.settings.where('key').startsWith(keyPrefix).delete();
  await closeDb();
});

describe('production temporal persistence across repository revisions', () => {
  it('records and reopens a first observed revision through the actual Dexie adapter', async () => {
    const initial = await record('a', 1);
    expect(initial).toMatchObject({
      revision: 1,
      facts: [{ state: 'current', valueRef: hash('a') }],
    });
    await closeDb();
    expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(initial);
  });

  it('records A to B to A without colliding with the preserved first A fact', async () => {
    const first = await record('a', 1);
    const second = await record('b', 2);
    const historicalA = second.facts.find((fact) => fact.id === first.facts[0]!.id)!;
    await closeDb();
    const third = await record('a', 3);
    expect(third.facts).toHaveLength(3);
    expect(new Set(third.facts.map((fact) => fact.id)).size).toBe(3);
    expect(third.facts.find((fact) => fact.id === historicalA.id)).toEqual(historicalA);
    const current = third.facts.filter((fact) => fact.state === 'current');
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      valueRef: hash('a'),
      sourceRevision: 'revision-3',
      sourceEvidenceRef: 't01-provenance-3',
      validFrom: 3,
    });
    expect(current[0]!.id).not.toBe(historicalA.id);
    expect(current[0]!.supersedesId).toBe(
      second.facts.find((fact) => fact.state === 'current')!.id,
    );
    await closeDb();
    expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(third);
  });
});

it('keeps a unique linked history through repeated A/B cycles and reopens', async () => {
  for (const [index, letter] of ['a', 'b', 'a', 'b', 'a'].entries()) {
    await record(letter, index + 1);
    await closeDb();
  }
  const final = await loadRepositoryTemporalKnowledge(scope);
  expect(final.facts).toHaveLength(5);
  expect(new Set(final.facts.map((fact) => fact.id)).size).toBe(5);
  expect(final.facts.map((fact) => fact.valueRef)).toEqual(['a', 'b', 'a', 'b', 'a'].map(hash));
  final.facts.forEach((fact, index) => {
    expect(fact.supersedesId).toBe(index ? final.facts[index - 1]!.id : null);
    expect(fact.supersededById).toBe(index < 4 ? final.facts[index + 1]!.id : null);
    expect(fact.state).toBe(index < 4 ? 'superseded' : 'current');
  });
});

it('continues a legacy content-derived history without rewriting its old facts', async () => {
  const index = createTemporalKnowledgeIndex(scope);
  const oldA = 'temporal_repo_6307d51d7065722796d87cc2cb947bc9';
  const oldB = 'temporal_repo_d2e50d6de277e77a95bcbc4f938c3ea2';
  const fact = (id: string, letter: string, observedAt: number) => ({
    ...scope,
    id,
    subjectRef: 't01-entity',
    predicate: 'repository_content_hash',
    valueRef: hash(letter),
    sourceEvidenceRef: `t01-provenance-${observedAt}`,
    sourceRevision: `revision-${observedAt}`,
    observedAt,
  });
  index.introduce({ expectedRevision: 0, fact: fact(oldA, 'a', 1) });
  index.supersede({ expectedRevision: 1, previousFactId: oldA, replacement: fact(oldB, 'b', 2) });
  const legacy = index.snapshot();
  await db.settings.put({
    key: `${keyPrefix}account-a:t01-project-a`,
    value: {
      schemaVersion: 1,
      snapshot: legacy,
      idempotencyKeys: [`introduce:${oldA}`, `supersede:${oldA}:${oldB}`],
    },
    updated_at: 2,
  });
  await closeDb();
  expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(legacy);
  const current = await record('a', 3);
  expect(current.facts.find((fact) => fact.id === oldA)).toEqual(legacy.facts[0]);
  expect(current.facts.find((fact) => fact.id === oldB)).toMatchObject({
    state: 'superseded',
    validUntil: 3,
  });
  expect(current.facts.filter((fact) => fact.state === 'current')).toEqual([
    expect.objectContaining({ valueRef: hash('a'), supersedesId: oldB }),
  ]);
  expect(current.facts).toHaveLength(3);
});

it('keeps repeated current observations idempotent after a content recurrence', async () => {
  await record('a', 1);
  await record('b', 2);
  await record('a', 3);
  const verified = await record('a', 3);
  await closeDb();
  expect(await record('a', 3)).toEqual(verified);
  expect((await loadRepositoryTemporalKnowledge(scope)).facts).toHaveLength(3);
});

it('isolates histories when accounts and projects reuse the same entity and content', async () => {
  const otherAccount = { ...scope, accountId: 't01-account-b' };
  const otherProject = { ...scope, projectId: 't01-project-b' };
  const accountBefore = await record('a', 1, otherAccount);
  const projectBefore = await record('a', 1, otherProject);
  await record('a', 1);
  await record('b', 2);
  const current = await record('a', 3);
  expect(await loadRepositoryTemporalKnowledge(otherAccount)).toEqual(accountBefore);
  expect(await loadRepositoryTemporalKnowledge(otherProject)).toEqual(projectBefore);
  expect(
    current.facts.every(
      (fact) => fact.accountId === scope.accountId && fact.projectId === scope.projectId,
    ),
  ).toBe(true);
  expect(
    new Set([current.facts[0]!.id, accountBefore.facts[0]!.id, projectBefore.facts[0]!.id]).size,
  ).toBe(3);
});

it('rolls back a failed real settings transaction and allows a later recurrence retry', async () => {
  await record('a', 1);
  const before = await record('b', 2);
  const rejectWrite = () => {
    throw new Error('synthetic temporal write unavailable');
  };
  db.settings.hook('updating', rejectWrite);
  try {
    await expect(record('a', 3)).rejects.toThrow('synthetic temporal write unavailable');
  } finally {
    db.settings.hook('updating').unsubscribe(rejectWrite);
  }
  expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(before);
  expect((await record('a', 3)).facts).toHaveLength(3);
});

it('keeps the actual adapter CAS fence when two writers observe one predecessor', async () => {
  await record('a', 1);
  const realDigest = crypto.subtle.digest.bind(crypto.subtle);
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    count += 1;
    await gate;
    return realDigest(algorithm, data);
  });
  const results = Promise.allSettled([record('b', 2), record('c', 3)]);
  try {
    await vi.waitFor(() => expect(count).toBe(2));
    release();
    const settled = await results;
    expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((row) => row.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toMatch(/storage conflict/);
    const durable = await loadRepositoryTemporalKnowledge(scope);
    expect(durable.facts).toHaveLength(2);
    expect(durable.facts.filter((fact) => fact.state === 'current')).toHaveLength(1);
    const accepted = settled.find((row) => row.status === 'fulfilled');
    expect(accepted?.status === 'fulfilled' && accepted.value).toEqual(durable);
  } finally {
    release();
    await results;
    digest.mockRestore();
  }
});
