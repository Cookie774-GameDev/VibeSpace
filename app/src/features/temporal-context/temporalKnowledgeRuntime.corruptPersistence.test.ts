import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db, openDb } from '@/lib/db';
import { createTemporalKnowledgeIndex } from './temporalKnowledge';
import { loadRepositoryTemporalKnowledge } from './temporalKnowledgeRuntime';

const scope = { accountId: 't02-account', projectId: 't02-project' };
const key = 'temporal-knowledge-v1:t02-account:t02-project';
const otherKey = 'temporal-knowledge-v1:t02-other:t02-project';
function validSnapshot() {
  const index = createTemporalKnowledgeIndex(scope);
  index.introduce({
    expectedRevision: 0,
    fact: {
      ...scope,
      id: 't02-fact',
      subjectRef: 't02-entity',
      predicate: 'repository_content_hash',
      valueRef: `sha256:${'a'.repeat(64)}`,
      sourceEvidenceRef: 't02-provenance',
      sourceRevision: 'revision-1',
      observedAt: 0,
    },
  });
  return index.snapshot();
}
async function put(fields: Record<string, unknown> = {}, target = key) {
  const valid = validSnapshot();
  const value = {
    schemaVersion: 1,
    snapshot: { ...valid, facts: [{ ...valid.facts[0], ...fields }] },
    idempotencyKeys: ['t02-original'],
  };
  await db.settings.put({ key: target, value, updated_at: 1 });
  return value;
}
beforeEach(async () => {
  await openDb();
  await db.settings.bulkDelete([key, otherKey]);
});
afterEach(async () => {
  await openDb();
  await db.settings.bulkDelete([key, otherKey]);
  await closeDb();
});

describe('temporal snapshot corruption through the real persistence load', () => {
  it('preserves a valid epoch-zero verification and nullable validity end across reopen', async () => {
    const value = await put();
    await closeDb();
    expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(value.snapshot);
  });

  it.each(
    [NaN, Infinity, -Infinity, -1, 0.5, undefined, '0', null].map(
      (value) => [`${typeof value}/${String(value)}`, value] as const,
    ),
  )(
    'rejects invalid persisted verification time %s without rewriting the stored candidate',
    async (_label, lastVerifiedAt) => {
      const value = await put({ lastVerifiedAt });
      await closeDb();
      await expect(loadRepositoryTemporalKnowledge(scope)).rejects.toThrow();
      expect((await db.settings.get(key))?.value).toEqual(value);
    },
  );

  it.each(
    [NaN, Infinity, -Infinity, -1, 0.5, undefined, '0'].map(
      (value) => [`${typeof value}/${String(value)}`, value] as const,
    ),
  )(
    'rejects invalid persisted validity end %s without rewriting the stored candidate',
    async (_label, validUntil) => {
      const value = await put({ validUntil });
      await closeDb();
      await expect(loadRepositoryTemporalKnowledge(scope)).rejects.toThrow();
      expect((await db.settings.get(key))?.value).toEqual(value);
    },
  );

  it('refuses a foreign-owner stored snapshot without changing either scoped row', async () => {
    const original = await put();
    const foreign = await put({}, otherKey);
    await expect(
      loadRepositoryTemporalKnowledge({ ...scope, accountId: 't02-other' }),
    ).rejects.toThrow(/scope/);
    expect((await db.settings.get(otherKey))?.value).toEqual(foreign);
    expect((await db.settings.get(key))?.value).toEqual(original);
  });
});

it('loads a later valid restoration without replacing other account data', async () => {
  const corrupt = await put({ lastVerifiedAt: NaN });
  const other = await put({}, otherKey);
  await expect(loadRepositoryTemporalKnowledge(scope)).rejects.toThrow();
  expect((await db.settings.get(key))?.value).toEqual(corrupt);
  const repaired = await put();
  await closeDb();
  expect(await loadRepositoryTemporalKnowledge(scope)).toEqual(repaired.snapshot);
  expect((await db.settings.get(otherKey))?.value).toEqual(other);
});
