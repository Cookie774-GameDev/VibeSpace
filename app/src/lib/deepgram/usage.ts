export interface DeepgramProjectUsage {
  start: string;
  end: string;
  sttHours: number;
  sttRequests: number;
}

interface RawUsageBreakdown {
  start?: unknown;
  end?: unknown;
  results?: unknown;
}

interface RawUsageRow {
  hours?: unknown;
  requests?: unknown;
  grouping?: { endpoint?: unknown };
}

export function parseDeepgramUsageBreakdown(value: unknown): DeepgramProjectUsage | null {
  const raw = value as RawUsageBreakdown | null;
  if (
    typeof raw?.start !== 'string' ||
    typeof raw.end !== 'string' ||
    !Array.isArray(raw.results)
  ) {
    return null;
  }
  let sttHours = 0;
  let sttRequests = 0;
  for (const candidate of raw.results as RawUsageRow[]) {
    if (candidate?.grouping?.endpoint !== 'listen') continue;
    if (
      typeof candidate.hours !== 'number' ||
      !Number.isFinite(candidate.hours) ||
      typeof candidate.requests !== 'number' ||
      !Number.isFinite(candidate.requests)
    ) {
      return null;
    }
    sttHours += candidate.hours;
    sttRequests += candidate.requests;
  }
  return {
    start: raw.start,
    end: raw.end,
    sttHours: Number(sttHours.toFixed(6)),
    sttRequests,
  };
}

export async function fetchDeepgramProjectUsage(
  apiKey: string,
  projectId: string,
  now = new Date(),
): Promise<DeepgramProjectUsage> {
  const end = now.toISOString().slice(0, 10);
  const startDate = new Date(now);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const start = startDate.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    start,
    end,
    grouping: 'endpoint',
    endpoint: 'listen',
  });
  const response = await fetch(
    `https://api.deepgram.com/v1/projects/${encodeURIComponent(projectId)}/usage/breakdown?${params.toString()}`,
    { headers: { Authorization: `Token ${apiKey}` } },
  );
  if (!response.ok) throw new Error(`deepgram_usage_${response.status}`);
  const parsed = parseDeepgramUsageBreakdown(await response.json());
  if (!parsed) throw new Error('deepgram_usage_invalid_response');
  return parsed;
}

export interface DeepgramLocalUsage {
  seconds: number;
  estimatedCostUsd: number;
  requests: number;
  lastUsedAt?: string;
}

const LOCAL_USAGE_KEY = 'vibespace.deepgram.local-stt-usage.v1';

export function readDeepgramLocalUsage(): DeepgramLocalUsage {
  if (typeof window === 'undefined') return { seconds: 0, estimatedCostUsd: 0, requests: 0 };
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(LOCAL_USAGE_KEY) ?? '{}',
    ) as Partial<DeepgramLocalUsage>;
    return {
      seconds:
        typeof parsed.seconds === 'number' && Number.isFinite(parsed.seconds)
          ? Math.max(0, parsed.seconds)
          : 0,
      estimatedCostUsd:
        typeof parsed.estimatedCostUsd === 'number' && Number.isFinite(parsed.estimatedCostUsd)
          ? Math.max(0, parsed.estimatedCostUsd)
          : 0,
      requests:
        typeof parsed.requests === 'number' && Number.isFinite(parsed.requests)
          ? Math.max(0, Math.floor(parsed.requests))
          : 0,
      lastUsedAt: typeof parsed.lastUsedAt === 'string' ? parsed.lastUsedAt : undefined,
    };
  } catch {
    return { seconds: 0, estimatedCostUsd: 0, requests: 0 };
  }
}

export function recordDeepgramLocalUsage(
  seconds: number,
  priceUsdPerMinute: number,
  now = new Date(),
): DeepgramLocalUsage {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const previous = readDeepgramLocalUsage();
  const next: DeepgramLocalUsage = {
    seconds: Number((previous.seconds + safeSeconds).toFixed(3)),
    estimatedCostUsd: Number(
      (previous.estimatedCostUsd + (safeSeconds / 60) * priceUsdPerMinute).toFixed(6),
    ),
    requests: previous.requests + 1,
    lastUsedAt: now.toISOString(),
  };
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LOCAL_USAGE_KEY, JSON.stringify(next));
    } catch {
      // Numeric usage persistence is best-effort.
    }
  }
  return next;
}
