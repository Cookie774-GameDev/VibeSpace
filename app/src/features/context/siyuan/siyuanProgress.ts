import { canonicalSiyuanAuthorityRoot } from './siyuanPathAuthority';

/** View projection from the persisted Context source state, never a job checkpoint. */
export type SiyuanProgressView = SiyuanIndexJobRecord & { sourceIndexState?: 'indexing' | 'error' };
export function projectSiyuanSearchProgress(job: SiyuanIndexJobRecord, sourceStatus?: string): SiyuanProgressView {
  if (job.phase !== 'completed' || !['completed', 'cancelled'].includes(job.status) || !['indexing', 'error'].includes(sourceStatus ?? '')) return job;
  return { ...job, sourceIndexState: sourceStatus as 'indexing' | 'error',
    phase: 'reconciling', status: job.status === 'cancelled' ? 'cancelled' : sourceStatus === 'error' ? 'failed' : 'running',
    completedAt: null, estimatedPercent: null, estimatedEtaSeconds: null };
}

export interface SiyuanProgressSample {
  at: number;
  processed: number;
  frontierRemaining: number;
  discovered: number;
}

/** A checkpoint is display authority only for the currently selected map scope. */
export function siyuanProgressMatchesMap(job: SiyuanIndexJobRecord | null,
  accountId: string | null, projectId: string | null, map: { id: string; rootDir: string } | null): boolean {
  return Boolean(job && map && job.accountId === accountId && job.projectId === projectId &&
    job.mapId === map.id && canonicalSiyuanAuthorityRoot(job.canonicalRoot) === canonicalSiyuanAuthorityRoot(map.rootDir));
}

export interface SiyuanProgressEstimate {
  determinate: boolean;
  approximatePercent: number | null;
  etaSeconds: number | null;
  ratePerSecond: number | null;
  samples: readonly SiyuanProgressSample[];
}

/** A running job with no durable checkpoint for this long needs user-visible attention. */
export const SIYUAN_STALLED_CHECKPOINT_MS = 5 * 60 * 1_000;

export type SiyuanCheckpointLiveness = 'running' | 'stalled' | 'not-running';

/**
 * Classifies persisted progress without changing job state. A stale timestamp is only a signal:
 * it cannot prove that a native SiYuan request or worker is no longer active.
 */
export function classifySiyuanCheckpointLiveness(
  job: SiyuanIndexJobRecord,
  now = Date.now(),
): SiyuanCheckpointLiveness {
  if (job.status !== 'running' || job.phase === 'completed') return 'not-running';
  if (!Number.isFinite(now) || !Number.isFinite(job.updatedAt) || now < job.updatedAt) {
    return 'running';
  }
  return now - job.updatedAt >= SIYUAN_STALLED_CHECKPOINT_MS ? 'stalled' : 'running';
}

const MIN_SAMPLE_COUNT = 3;
const MIN_SAMPLE_WINDOW_MS = 5_000;
const EWMA_ALPHA = 0.35;
const MAX_SAMPLES = 20;

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function estimateSiyuanDiscoveryProgress(input: {
  sample: SiyuanProgressSample;
  previous?: SiyuanProgressEstimate | null;
  completed?: boolean;
}): SiyuanProgressEstimate {
  const current: SiyuanProgressSample = {
    at: finiteNonNegative(input.sample.at),
    processed: finiteNonNegative(input.sample.processed),
    frontierRemaining: finiteNonNegative(input.sample.frontierRemaining),
    discovered: finiteNonNegative(input.sample.discovered),
  };
  const samples = [...(input.previous?.samples ?? []), current]
    .filter((sample, index, all) => index === 0 || sample.at > all[index - 1]!.at)
    .slice(-MAX_SAMPLES);
  if (input.completed) {
    return {
      determinate: true,
      approximatePercent: 100,
      etaSeconds: 0,
      ratePerSecond: input.previous?.ratePerSecond ?? null,
      samples,
    };
  }
  const windowMs = samples.length > 1 ? current.at - samples[0]!.at : 0;
  if (samples.length < MIN_SAMPLE_COUNT || windowMs < MIN_SAMPLE_WINDOW_MS) {
    return {
      determinate: false,
      approximatePercent: null,
      etaSeconds: null,
      ratePerSecond: null,
      samples,
    };
  }

  let rate: number | null = null;
  for (let index = 1; index < samples.length; index += 1) {
    const before = samples[index - 1]!;
    const after = samples[index]!;
    const seconds = (after.at - before.at) / 1_000;
    const delta = after.processed - before.processed;
    if (seconds <= 0 || delta <= 0) continue;
    const observed = delta / seconds;
    rate = rate === null ? observed : EWMA_ALPHA * observed + (1 - EWMA_ALPHA) * rate;
  }
  if (rate === null || !Number.isFinite(rate) || rate <= 0) {
    return {
      determinate: false,
      approximatePercent: null,
      etaSeconds: null,
      ratePerSecond: null,
      samples,
    };
  }

  const observedDirectories = Math.max(1, current.processed);
  const childrenPerDirectory = Math.max(1, current.discovered / observedDirectories);
  const estimatedRemaining = Math.max(
    current.frontierRemaining,
    current.frontierRemaining * childrenPerDirectory,
  );
  const rawPercent =
    current.processed <= 0
      ? 0
      : (current.processed / (current.processed + estimatedRemaining)) * 100;
  const previousPercent = input.previous?.approximatePercent ?? 0;
  const approximatePercent = Math.min(99, Math.max(previousPercent, rawPercent));
  const etaSeconds = estimatedRemaining / rate;
  return {
    determinate: Number.isFinite(approximatePercent) && Number.isFinite(etaSeconds),
    approximatePercent,
    etaSeconds: Number.isFinite(etaSeconds) ? Math.max(0, etaSeconds) : null,
    ratePerSecond: rate,
    samples,
  };
}

export function formatSiyuanEta(etaSeconds: number | null): string {
  if (etaSeconds === null || !Number.isFinite(etaSeconds)) return 'Estimating time…';
  if (etaSeconds < 60) return 'Less than a minute';
  const minutes = Math.round(etaSeconds / 60);
  if (minutes < 60) return `About ${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `About ${hours} hr`;
}

export function siyuanOverallProgressPercent(job: SiyuanProgressView): number | null {
  if (job.sourceIndexState) return null;
  const complete =
    job.phase === 'completed' &&
    job.status === 'completed' &&
    job.completedAt !== null &&
    Number.isFinite(job.completedAt) &&
    job.reconciledAt !== null &&
    Number.isFinite(job.reconciledAt) &&
    Number.isSafeInteger(job.indexed) && job.indexed >= 0 &&
    job.createdNodes === job.indexed && job.failed === 0 &&
    job.pendingNativeNodeIds.length === 0;
  const calculated =
    job.phase === 'completed'
      ? 100
      : job.phase === 'reconciling'
        ? 99
        : job.phase === 'creating_nodes' && job.indexed > 0
          ? 25 + Math.min(1, job.createdNodes / job.indexed) * 65
          : job.phase === 'summarizing' && job.summaryEligible > 0
            ? 90 + Math.min(1, job.summarized / job.summaryEligible) * 8
            : job.phase === 'summarizing'
              ? 90
              : null;
  if (calculated === null && job.estimatedPercent === null) return null;
  if (complete) return 100;
  return Math.min(99, Math.max(calculated ?? 0, job.estimatedPercent ?? 0));
}

export function siyuanJobEtaSeconds(job: SiyuanProgressView): number | null {
  if (job.sourceIndexState) return null;
  if (job.phase === 'discovering') return job.estimatedEtaSeconds;
  const first = job.rateSamples[0];
  const last = job.rateSamples.at(-1);
  if (!first || !last) return null;
  const seconds = (last.at - first.at) / 1_000;
  const rate = seconds >= 5 ? (last.processed - first.processed) / seconds : 0;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const remaining =
    job.phase === 'creating_nodes'
      ? Math.max(0, job.indexed - job.createdNodes)
      : job.phase === 'summarizing'
        ? Math.max(0, job.summaryEligible - job.summarized)
        : job.phase === 'completed'
          ? 0
          : null;
  return remaining === null ? null : remaining / rate;
}

export function formatSiyuanJobEta(job: SiyuanIndexJobRecord): string {
  const etaSeconds = siyuanJobEtaSeconds(job);
  if (etaSeconds !== null) return formatSiyuanEta(etaSeconds);
  const hasPriorEvidence =
    job.phase === 'discovering' ? job.discoverySamples.length >= 3 : job.rateSamples.length >= 3;
  return hasPriorEvidence ? 'Recalculating…' : 'Estimating time…';
}
import type { SiyuanIndexJobRecord } from './siyuanIndexJobStore';
