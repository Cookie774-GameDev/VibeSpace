import type { ProjectSnapshot } from './domain';
import {
  InMemoryStorageAdapter,
  type StorageAdapter,
  VersionedFixtureRepository,
} from './localRepository';
import { validateProjectSnapshot } from './validation';

export const FOUNDRY_DRAFT_REPOSITORY_PREFIX = 'vibespace.model-foundry';
export const FOUNDRY_DRAFT_CATALOG_KEY = 'vibespace.model-foundry.project-catalog.v1';
export const FOUNDRY_DRAFT_PRIVATE_CASES_KEY =
  'vibespace.model-foundry.private-evaluation-suites.v1';
const NATIVE_RUN_KEY = 'vibespace.model-foundry.native-runs.v1';
const ADAPTERS_KEY = 'vibespace.model-foundry.real-adapters.v1';
const DEPLOYMENTS_KEY = 'vibespace.model-foundry.deployments.v1';

interface DeleteLocalDraftInput {
  readonly storage: StorageAdapter;
  readonly active: ProjectSnapshot;
  readonly catalog: readonly ProjectSnapshot[];
  readonly adapterCount: number;
  readonly deploymentCount: number;
  readonly metadataSyncEnabled: boolean;
}

interface DeleteLocalDraftResult {
  readonly active: ProjectSnapshot | null;
  readonly catalog: readonly ProjectSnapshot[];
}

function parseRecord(raw: string | null, label: string): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Report the same safe error below. */
  }
  throw new Error(`Cannot inspect ${label}; local draft deletion was not started.`);
}

function envelopeProjectId(raw: string | null, label: string): string | null {
  if (raw === null) return null;
  const envelope = parseRecord(raw, label);
  const snapshot = envelope.snapshot;
  if (
    envelope.repositoryVersion !== 1 ||
    !Number.isInteger(envelope.generation) ||
    !snapshot ||
    typeof snapshot !== 'object' ||
    !('project' in snapshot) ||
    !snapshot.project ||
    typeof snapshot.project !== 'object' ||
    !('id' in snapshot.project) ||
    typeof snapshot.project.id !== 'string'
  ) {
    throw new Error(`Cannot inspect ${label}; local draft deletion was not started.`);
  }
  return snapshot.project.id;
}

function projectRecords(raw: string | null, label: string): readonly { projectId: string }[] {
  if (raw === null) return [];
  try {
    const records: unknown = JSON.parse(raw);
    if (
      Array.isArray(records) &&
      records.every(
        (record) => record && typeof record === 'object' && typeof record.projectId === 'string',
      )
    )
      return records;
  } catch {
    /* Report the same safe error below. */
  }
  throw new Error(`Cannot inspect ${label}; local draft deletion was not started.`);
}

/** Only fixture drafts with local dataset work and no training/evaluation artifacts qualify. */
export function canDeleteLocalFoundryDraft(snapshot: ProjectSnapshot): boolean {
  return (
    snapshot.fixtureLabel === 'fixture' &&
    (!snapshot.baseModel || snapshot.baseModel.backend === 'fixture') &&
    !snapshot.trainingManifest &&
    !snapshot.championVersionId &&
    snapshot.trainingManifests.length === 0 &&
    snapshot.trainingJobs.length === 0 &&
    snapshot.evaluationSuites.length === 0 &&
    snapshot.evaluationRuns.length === 0 &&
    snapshot.modelVersions.length === 0 &&
    snapshot.promotions.length === 0 &&
    snapshot.feedbackEvents.length === 0 &&
    snapshot.improvementCycles.length === 0
  );
}

/** Permanently removes one active local-only draft while preserving unrelated snapshots. */
export function deleteLocalFoundryDraft({
  storage,
  active,
  catalog,
  adapterCount,
  deploymentCount,
  metadataSyncEnabled,
}: DeleteLocalDraftInput): DeleteLocalDraftResult {
  if (!canDeleteLocalFoundryDraft(active))
    throw new Error('Only a local draft without training or evaluation artifacts can be deleted.');
  if (adapterCount > 0)
    throw new Error('This specialist has local adapters and cannot be deleted as a draft.');
  if (deploymentCount > 0)
    throw new Error('This specialist has deployments and cannot be deleted as a draft.');
  if (metadataSyncEnabled)
    throw new Error('Turn off Foundry metadata sync before deleting a local draft.');
  const projectId = active.project.id;
  if (catalog.filter((candidate) => candidate.project.id === projectId).length !== 1)
    throw new Error('The active draft is not uniquely present in the local catalog.');

  const currentKey = `${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.current`;
  const backupKey = `${FOUNDRY_DRAFT_REPOSITORY_PREFIX}.backup`;
  const keys = [
    currentKey,
    backupKey,
    NATIVE_RUN_KEY,
    FOUNDRY_DRAFT_PRIVATE_CASES_KEY,
    FOUNDRY_DRAFT_CATALOG_KEY,
    ADAPTERS_KEY,
    DEPLOYMENTS_KEY,
  ];
  let original: Map<string, string | null>;
  try {
    original = new Map(keys.map((key) => [key, storage.getItem(key)]));
  } catch {
    throw new Error('Could not inspect local Foundry storage; no draft was deleted.');
  }

  const currentRaw = original.get(currentKey) ?? null;
  const backupRaw = original.get(backupKey) ?? null;
  if (envelopeProjectId(currentRaw, 'current specialist snapshot') !== projectId)
    throw new Error('The active specialist and saved snapshot differ; no draft was deleted.');
  const savedSnapshot = validateProjectSnapshot(
    parseRecord(currentRaw, 'current specialist snapshot').snapshot,
  );
  const activeSnapshot = validateProjectSnapshot(active);
  if (
    !savedSnapshot.valid ||
    !activeSnapshot.valid ||
    JSON.stringify(savedSnapshot.value) !== JSON.stringify(activeSnapshot.value)
  )
    throw new Error('The saved snapshot changed; no draft was deleted.');
  const backupProjectId = envelopeProjectId(backupRaw, 'backup specialist snapshot');
  if (catalog.length === 1 && backupProjectId && backupProjectId !== projectId)
    throw new Error('An uncatalogued backup specialist would reopen; no draft was deleted.');
  if (
    projectRecords(original.get(ADAPTERS_KEY) ?? null, 'local adapter registry').some(
      (record) => record.projectId === projectId,
    )
  )
    throw new Error('This specialist has local adapters and cannot be deleted as a draft.');
  if (
    projectRecords(original.get(DEPLOYMENTS_KEY) ?? null, 'deployment registry').some(
      (record) => record.projectId === projectId,
    )
  )
    throw new Error('This specialist has deployments and cannot be deleted as a draft.');
  const nativeRuns = parseRecord(original.get(NATIVE_RUN_KEY) ?? null, 'native run state');
  if (Object.hasOwn(nativeRuns, projectId))
    throw new Error('This specialist has a native run and cannot be deleted as a draft.');
  const privateCases = parseRecord(
    original.get(FOUNDRY_DRAFT_PRIVATE_CASES_KEY) ?? null,
    'private evaluation cases',
  );

  let storedCatalog: unknown;
  try {
    storedCatalog = JSON.parse(original.get(FOUNDRY_DRAFT_CATALOG_KEY) ?? 'null');
  } catch {
    throw new Error('Cannot inspect the local specialist catalog; no draft was deleted.');
  }
  if (
    !Array.isArray(storedCatalog) ||
    JSON.stringify(storedCatalog.map((candidate) => candidate?.project?.id)) !==
      JSON.stringify(catalog.map((candidate) => candidate.project.id)) ||
    JSON.stringify(storedCatalog.find((candidate) => candidate?.project?.id === projectId)) !==
      JSON.stringify(active)
  ) {
    throw new Error('The local specialist catalog changed; no draft was deleted.');
  }

  const nextCatalog = catalog.filter((candidate) => candidate.project.id !== projectId);
  const nextActive = nextCatalog[0] ?? null;
  let nextCurrentRaw: string | null = null;
  if (nextActive) {
    const temporary = new InMemoryStorageAdapter();
    const repository = new VersionedFixtureRepository(
      temporary,
      FOUNDRY_DRAFT_REPOSITORY_PREFIX,
      () => 'draft-deletion-validation',
    );
    const saved = repository.save(nextActive);
    if (!saved.ok)
      throw new Error(`The remaining specialist could not be validated: ${saved.error.message}`);
    const envelope = parseRecord(temporary.getItem(currentKey), 'replacement specialist snapshot');
    const prior = parseRecord(currentRaw, 'current specialist snapshot');
    envelope.generation = Number(prior.generation) + 1;
    nextCurrentRaw = JSON.stringify(envelope);
  }
  const nextPrivateCases = { ...privateCases };
  delete nextPrivateCases[projectId];
  const desired = new Map<string, string | null>([
    [currentKey, nextCurrentRaw],
    [backupKey, backupProjectId === projectId ? null : backupRaw],
    [
      FOUNDRY_DRAFT_PRIVATE_CASES_KEY,
      Object.keys(nextPrivateCases).length ? JSON.stringify(nextPrivateCases) : null,
    ],
    [FOUNDRY_DRAFT_CATALOG_KEY, JSON.stringify(nextCatalog)],
  ]);
  const touched: string[] = [];
  try {
    for (const [key, value] of desired) {
      if (value === original.get(key)) continue;
      touched.push(key);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
  } catch {
    try {
      for (const key of touched.reverse()) {
        const value = original.get(key) ?? null;
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      }
    } catch {
      throw new Error('Local draft deletion failed and storage restoration also failed.');
    }
    throw new Error('Local draft deletion failed; original storage was restored.');
  }
  return { active: nextActive, catalog: nextCatalog };
}
