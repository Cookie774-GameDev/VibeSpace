export type TemporalKnowledgeState =
  | 'current'
  | 'stale'
  | 'superseded'
  | 'disputed'
  | 'unavailable';

export interface TemporalKnowledgeFactInput {
  id: string;
  accountId: string;
  projectId: string;
  subjectRef: string;
  predicate: string;
  valueRef: string;
  sourceEvidenceRef: string;
  sourceRevision: string;
  observedAt: number;
}

export interface TemporalKnowledgeFact extends TemporalKnowledgeFactInput {
  state: TemporalKnowledgeState;
  validFrom: number;
  validUntil: number | null;
  supersedesId: string | null;
  supersededById: string | null;
  lastVerifiedAt: number;
  verificationEvidenceRef: string;
  stateEvidenceRef: string;
}

export interface TemporalKnowledgeMutation {
  revision: number;
  fact: Readonly<TemporalKnowledgeFact>;
}

export interface TemporalKnowledgeSnapshot {
  schemaVersion: 1;
  accountId: string;
  projectId: string;
  revision: number;
  facts: readonly Readonly<TemporalKnowledgeFact>[];
}

export interface TemporalKnowledgeIndex {
  revision(): number;
  get(factId: string): Readonly<TemporalKnowledgeFact> | undefined;
  list(): readonly Readonly<TemporalKnowledgeFact>[];
  snapshot(): Readonly<TemporalKnowledgeSnapshot>;
  introduce(input: {
    expectedRevision: number;
    fact: TemporalKnowledgeFactInput;
  }): TemporalKnowledgeMutation;
  supersede(input: {
    expectedRevision: number;
    previousFactId: string;
    replacement: TemporalKnowledgeFactInput;
  }): Readonly<{
    revision: number;
    previous: Readonly<TemporalKnowledgeFact>;
    replacement: Readonly<TemporalKnowledgeFact>;
  }>;
  verify(input: {
    expectedRevision: number;
    factId: string;
    verifiedAt: number;
    evidenceRef: string;
  }): TemporalKnowledgeMutation;
  dispute(input: {
    expectedRevision: number;
    factId: string;
    observedAt: number;
    evidenceRef: string;
  }): TemporalKnowledgeMutation;
  markSourceUnavailable(input: {
    expectedRevision: number;
    sourceEvidenceRef: string;
    observedAt: number;
    evidenceRef: string;
  }): Readonly<{ revision: number; facts: readonly Readonly<TemporalKnowledgeFact>[] }>;
}
