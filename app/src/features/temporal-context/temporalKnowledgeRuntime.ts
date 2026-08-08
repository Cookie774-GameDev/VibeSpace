import { db, openDb } from '@/lib/db';
import type { RepositoryRetrievalResult } from '@/features/context/repositoryRetrieval';
import type { TemporalKnowledgeSnapshot } from './contracts';
import {
  openTemporalKnowledgeRepository,
  type TemporalKnowledgeStoragePort,
} from './temporalKnowledgeRepository';

const MAX_IDEMPOTENCY_KEYS = 128;

type StoredTemporalEnvelope = Readonly<{
  schemaVersion: 1;
  snapshot: TemporalKnowledgeSnapshot;
  idempotencyKeys: readonly string[];
}>;

function storageKey(accountId: string, projectId: string): string {
  return `temporal-knowledge-v1:${encodeURIComponent(accountId)}:${encodeURIComponent(projectId)}`;
}

function isEnvelope(value: unknown): value is StoredTemporalEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as StoredTemporalEnvelope).schemaVersion === 1 &&
    typeof (value as StoredTemporalEnvelope).snapshot === 'object' &&
    Array.isArray((value as StoredTemporalEnvelope).idempotencyKeys)
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createDexieTemporalStorage(): TemporalKnowledgeStoragePort {
  return {
    async load(scope) {
      await openDb();
      const row = await db.settings.get(storageKey(scope.accountId, scope.projectId));
      return isEnvelope(row?.value) ? row.value.snapshot : undefined;
    },
    async compareAndSwap(input) {
      await openDb();
      return db.transaction('rw', db.settings, async () => {
        const key = storageKey(input.accountId, input.projectId);
        const row = await db.settings.get(key);
        const envelope = isEnvelope(row?.value) ? row.value : undefined;
        const currentRevision = envelope?.snapshot.revision ?? 0;
        if (envelope?.idempotencyKeys.includes(input.idempotencyKey)) {
          return Object.freeze({
            status: 'duplicate' as const,
            snapshot: envelope.snapshot,
          });
        }
        if (currentRevision !== input.expectedRevision) {
          return Object.freeze({
            status: 'conflict' as const,
            currentRevision,
          });
        }
        const next = Object.freeze({
          schemaVersion: 1 as const,
          snapshot: input.snapshot,
          idempotencyKeys: Object.freeze(
            [...(envelope?.idempotencyKeys ?? []), input.idempotencyKey].slice(
              -MAX_IDEMPOTENCY_KEYS,
            ),
          ),
        });
        await db.settings.put({ key, value: next, updated_at: Date.now() });
        return Object.freeze({ status: 'stored' as const, snapshot: input.snapshot });
      });
    },
  };
}

export async function recordRepositoryTemporalKnowledge(input: Readonly<{
  accountId: string;
  projectId: string;
  result: Readonly<RepositoryRetrievalResult>;
  observedAt: number;
}>): Promise<Readonly<TemporalKnowledgeSnapshot>> {
  const repository = await openTemporalKnowledgeRepository(createDexieTemporalStorage(), {
    accountId: input.accountId,
    projectId: input.projectId,
  });
  for (const item of input.result.items) {
    const current = repository
      .snapshot()
      .facts.find(
        (fact) =>
          fact.subjectRef === item.evidence.entityId &&
          fact.predicate === 'repository_content_hash' &&
          (fact.state === 'current' || fact.state === 'disputed'),
      );
    const factId = `temporal_repo_${(
      await sha256(
        `${input.accountId}\u0000${input.projectId}\u0000${item.evidence.entityId}\u0000${item.evidence.contentHash}`,
      )
    ).slice(0, 32)}`;
    const fact = {
      id: factId,
      accountId: input.accountId,
      projectId: input.projectId,
      subjectRef: item.evidence.entityId,
      predicate: 'repository_content_hash',
      valueRef: item.evidence.contentHash,
      sourceEvidenceRef: item.evidence.provenanceId,
      sourceRevision: item.evidence.repositoryRevision,
      observedAt: current
        ? Math.max(input.observedAt, current.validFrom + (current.valueRef === item.evidence.contentHash ? 0 : 1))
        : input.observedAt,
    };
    const revision = repository.snapshot().revision;
    if (!current) {
      await repository.execute({
        expectedRevision: revision,
        idempotencyKey: `introduce:${factId}`,
        command: { kind: 'introduce', fact },
      });
    } else if (current.valueRef === item.evidence.contentHash) {
      await repository.execute({
        expectedRevision: revision,
        idempotencyKey: `verify:${current.id}:${fact.observedAt}:${item.evidence.provenanceId}`,
        command: {
          kind: 'verify',
          factId: current.id,
          verifiedAt: fact.observedAt,
          evidenceRef: item.evidence.provenanceId,
        },
      });
    } else {
      await repository.execute({
        expectedRevision: revision,
        idempotencyKey: `supersede:${current.id}:${factId}`,
        command: {
          kind: 'supersede',
          previousFactId: current.id,
          replacement: fact,
        },
      });
    }
  }
  return repository.snapshot();
}

export async function loadRepositoryTemporalKnowledge(input: Readonly<{
  accountId: string;
  projectId: string;
}>): Promise<Readonly<TemporalKnowledgeSnapshot>> {
  return (
    await openTemporalKnowledgeRepository(createDexieTemporalStorage(), input)
  ).snapshot();
}
