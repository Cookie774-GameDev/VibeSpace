export type CaoLearnerExecutionIdentity = Readonly<{
  providerId: 'openai';
  connectionId: 'openai-codex';
  modelId: 'gpt-5.6-terra';
  reasoningEffort: 'high';
}>;

export const CAO_LEARNER_IDENTITY: CaoLearnerExecutionIdentity = Object.freeze({
  providerId: 'openai',
  connectionId: 'openai-codex',
  modelId: 'gpt-5.6-terra',
  reasoningEffort: 'high',
});

export const CAO_NATIVE_IDENTITY = Object.freeze({
  id: 'jarvis-cao',
  name: 'Jarvis CAO',
  skillId: 'jarvis-cao',
  mention: '@CAO',
  aliases: Object.freeze(['@Jarvis CAO'] as const),
});

export type CaoLearningIntent = Readonly<{
  objective: string;
  source: 'catalog-reference' | 'natural-language';
}>;

export type CaoBootstrapDecision = Readonly<{
  nativeIdentity: typeof CAO_NATIVE_IDENTITY;
  requestedIdentity: CaoLearnerExecutionIdentity;
  skillIds: readonly ['jarvis-cao'];
  intent: CaoLearningIntent;
  control?: CaoControlCommand;
}>;

export type CaoPublicStatus = Readonly<{
  identity: 'Jarvis CAO';
  status: 'queued';
}>;

const CAO_REFERENCE_KEY = 'cao:jarvis-cao';
const ACTION = '(?:learn|study|review|analyze|research|investigate|improve)';
const TARGET = '(?:@?jarvis\\s+cao|@?cao)';
const AMBIGUOUS_OR_NEGATED =
  /\?|\b(?:maybe|perhaps|possibly|could|would|should|might|may|do\s+not|don['’]t|never|not)\b/iu;

function cleanObjective(value: string | undefined): string | null {
  const objective = value?.trim().replace(/^to\s+/iu, '') ?? '';
  if (objective.length < 3 || /^(?:it|this|that)$/iu.test(objective)) return null;
  return objective;
}

export function classifyCaoLearningIntent(input: {
  text: string;
  confirmedReferenceKeys?: readonly string[];
}): CaoLearningIntent | null {
  const text = input.text.trim().replace(/\s+/gu, ' ');
  if (!text || AMBIGUOUS_OR_NEGATED.test(text)) return null;

  const selected = input.confirmedReferenceKeys?.includes(CAO_REFERENCE_KEY) === true;
  if (selected) {
    const match = new RegExp(`^(?:please\\s+)?(${ACTION})\\s+(.+)$`, 'iu').exec(text);
    const objective = cleanObjective(match?.[2]);
    return objective ? Object.freeze({ objective, source: 'catalog-reference' }) : null;
  }

  const patterns = [
    new RegExp(
      `^(?:please\\s+)?(?:have|ask|tell)\\s+${TARGET}[,:]?\\s+(?:to\\s+)?(${ACTION})\\s+(.+)$`,
      'iu',
    ),
    new RegExp(`^${TARGET}[,:]?\\s+(${ACTION})\\s+(.+)$`, 'iu'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const objective = cleanObjective(match?.[2]);
    if (objective) return Object.freeze({ objective, source: 'natural-language' });
  }
  return null;
}

export function bootstrapCaoLearning(input: {
  text: string;
  confirmedReferenceKeys?: readonly string[];
}): CaoBootstrapDecision | null {
  const control = parseCaoControlCommand(input);
  if (control) {
    return Object.freeze({
      nativeIdentity: CAO_NATIVE_IDENTITY,
      requestedIdentity: CAO_LEARNER_IDENTITY,
      skillIds: Object.freeze(['jarvis-cao'] as const),
      intent: Object.freeze({ objective: 'cao-control', source: control.source }),
      control,
    });
  }
  const intent = classifyCaoLearningIntent(input);
  if (!intent) return null;
  return Object.freeze({
    nativeIdentity: CAO_NATIVE_IDENTITY,
    requestedIdentity: CAO_LEARNER_IDENTITY,
    skillIds: Object.freeze(['jarvis-cao'] as const),
    intent,
  });
}

function exactIdentity(
  identity: Readonly<Record<keyof CaoLearnerExecutionIdentity, string>>,
): boolean {
  return (
    identity.providerId === CAO_LEARNER_IDENTITY.providerId &&
    identity.connectionId === CAO_LEARNER_IDENTITY.connectionId &&
    identity.modelId === CAO_LEARNER_IDENTITY.modelId &&
    identity.reasoningEffort === CAO_LEARNER_IDENTITY.reasoningEffort
  );
}

export function assertCaoLearnerExecutionIdentity(input: {
  requested: Readonly<Record<keyof CaoLearnerExecutionIdentity, string>>;
  observed: Readonly<Record<keyof CaoLearnerExecutionIdentity, string>>;
}): CaoLearnerExecutionIdentity {
  if (!exactIdentity(input.requested)) {
    throw new Error('cao_learner_requested_identity_invalid');
  }
  if (!exactIdentity(input.observed)) {
    throw new Error('cao_learner_execution_identity_mismatch');
  }
  return CAO_LEARNER_IDENTITY;
}

export function projectCaoPublicStatus(_decision: CaoBootstrapDecision): CaoPublicStatus {
  return Object.freeze({ identity: 'Jarvis CAO', status: 'queued' });
}
import { parseCaoControlCommand, type CaoControlCommand } from './controlCommand';
import { db } from '@/lib/db';
import {
  assertCaoExecutionIdentity,
  loadCaoExecutionProfile,
  selectCaoExecutionProfile,
  type CaoExecutionIdentity,
  type CaoExecutionProfile,
} from './executionProfile';
import type { CaoProductionScope } from './productionLifecycle';

export type CaoMainBrainProfileReader = (scope: CaoProductionScope) => Promise<CaoExecutionProfile>;

async function defaultMainBrainProfileReader(
  scope: CaoProductionScope,
): Promise<CaoExecutionProfile> {
  const persisted = await loadCaoExecutionProfile(db, scope);
  if (!persisted) throw new Error('cao_main_brain_profile_unavailable');
  const { readLiveCaoExecutionCatalog } = await import('./productionLifecycle');
  const catalog = await readLiveCaoExecutionCatalog(scope);
  return selectCaoExecutionProfile({
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    catalog,
    backend: persisted.backend,
    connectionId: persisted.connectionId,
    modelId: persisted.modelId,
    reasoningEffort: persisted.reasoningEffort,
  });
}

let mainBrainProfileReader: CaoMainBrainProfileReader = defaultMainBrainProfileReader;

/** Resolve the durable main CAO profile against the current live catalog. */
export function resolveCaoMainBrainProfile(
  scope: CaoProductionScope,
): Promise<CaoExecutionProfile> {
  return mainBrainProfileReader(scope);
}

/** Test/native harness seam; it accepts a typed profile reader only. */
export function configureCaoMainBrainProfileReader(next: CaoMainBrainProfileReader): () => void {
  if (typeof next !== 'function') throw new Error('cao_main_brain_profile_reader_invalid');
  const previous = mainBrainProfileReader;
  mainBrainProfileReader = next;
  return () => {
    if (mainBrainProfileReader === next) mainBrainProfileReader = previous;
  };
}

export async function resolveCaoMainBrainIdentity(
  scope: CaoProductionScope,
): Promise<CaoExecutionIdentity> {
  return resolveCaoMainBrainProfile(scope);
}

export function assertConfiguredCaoExecutionIdentity(input: {
  requested: CaoExecutionIdentity;
  observed: Partial<CaoExecutionIdentity>;
}): CaoExecutionIdentity {
  return assertCaoExecutionIdentity(input.requested, input.observed);
}
