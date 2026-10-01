import { enqueueMutation } from '../../lib/sync';
import type { ProjectSnapshot } from './domain';

export const FOUNDRY_METADATA_SYNC_PREFERENCE = 'vibespace.model-foundry.metadata-sync.v1';

export interface MetadataSyncStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function foundryMetadataSyncEnabled(storage: MetadataSyncStorage): boolean {
  return storage.getItem(FOUNDRY_METADATA_SYNC_PREFERENCE) === 'enabled';
}

export function setFoundryMetadataSyncEnabled(storage: MetadataSyncStorage, enabled: boolean): void {
  storage.setItem(FOUNDRY_METADATA_SYNC_PREFERENCE, enabled ? 'enabled' : 'disabled');
}

/** Deliberately excludes examples, prompts, completions, hidden cases, logs, outputs, and local artifact paths. */
export function foundryMetadataPayload(snapshot: ProjectSnapshot): Record<string, unknown> {
  return {
    schemaVersion: 1,
    localProjectId: snapshot.project.id,
    updatedAt: snapshot.project.updatedAt,
    baseModel: snapshot.baseModel ? { id: snapshot.baseModel.id, revision: snapshot.baseModel.revision, license: snapshot.baseModel.license, checksum: snapshot.baseModel.checksum.value } : null,
    dataset: snapshot.datasetVersion ? { id: snapshot.datasetVersion.id, manifestHash: snapshot.datasetVersion.manifestHash, fingerprint: snapshot.datasetVersion.fingerprint, splitCounts: snapshot.datasetVersion.splitStrategy.statistics, includedCount: snapshot.datasetVersion.includedExampleIds.length, excludedCount: snapshot.datasetVersion.excludedExampleIds.length } : null,
    jobs: snapshot.trainingJobs.map((job) => ({ id: job.id, state: job.state, backend: job.backend, progress: job.progress, createdAt: job.createdAt, updatedAt: job.updatedAt, artifactFingerprint: job.artifact?.fixtureFingerprint ?? null })),
    modelVersions: snapshot.modelVersions.map((version) => ({ id: version.id, sourceJobId: version.sourceJobId, artifactFingerprint: version.artifactFingerprint, baseModelId: version.baseModelId, baseRevision: version.baseRevision, license: version.license, createdAt: version.createdAt })),
    evaluations: snapshot.evaluationRuns.map((run) => ({ id: run.id, status: run.status, gate: run.gate.result, safetyFailureCount: run.safetyFailures.length, aggregateDeltas: run.aggregateDeltas, createdAt: run.createdAt })),
    championVersionId: snapshot.championVersionId ?? null,
    promotionHistory: snapshot.promotions.map((promotion) => ({ id: promotion.id, action: promotion.action, targetVersionId: promotion.targetVersionId, evaluationRunId: promotion.evaluationRunId ?? null, createdAt: promotion.createdAt })),
  };
}

export async function queueFoundryMetadataSync(snapshot: ProjectSnapshot, storage: MetadataSyncStorage): Promise<void> {
  if (!foundryMetadataSyncEnabled(storage)) return;
  await enqueueMutation('update', 'model_foundry_metadata', snapshot.project.id, foundryMetadataPayload(snapshot));
}

/** A revocation queues a cloud tombstone only; the local project, artifacts, and raw data are never touched. */
export async function queueFoundryMetadataDeletion(snapshot: ProjectSnapshot): Promise<void> {
  await enqueueMutation('delete', 'model_foundry_metadata', snapshot.project.id, null);
}
