import type {
  TemporalKnowledgeFact,
  TemporalKnowledgeFactInput,
  TemporalKnowledgeIndex,
  TemporalKnowledgeSnapshot,
} from './contracts';

function immutableFact(fact: TemporalKnowledgeFact): Readonly<TemporalKnowledgeFact> {
  return Object.freeze({ ...fact });
}

function assertTimestamp(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
}

export function createTemporalKnowledgeIndex(
  scope: {
    accountId: string;
    projectId: string;
  },
  initial?: Readonly<TemporalKnowledgeSnapshot>,
): TemporalKnowledgeIndex {
  if (!scope.accountId || !scope.projectId)
    throw new Error('Temporal knowledge scope is required.');
  const facts = new Map<string, Readonly<TemporalKnowledgeFact>>();
  let currentRevision = 0;

  const assertRevision = (expected: number): void => {
    if (!Number.isSafeInteger(expected) || expected !== currentRevision) {
      throw new Error(
        `Temporal knowledge revision mismatch: expected ${expected}, current ${currentRevision}.`,
      );
    }
  };

  const validateInput = (fact: TemporalKnowledgeFactInput): void => {
    if (fact.accountId !== scope.accountId || fact.projectId !== scope.projectId) {
      throw new Error('Temporal knowledge scope mismatch.');
    }
    if (!fact.id || !fact.subjectRef || !fact.predicate || !fact.valueRef || !fact.sourceRevision) {
      throw new Error('Temporal knowledge fact is incomplete.');
    }
    if (!fact.sourceEvidenceRef) throw new Error('Temporal knowledge source evidence is required.');
    assertTimestamp('fact observation time', fact.observedAt);
  };

  const requireFact = (factId: string): Readonly<TemporalKnowledgeFact> => {
    const fact = facts.get(factId);
    if (!fact) throw new Error(`Temporal knowledge fact ${factId} was not found.`);
    return fact;
  };

  const store = (fact: TemporalKnowledgeFact): Readonly<TemporalKnowledgeFact> => {
    const stored = immutableFact(fact);
    facts.set(stored.id, stored);
    return stored;
  };

  if (initial) {
    if (
      initial.schemaVersion !== 1 ||
      initial.accountId !== scope.accountId ||
      initial.projectId !== scope.projectId ||
      !Number.isSafeInteger(initial.revision) ||
      initial.revision < initial.facts.length
    ) {
      throw new Error('Temporal knowledge snapshot is invalid or out of scope.');
    }
    for (const fact of initial.facts) {
      validateInput(fact);
      if (
        facts.has(fact.id) ||
        !['current', 'stale', 'superseded', 'disputed', 'unavailable'].includes(fact.state) ||
        fact.validFrom !== fact.observedAt ||
        (fact.validUntil !== null && fact.validUntil < fact.validFrom) ||
        fact.lastVerifiedAt < fact.validFrom ||
        !fact.verificationEvidenceRef ||
        !fact.stateEvidenceRef
      ) {
        throw new Error(`Temporal knowledge snapshot fact ${fact.id} is invalid.`);
      }
      store({ ...fact });
    }
    for (const fact of facts.values()) {
      if (
        (fact.supersedesId !== null && !facts.has(fact.supersedesId)) ||
        (fact.supersededById !== null && !facts.has(fact.supersededById))
      ) {
        throw new Error(`Temporal knowledge snapshot relationship for ${fact.id} is invalid.`);
      }
    }
    currentRevision = initial.revision;
  }

  return {
    revision: () => currentRevision,
    get: (factId) => facts.get(factId),
    list: () => Object.freeze([...facts.values()]),
    snapshot: () =>
      Object.freeze({
        schemaVersion: 1 as const,
        accountId: scope.accountId,
        projectId: scope.projectId,
        revision: currentRevision,
        facts: Object.freeze([...facts.values()]),
      }),
    introduce({ expectedRevision, fact }) {
      assertRevision(expectedRevision);
      validateInput(fact);
      if (facts.has(fact.id)) throw new Error(`Temporal knowledge fact ${fact.id} already exists.`);
      const stored = store({
        ...fact,
        state: 'current',
        validFrom: fact.observedAt,
        validUntil: null,
        supersedesId: null,
        supersededById: null,
        lastVerifiedAt: fact.observedAt,
        verificationEvidenceRef: fact.sourceEvidenceRef,
        stateEvidenceRef: fact.sourceEvidenceRef,
      });
      currentRevision += 1;
      return Object.freeze({ revision: currentRevision, fact: stored });
    },
    supersede({ expectedRevision, previousFactId, replacement }) {
      assertRevision(expectedRevision);
      validateInput(replacement);
      if (facts.has(replacement.id)) {
        throw new Error(`Temporal knowledge fact ${replacement.id} already exists.`);
      }
      const previous = requireFact(previousFactId);
      if (previous.state === 'superseded') {
        throw new Error(`Temporal knowledge fact ${previousFactId} is already superseded.`);
      }
      if (replacement.observedAt <= previous.validFrom) {
        throw new Error('Replacement observation must be newer than the previous fact.');
      }
      const storedPrevious = store({
        ...previous,
        state: 'superseded',
        validUntil: replacement.observedAt,
        supersededById: replacement.id,
        stateEvidenceRef: replacement.sourceEvidenceRef,
      });
      const storedReplacement = store({
        ...replacement,
        state: 'current',
        validFrom: replacement.observedAt,
        validUntil: null,
        supersedesId: previous.id,
        supersededById: null,
        lastVerifiedAt: replacement.observedAt,
        verificationEvidenceRef: replacement.sourceEvidenceRef,
        stateEvidenceRef: replacement.sourceEvidenceRef,
      });
      currentRevision += 1;
      return Object.freeze({
        revision: currentRevision,
        previous: storedPrevious,
        replacement: storedReplacement,
      });
    },
    verify({ expectedRevision, factId, verifiedAt, evidenceRef }) {
      assertRevision(expectedRevision);
      assertTimestamp('verification time', verifiedAt);
      if (!evidenceRef) throw new Error('Verification evidence is required.');
      const fact = requireFact(factId);
      if (verifiedAt < fact.lastVerifiedAt) {
        throw new Error('Verification time cannot move backwards.');
      }
      const stored = store({
        ...fact,
        lastVerifiedAt: verifiedAt,
        verificationEvidenceRef: evidenceRef,
      });
      currentRevision += 1;
      return Object.freeze({ revision: currentRevision, fact: stored });
    },
    dispute({ expectedRevision, factId, observedAt, evidenceRef }) {
      assertRevision(expectedRevision);
      assertTimestamp('dispute observation time', observedAt);
      if (!evidenceRef) throw new Error('Dispute evidence is required.');
      const fact = requireFact(factId);
      const stored = store({
        ...fact,
        state: 'disputed',
        stateEvidenceRef: evidenceRef,
      });
      currentRevision += 1;
      return Object.freeze({ revision: currentRevision, fact: stored });
    },
    markSourceUnavailable({ expectedRevision, sourceEvidenceRef, observedAt, evidenceRef }) {
      assertRevision(expectedRevision);
      assertTimestamp('source-unavailable observation time', observedAt);
      if (!sourceEvidenceRef || !evidenceRef) {
        throw new Error('Source-unavailable evidence is required.');
      }
      const affected = [...facts.values()].filter(
        (fact) => fact.sourceEvidenceRef === sourceEvidenceRef,
      );
      if (affected.length === 0) throw new Error('No facts use the unavailable source.');
      const stored = affected.map((fact) =>
        store({
          ...fact,
          state: 'unavailable',
          validUntil: fact.validUntil ?? observedAt,
          stateEvidenceRef: evidenceRef,
        }),
      );
      currentRevision += 1;
      return Object.freeze({ revision: currentRevision, facts: Object.freeze(stored) });
    },
  };
}
