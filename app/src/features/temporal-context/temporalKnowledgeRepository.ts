import type {
  TemporalKnowledgeFactInput,
  TemporalKnowledgeSnapshot,
} from './contracts';
import { createTemporalKnowledgeIndex } from './temporalKnowledge';

export type TemporalKnowledgeCommand =
  | Readonly<{ kind: 'introduce'; fact: TemporalKnowledgeFactInput }>
  | Readonly<{
      kind: 'supersede';
      previousFactId: string;
      replacement: TemporalKnowledgeFactInput;
    }>
  | Readonly<{ kind: 'verify'; factId: string; verifiedAt: number; evidenceRef: string }>
  | Readonly<{ kind: 'dispute'; factId: string; observedAt: number; evidenceRef: string }>
  | Readonly<{
      kind: 'mark_source_unavailable';
      sourceEvidenceRef: string;
      observedAt: number;
      evidenceRef: string;
    }>;

export type TemporalKnowledgeStoreResult =
  | Readonly<{ status: 'stored' | 'duplicate'; snapshot: TemporalKnowledgeSnapshot }>
  | Readonly<{ status: 'conflict'; currentRevision: number }>;

export interface TemporalKnowledgeStoragePort {
  load(scope: Readonly<{ accountId: string; projectId: string }>): Promise<
    TemporalKnowledgeSnapshot | undefined
  >;
  compareAndSwap(input: Readonly<{
    accountId: string;
    projectId: string;
    expectedRevision: number;
    idempotencyKey: string;
    snapshot: TemporalKnowledgeSnapshot;
  }>): Promise<TemporalKnowledgeStoreResult>;
}

export interface TemporalKnowledgeRepository {
  snapshot(): Readonly<TemporalKnowledgeSnapshot>;
  execute(input: Readonly<{
    expectedRevision: number;
    idempotencyKey: string;
    command: TemporalKnowledgeCommand;
  }>): Promise<Readonly<TemporalKnowledgeSnapshot>>;
}

function applyCommand(
  snapshot: Readonly<TemporalKnowledgeSnapshot>,
  command: TemporalKnowledgeCommand,
): TemporalKnowledgeSnapshot {
  const index = createTemporalKnowledgeIndex(
    { accountId: snapshot.accountId, projectId: snapshot.projectId },
    snapshot,
  );
  const expectedRevision = snapshot.revision;
  switch (command.kind) {
    case 'introduce':
      index.introduce({ expectedRevision, fact: command.fact });
      break;
    case 'supersede':
      index.supersede({
        expectedRevision,
        previousFactId: command.previousFactId,
        replacement: command.replacement,
      });
      break;
    case 'verify':
      index.verify({
        expectedRevision,
        factId: command.factId,
        verifiedAt: command.verifiedAt,
        evidenceRef: command.evidenceRef,
      });
      break;
    case 'dispute':
      index.dispute({
        expectedRevision,
        factId: command.factId,
        observedAt: command.observedAt,
        evidenceRef: command.evidenceRef,
      });
      break;
    case 'mark_source_unavailable':
      index.markSourceUnavailable({
        expectedRevision,
        sourceEvidenceRef: command.sourceEvidenceRef,
        observedAt: command.observedAt,
        evidenceRef: command.evidenceRef,
      });
      break;
  }
  return index.snapshot();
}

export async function openTemporalKnowledgeRepository(
  storage: TemporalKnowledgeStoragePort,
  scope: Readonly<{ accountId: string; projectId: string }>,
): Promise<TemporalKnowledgeRepository> {
  if (!scope.accountId || !scope.projectId) throw new Error('Temporal repository scope is required.');
  const loaded =
    (await storage.load(scope)) ??
    ({
      schemaVersion: 1,
      accountId: scope.accountId,
      projectId: scope.projectId,
      revision: 0,
      facts: Object.freeze([]),
    } satisfies TemporalKnowledgeSnapshot);
  let current = createTemporalKnowledgeIndex(scope, loaded).snapshot();

  return {
    snapshot: () => current,
    async execute(input) {
      if (
        !input.idempotencyKey ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision !== current.revision
      ) {
        throw new Error(
          `Temporal repository revision mismatch: expected ${input.expectedRevision}, current ${current.revision}.`,
        );
      }
      const candidate = applyCommand(current, input.command);
      const result = await storage.compareAndSwap({
        ...scope,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        snapshot: candidate,
      });
      if (result.status === 'conflict') {
        throw new Error(`Temporal repository storage conflict at revision ${result.currentRevision}.`);
      }
      const accepted = createTemporalKnowledgeIndex(scope, result.snapshot).snapshot();
      if (
        result.status === 'stored' &&
        (accepted.revision !== candidate.revision ||
          JSON.stringify(accepted.facts) !== JSON.stringify(candidate.facts))
      ) {
        throw new Error('Temporal repository storage returned a mismatched snapshot.');
      }
      current = accepted;
      return current;
    },
  };
}
