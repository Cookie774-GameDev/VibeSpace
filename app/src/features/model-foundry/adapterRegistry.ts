import type { FoundryRealArtifactSummary, FoundryRealEvaluationReport } from './nativeBridge';

export interface LocalAdapterRecord {
  readonly schemaVersion: 1;
  readonly projectId: string;
  /** Local display name captured from the specialist manifest; never synced as artifact content. */
  readonly projectName?: string;
  readonly jobId: string;
  readonly artifactManifestSha256: string;
  readonly adapterFileCount: number;
  readonly metrics: Record<string, unknown>;
  readonly trainingConfig: Record<string, unknown>;
  readonly status: 'candidate' | 'promoted' | 'archived';
  readonly verifiedAt: string;
  /** The immediately prior champion, retained for a governed local rollback. */
  readonly previousChampionJobId?: string;
  readonly evaluation?: { readonly artifactManifestSha256: string; readonly evaluatedAt: string; readonly report: FoundryRealEvaluationReport };
}

export interface LocalAdapterStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const STORAGE_KEY = 'vibespace.model-foundry.real-adapters.v1';

function notifyRegistryChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vibespace:foundry-adapters-changed'));
}

function parse(raw: string | null): LocalAdapterRecord[] {
  try {
    const value = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LocalAdapterRecord => Boolean(item) && typeof item === 'object'
      && (item as LocalAdapterRecord).schemaVersion === 1
      && typeof (item as LocalAdapterRecord).projectId === 'string'
      && typeof (item as LocalAdapterRecord).jobId === 'string'
      && typeof (item as LocalAdapterRecord).artifactManifestSha256 === 'string'
      && ((item as LocalAdapterRecord).status === 'candidate' || (item as LocalAdapterRecord).status === 'promoted' || (item as LocalAdapterRecord).status === 'archived'));
  } catch { return []; }
}

export function canRoutePromotedAdapter(storage: LocalAdapterStorage, projectId: string, jobId: string): boolean {
  const record = parse(storage.getItem(STORAGE_KEY)).find((item) => item.projectId === projectId && item.jobId === jobId);
  return record?.status === 'promoted'
    && record.evaluation?.artifactManifestSha256 === record.artifactManifestSha256
    && record.evaluation.report.gate === 'pass';
}

export function promotedAdapterForProject(storage: LocalAdapterStorage, projectId: string): LocalAdapterRecord | null {
  return parse(storage.getItem(STORAGE_KEY)).find((record) => record.projectId === projectId && canRoutePromotedAdapter(storage, projectId, record.jobId)) ?? null;
}

export function listPromotedAdapters(storage: LocalAdapterStorage): readonly LocalAdapterRecord[] {
  return parse(storage.getItem(STORAGE_KEY)).filter((record) =>
    canRoutePromotedAdapter(storage, record.projectId, record.jobId),
  );
}

export class LocalAdapterRegistry {
  constructor(private readonly storage: LocalAdapterStorage, private readonly now: () => string) {}
  list(projectId: string): readonly LocalAdapterRecord[] { return parse(this.storage.getItem(STORAGE_KEY)).filter((record) => record.projectId === projectId); }
  upsert(projectId: string, jobId: string, artifact: FoundryRealArtifactSummary, projectName?: string): LocalAdapterRecord {
    const records = parse(this.storage.getItem(STORAGE_KEY));
    const existing = records.find((item) => item.projectId === projectId && item.jobId === jobId && item.artifactManifestSha256 === artifact.manifestSha256);
    const normalizedProjectName = projectName?.trim().slice(0, 120);
    const record: LocalAdapterRecord = { schemaVersion: 1, projectId, projectName: normalizedProjectName || existing?.projectName, jobId, artifactManifestSha256: artifact.manifestSha256, adapterFileCount: Object.keys(artifact.adapterFiles).length, metrics: artifact.metrics, trainingConfig: artifact.trainingConfig, status: existing?.status === 'promoted' ? 'promoted' : 'candidate', verifiedAt: this.now(), evaluation: existing?.evaluation, previousChampionJobId: existing?.previousChampionJobId };
    this.storage.setItem(STORAGE_KEY, JSON.stringify([...records.filter((item) => item.projectId !== projectId || item.jobId !== jobId), record]));
    notifyRegistryChanged();
    return record;
  }
  recordEvaluation(projectId: string, jobId: string, artifactManifestSha256: string, report: FoundryRealEvaluationReport): readonly LocalAdapterRecord[] {
    const records = parse(this.storage.getItem(STORAGE_KEY)).map((record) => record.projectId === projectId && record.jobId === jobId && record.artifactManifestSha256 === artifactManifestSha256 ? { ...record, evaluation: { artifactManifestSha256, evaluatedAt: this.now(), report } } : record);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
    notifyRegistryChanged();
    return records.filter((record) => record.projectId === projectId);
  }
  promote(projectId: string, jobId: string): readonly LocalAdapterRecord[] {
    const source = parse(this.storage.getItem(STORAGE_KEY));
    const current = source.find((record) => record.projectId === projectId && record.jobId === jobId);
    if (!current || current.status === 'archived' || current.evaluation?.artifactManifestSha256 !== current.artifactManifestSha256 || current.evaluation.report.gate !== 'pass') throw new Error('A current passing local evaluation is required before approval.');
    const previous = source.find((record) => record.projectId === projectId && record.status === 'promoted');
    const records = source.map((record) => record.projectId !== projectId ? record : record.jobId === jobId ? { ...record, status: 'promoted' as const, previousChampionJobId: previous?.jobId } : record.status === 'promoted' ? { ...record, status: 'candidate' as const } : record);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
    notifyRegistryChanged();
    return records.filter((record) => record.projectId === projectId);
  }
  rollback(projectId: string): readonly LocalAdapterRecord[] {
    const source = parse(this.storage.getItem(STORAGE_KEY));
    const champion = source.find((record) => record.projectId === projectId && record.status === 'promoted');
    const previous = champion?.previousChampionJobId ? source.find((record) => record.projectId === projectId && record.jobId === champion.previousChampionJobId) : undefined;
    if (!champion || !previous || previous.status === 'archived' || previous.evaluation?.artifactManifestSha256 !== previous.artifactManifestSha256 || previous.evaluation.report.gate !== 'pass') throw new Error('No verified prior champion is available for rollback.');
    const records = source.map((record) => record.projectId !== projectId ? record : record.jobId === champion.jobId ? { ...record, status: 'candidate' as const, previousChampionJobId: undefined } : record.jobId === previous.jobId ? { ...record, status: 'promoted' as const } : record);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
    notifyRegistryChanged();
    return records.filter((record) => record.projectId === projectId);
  }
  archive(projectId: string, jobId: string): readonly LocalAdapterRecord[] {
    const target = parse(this.storage.getItem(STORAGE_KEY)).find((record) => record.projectId === projectId && record.jobId === jobId);
    if (target?.status === 'promoted') throw new Error('Promote another verified adapter before archiving the active champion.');
    const records = parse(this.storage.getItem(STORAGE_KEY)).map((record) => record.projectId === projectId && record.jobId === jobId ? { ...record, status: 'archived' as const } : record);
    this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
    notifyRegistryChanged();
    return records.filter((record) => record.projectId === projectId);
  }
}
