import type { ContextMapRecord } from '../tree';
import type { SiyuanIndexJobRecord } from './siyuanIndexJobStore';
import type { SiyuanMapManifest } from './siyuanMapManifest';
import { siyuanIndexPolicyFingerprint } from './siyuanSafeIndex';
import { canonicalSiyuanAuthorityRoot } from './siyuanPathAuthority';
import { readContextLocalFileScope } from '../contextLocalFileScope';

export function hasSiyuanMapJobAuthority(
  record: ContextMapRecord,
  manifest: SiyuanMapManifest | null,
  job: SiyuanIndexJobRecord | null,
  accountId: string | null,
): boolean {
  let localFileScope;
  try { localFileScope = readContextLocalFileScope(record); }
  catch { return false; }
  return Boolean(
    record.status === 'active' &&
    manifest &&
    manifest.status !== 'recycled' &&
    manifest.projectId === record.projectId &&
    manifest.mapId === record.id &&
    canonicalSiyuanAuthorityRoot(manifest.sourceRoot) ===
      canonicalSiyuanAuthorityRoot(record.rootDir) &&
    job &&
    job.projectId === manifest.projectId &&
    job.mapId === manifest.mapId &&
    job.accountId === accountId &&
    canonicalSiyuanAuthorityRoot(job.canonicalRoot) ===
      canonicalSiyuanAuthorityRoot(manifest.sourceRoot) &&
    job.policyFingerprint ===
      siyuanIndexPolicyFingerprint(
        manifest.sourceRoot,
        manifest.summaryPolicy,
        manifest.sourcePolicy.excludedPaths,
        localFileScope,
      ),
  );
}

export function canResumeSiyuanMapJob(
  record: ContextMapRecord,
  manifest: SiyuanMapManifest | null,
  job: SiyuanIndexJobRecord | null,
  accountId: string | null,
): boolean {
  return Boolean(
    hasSiyuanMapJobAuthority(record, manifest, job, accountId) &&
    job?.status === 'running' &&
    job.phase !== 'completed',
  );
}

export function canOpenPartialSiyuanSurface(
  record: ContextMapRecord,
  manifest: SiyuanMapManifest | null,
  job: SiyuanIndexJobRecord | null,
  accountId: string | null,
): boolean {
  return Boolean(
    hasSiyuanMapJobAuthority(record, manifest, job, accountId) &&
    manifest?.status !== 'pending' &&
    manifest?.notebookId &&
    manifest.rootDocumentId &&
    job &&
    job.createdNodes > 0,
  );
}
