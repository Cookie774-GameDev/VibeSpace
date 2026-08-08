import type { BenchmarkRow, FetchResult } from './benchmarkData';
import { fetchBenchmarks } from './benchmarkData';

export type BenchmarkSourceKind =
  | 'benchmark'
  | 'official-announcement'
  | 'x'
  | 'reddit'
  | 'discord';

export type BenchmarkSourceDescriptor = Readonly<{
  id: string;
  name: string;
  kind: BenchmarkSourceKind;
  url: string;
  confidence: 'high' | 'medium' | 'discovery-only';
  use: 'ranking' | 'model-discovery';
  note: string;
}>;

/**
 * Ranked data comes only from comparable structured benchmark feeds.
 * Community sources are discovery signals and never contribute a score.
 */
export const BENCHMARK_SOURCE_REGISTRY: readonly BenchmarkSourceDescriptor[] = [
  {
    id: 'lmarena',
    name: 'LMArena',
    kind: 'benchmark',
    url: 'https://lmarena.ai/leaderboard',
    confidence: 'high',
    use: 'ranking',
    note: 'Structured Arena scores; kept separate from Artificial Analysis Intelligence Index.',
  },
  {
    id: 'artificial-analysis',
    name: 'Artificial Analysis',
    kind: 'benchmark',
    url: 'https://artificialanalysis.ai/leaderboards/models',
    confidence: 'high',
    use: 'ranking',
    note: 'Curated fallback snapshot and methodology; never merged numerically with Arena ELO.',
  },
  {
    id: 'provider-announcements',
    name: 'Official model/provider announcements',
    kind: 'official-announcement',
    url: 'https://huggingface.co/models?sort=modified',
    confidence: 'high',
    use: 'model-discovery',
    note: 'Candidate discovery only until a structured benchmark source includes the model.',
  },
  {
    id: 'x-ai-model-community',
    name: 'X model/provider announcements',
    kind: 'x',
    url: 'https://x.com/i/lists/1655987276956364800',
    confidence: 'discovery-only',
    use: 'model-discovery',
    note: 'Discovery signal only; authenticated availability varies and posts never create scores.',
  },
  {
    id: 'reddit-local-llama',
    name: 'Reddit r/LocalLLaMA',
    kind: 'reddit',
    url: 'https://www.reddit.com/r/LocalLLaMA/new.json?limit=25',
    confidence: 'discovery-only',
    use: 'model-discovery',
    note: 'Community discovery only; duplicates and unverified claims are excluded from rankings.',
  },
  {
    id: 'lmarena-discord',
    name: 'LMArena Discord',
    kind: 'discord',
    url: 'https://discord.gg/lmarena',
    confidence: 'discovery-only',
    use: 'model-discovery',
    note: 'Visible as a monitored source; ingestion requires user-authenticated Discord access.',
  },
] as const;

export type BenchmarkRefreshConfig = Readonly<{
  enabled: boolean;
  localTime: string;
}>;

export type BenchmarkRefreshAuditEntry = Readonly<{
  id: string;
  startedAt: number;
  finishedAt: number;
  trigger: 'scheduled' | 'missed-run' | 'manual';
  status: 'success' | 'fallback' | 'failed';
  rowCount: number;
  duplicateCount: number;
  message: string;
}>;

export type BenchmarkRefreshOutcome = Readonly<{
  result: FetchResult;
  rows: BenchmarkRow[];
  duplicateCount: number;
  audit: BenchmarkRefreshAuditEntry;
}>;

const CONFIG_KEY = 'vibespace-benchmark-refresh-config-v1';
const AUDIT_KEY = 'vibespace-benchmark-refresh-audit-v1';
const LAST_RUN_KEY = 'vibespace-benchmark-refresh-last-run-v1';
const MAX_AUDIT_ENTRIES = 40;
export const DEFAULT_BENCHMARK_REFRESH_CONFIG: BenchmarkRefreshConfig = {
  enabled: true,
  localTime: '12:00',
};

function validLocalTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function readBenchmarkRefreshConfig(): BenchmarkRefreshConfig {
  if (typeof window === 'undefined') return DEFAULT_BENCHMARK_REFRESH_CONFIG;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CONFIG_KEY) ?? '{}',
    ) as Partial<BenchmarkRefreshConfig>;
    return {
      enabled: parsed.enabled !== false,
      localTime: validLocalTime(parsed.localTime)
        ? parsed.localTime
        : DEFAULT_BENCHMARK_REFRESH_CONFIG.localTime,
    };
  } catch {
    return DEFAULT_BENCHMARK_REFRESH_CONFIG;
  }
}

export function writeBenchmarkRefreshConfig(config: BenchmarkRefreshConfig): void {
  if (typeof window === 'undefined') return;
  const normalized = {
    enabled: Boolean(config.enabled),
    localTime: validLocalTime(config.localTime)
      ? config.localTime
      : DEFAULT_BENCHMARK_REFRESH_CONFIG.localTime,
  };
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent('vibespace:benchmark-refresh-config'));
}

export function nextBenchmarkRefreshAt(now: Date, config: BenchmarkRefreshConfig): Date | null {
  if (!config.enabled || !validLocalTime(config.localTime)) return null;
  const [hour, minute] = config.localTime.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour!, minute!, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

export function shouldRunMissedBenchmarkRefresh(
  now: Date,
  config: BenchmarkRefreshConfig,
  lastRunAt: number | null,
): boolean {
  if (!config.enabled || !validLocalTime(config.localTime)) return false;
  const [hour, minute] = config.localTime.split(':').map(Number);
  const scheduledToday = new Date(now);
  scheduledToday.setHours(hour!, minute!, 0, 0);
  return now >= scheduledToday && (lastRunAt == null || lastRunAt < scheduledToday.getTime());
}

function normalizedModelKey(row: BenchmarkRow): string {
  return `${row.provider.trim().toLowerCase()}:${row.model.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function deduplicateBenchmarkRows(rows: readonly BenchmarkRow[]): {
  rows: BenchmarkRow[];
  duplicateCount: number;
} {
  const selected = new Map<string, BenchmarkRow>();
  let duplicateCount = 0;
  for (const row of rows) {
    const key = normalizedModelKey(row);
    const previous = selected.get(key);
    if (!previous) {
      selected.set(key, row);
      continue;
    }
    duplicateCount += 1;
    const previousEvidence = previous.votes ?? 0;
    const nextEvidence = row.votes ?? 0;
    if (
      nextEvidence > previousEvidence ||
      (nextEvidence === previousEvidence && row.fetched_at > previous.fetched_at)
    ) {
      selected.set(key, row);
    }
  }
  return { rows: [...selected.values()], duplicateCount };
}

export function readBenchmarkRefreshAudit(): BenchmarkRefreshAuditEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUDIT_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? (parsed as BenchmarkRefreshAuditEntry[]).slice(0, MAX_AUDIT_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

function appendAudit(entry: BenchmarkRefreshAuditEntry): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [entry, ...readBenchmarkRefreshAudit()].slice(0, MAX_AUDIT_ENTRIES);
    window.localStorage.setItem(AUDIT_KEY, JSON.stringify(next));
    window.localStorage.setItem(LAST_RUN_KEY, String(entry.finishedAt));
    window.dispatchEvent(new CustomEvent('vibespace:benchmark-refresh-audit'));
  } catch {
    // Refresh remains successful when storage is unavailable or full.
  }
}

export function lastBenchmarkRefreshAt(): number | null {
  if (typeof window === 'undefined') return null;
  const value = Number(window.localStorage.getItem(LAST_RUN_KEY));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function refreshBenchmarkDataset(
  trigger: BenchmarkRefreshAuditEntry['trigger'],
): Promise<BenchmarkRefreshOutcome> {
  const startedAt = Date.now();
  try {
    const result = await fetchBenchmarks({ force: true });
    const deduped = deduplicateBenchmarkRows(result.rows);
    const finishedAt = Date.now();
    const status = result.fromSnapshot ? 'fallback' : 'success';
    const audit: BenchmarkRefreshAuditEntry = {
      id: `${startedAt.toString(36)}-${finishedAt.toString(36)}`,
      startedAt,
      finishedAt,
      trigger,
      status,
      rowCount: deduped.rows.length,
      duplicateCount: deduped.duplicateCount,
      message:
        result.reason ??
        (result.fromSnapshot
          ? 'Structured live sources unavailable; retained snapshot.'
          : 'Structured leaderboard refreshed.'),
    };
    appendAudit(audit);
    return {
      result: { ...result, rows: deduped.rows },
      rows: deduped.rows,
      duplicateCount: deduped.duplicateCount,
      audit,
    };
  } catch (error) {
    const finishedAt = Date.now();
    const message = error instanceof Error ? error.message : 'Refresh failed';
    const audit: BenchmarkRefreshAuditEntry = {
      id: `${startedAt.toString(36)}-${finishedAt.toString(36)}`,
      startedAt,
      finishedAt,
      trigger,
      status: 'failed',
      rowCount: 0,
      duplicateCount: 0,
      message,
    };
    appendAudit(audit);
    throw error;
  }
}

export function startBenchmarkRefreshScheduler(
  onOutcome: (outcome: BenchmarkRefreshOutcome) => void,
  onError?: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = async (trigger: 'scheduled' | 'missed-run') => {
    try {
      const outcome = await refreshBenchmarkDataset(trigger);
      if (!stopped) onOutcome(outcome);
    } catch (error) {
      if (!stopped) onError?.(error);
    } finally {
      if (!stopped) schedule();
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    const config = readBenchmarkRefreshConfig();
    const now = new Date();
    if (shouldRunMissedBenchmarkRefresh(now, config, lastBenchmarkRefreshAt())) {
      timer = setTimeout(() => void run('missed-run'), 250);
      return;
    }
    const next = nextBenchmarkRefreshAt(now, config);
    if (!next) return;
    timer = setTimeout(() => void run('scheduled'), Math.max(250, next.getTime() - now.getTime()));
  };

  const onConfig = () => schedule();
  window.addEventListener('vibespace:benchmark-refresh-config', onConfig);
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    window.removeEventListener('vibespace:benchmark-refresh-config', onConfig);
  };
}
