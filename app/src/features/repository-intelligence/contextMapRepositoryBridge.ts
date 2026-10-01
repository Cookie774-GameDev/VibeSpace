import type {
  ContextGraphSnapshotV2,
  ContextReferenceV2,
} from '@/features/context/contracts';
import type {
  RepositoryContextPack,
  RepositoryRepresentation,
  RepositorySelectionReason,
} from './contracts';

export interface RepositoryContextReceipt {
  reference: Readonly<ContextReferenceV2>;
  representation: RepositoryRepresentation;
  tokens: number;
  reasons: readonly RepositorySelectionReason[];
  sourceRevision: string;
}

export interface RepositoryContextMapProjection {
  mapId: string;
  repositoryCommit: string;
  receipts: readonly Readonly<RepositoryContextReceipt>[];
  excluded: readonly Readonly<{
    path: string;
    reason: 'missing_entity' | 'stale_evidence';
  }>[];
}

export function projectRepositoryPackToContextMap(input: {
  pack: Readonly<RepositoryContextPack>;
  snapshot: Readonly<ContextGraphSnapshotV2>;
  repositoryCommit: string;
}): RepositoryContextMapProjection {
  if (!input.repositoryCommit) throw new Error('Repository commit is required.');
  const pathEntities = new Map(
    input.snapshot.entities
      .filter((entity) => entity.kind === 'file' && entity.path)
      .map((entity) => [entity.path!, entity]),
  );
  const provenanceByTarget = new Map<string, typeof input.snapshot.provenance>();
  for (const evidence of input.snapshot.provenance) {
    const current = provenanceByTarget.get(evidence.targetId) ?? [];
    provenanceByTarget.set(evidence.targetId, [...current, evidence]);
  }
  const receipts: RepositoryContextReceipt[] = [];
  const excluded: RepositoryContextMapProjection['excluded'][number][] = [];

  for (const entry of input.pack.entries) {
    const entity = pathEntities.get(entry.path);
    if (!entity) {
      excluded.push({ path: entry.path, reason: 'missing_entity' });
      continue;
    }
    const evidence = (provenanceByTarget.get(entity.id) ?? []).find(
      (candidate) =>
        candidate.targetKind === 'entity' &&
        candidate.path === entry.path &&
        candidate.sourceRevision === input.repositoryCommit,
    );
    if (!evidence || entity.sourceRevision !== input.repositoryCommit) {
      excluded.push({ path: entry.path, reason: 'stale_evidence' });
      continue;
    }
    receipts.push({
      reference: {
        entityId: entity.id,
        kind: entity.kind,
        label: entity.label,
        sourceId: entity.sourceId,
        path: entity.path,
      },
      representation: entry.representation,
      tokens: entry.tokens,
      reasons: Object.freeze([...entry.reasons]),
      sourceRevision: evidence.sourceRevision,
    });
  }

  return Object.freeze({
    mapId: input.snapshot.map.id,
    repositoryCommit: input.repositoryCommit,
    receipts: Object.freeze(receipts.map((receipt) => Object.freeze(receipt))),
    excluded: Object.freeze(excluded.map((entry) => Object.freeze(entry))),
  });
}
