import type {
  ContextEntityV2,
  ContextGraphSnapshotV2,
  ContextProvenanceV2,
} from '@/features/context/contracts';
import type { TemporalKnowledgeFact, TemporalKnowledgeState } from './contracts';

export interface TemporalContextMapNode {
  entity: Readonly<ContextEntityV2>;
  factId: string;
  predicate: string;
  valueRef: string;
  state: TemporalKnowledgeState;
  validFrom: number;
  validUntil: number | null;
  lastVerifiedAt: number;
  sourceEvidence: Readonly<ContextProvenanceV2>;
  stateEvidenceRef: string;
}

export interface TemporalContextMapProjection {
  mapId: string;
  knowledgeRevision: number;
  nodes: readonly Readonly<TemporalContextMapNode>[];
  excluded: readonly Readonly<{
    factId: string;
    reason: 'historical' | 'missing_entity' | 'missing_provenance';
  }>[];
}

const DEFAULT_VISIBLE_STATES = new Set<TemporalKnowledgeState>(['current', 'disputed']);

export function projectTemporalKnowledgeToContextMap(input: {
  snapshot: Readonly<ContextGraphSnapshotV2>;
  projectId: string;
  facts: readonly Readonly<TemporalKnowledgeFact>[];
  knowledgeRevision: number;
  includeHistorical?: boolean;
}): TemporalContextMapProjection {
  const { snapshot } = input;
  if (!input.projectId || !Number.isSafeInteger(input.knowledgeRevision)) {
    throw new Error('Temporal Context Map projection identity is invalid.');
  }
  if (
    snapshot.map.projectId !== input.projectId ||
    snapshot.map.knowledgeRevision > input.knowledgeRevision
  ) {
    throw new Error('Temporal Context Map projection scope or revision mismatch.');
  }

  const entities = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const provenance = new Map(snapshot.provenance.map((entry) => [entry.id, entry]));
  const nodes: TemporalContextMapNode[] = [];
  const excluded: TemporalContextMapProjection['excluded'][number][] = [];
  const seen = new Set<string>();

  for (const fact of input.facts) {
    if (
      fact.accountId !== snapshot.map.accountId ||
      fact.projectId !== input.projectId ||
      seen.has(fact.id)
    ) {
      throw new Error(`Temporal fact ${fact.id || '<missing>'} has invalid scope or identity.`);
    }
    seen.add(fact.id);
    if (!input.includeHistorical && !DEFAULT_VISIBLE_STATES.has(fact.state)) {
      excluded.push({ factId: fact.id, reason: 'historical' });
      continue;
    }
    const entity = entities.get(fact.subjectRef);
    if (!entity) {
      excluded.push({ factId: fact.id, reason: 'missing_entity' });
      continue;
    }
    const evidence = provenance.get(fact.sourceEvidenceRef);
    if (!evidence || evidence.targetKind !== 'entity' || evidence.targetId !== entity.id) {
      excluded.push({ factId: fact.id, reason: 'missing_provenance' });
      continue;
    }
    nodes.push({
      entity,
      factId: fact.id,
      predicate: fact.predicate,
      valueRef: fact.valueRef,
      state: fact.state,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      lastVerifiedAt: fact.lastVerifiedAt,
      sourceEvidence: evidence,
      stateEvidenceRef: fact.stateEvidenceRef,
    });
  }

  return Object.freeze({
    mapId: snapshot.map.id,
    knowledgeRevision: input.knowledgeRevision,
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
    excluded: Object.freeze(excluded.map((entry) => Object.freeze(entry))),
  });
}
