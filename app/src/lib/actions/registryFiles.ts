import type { ActionResult } from './types';
import type { CanonicalFileActionEvidence } from '@/lib/jarvis/artifactProducerAdapters';

function persistedReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function sha256Reference(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value));
}

/** @internal Validates only persisted file-operation results, never proposals or submissions. */
export function isCanonicalFileArtifactResult(
  evidence: CanonicalFileActionEvidence,
  result: ActionResult,
): boolean {
  if (!result.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
    return false;
  }
  const data = result.data as Record<string, unknown>;
  if (evidence.state === 'partial') {
    return (
      data.partial === true &&
      (persistedReference(data.path) ||
        persistedReference(data.blobKey) ||
        persistedReference(data.messagePart))
    );
  }
  if (evidence.actionId === 'files.create') {
    return (
      data.operation === 'create' &&
      persistedReference(data.path) &&
      typeof data.contentSha256 === 'string' &&
      sha256Reference(data.contentSha256) &&
      Number.isSafeInteger(data.sizeBytes) &&
      Number(data.sizeBytes) >= 0
    );
  }
  if (evidence.actionId === 'files.edit') {
    return data.operation === 'edit' && persistedReference(data.path);
  }
  if (evidence.actionId === 'files.read') {
    return persistedReference(data.path) && typeof data.content === 'string';
  }
  if (evidence.actionId === 'files.patch.apply') {
    const operation =
      data.operation === 'create' || data.operation === 'modify' || data.operation === 'delete'
        ? data.operation
        : null;
    const hashesMatchOperation =
      (operation === 'create' &&
        data.beforeSha256 === null &&
        typeof data.afterSha256 === 'string') ||
      (operation === 'modify' &&
        typeof data.beforeSha256 === 'string' &&
        typeof data.afterSha256 === 'string' &&
        data.beforeSha256 !== data.afterSha256) ||
      (operation === 'delete' &&
        typeof data.beforeSha256 === 'string' &&
        data.afterSha256 === null);
    return (
      operation !== null &&
      persistedReference(data.path) &&
      sha256Reference(data.beforeSha256) &&
      sha256Reference(data.afterSha256) &&
      hashesMatchOperation &&
      Array.isArray(data.changedPaths) &&
      data.changedPaths.length === 1 &&
      data.changedPaths[0] === data.path &&
      persistedReference(data.previewId) &&
      persistedReference(data.rollbackArtifactRef)
    );
  }
  if (evidence.actionId === 'files.patch.rollback') {
    return (
      persistedReference(data.path) &&
      sha256Reference(data.restoredSha256) &&
      Array.isArray(data.changedPaths) &&
      data.changedPaths.length === 1 &&
      data.changedPaths[0] === data.path &&
      persistedReference(data.previewId) &&
      persistedReference(data.artifactRef)
    );
  }
  return false;
}