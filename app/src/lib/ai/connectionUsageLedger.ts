const STORAGE_KEY = 'vibespace.ai-connection-usage.v1';
const MAX_ENTRIES = 5_000;
export const CONNECTION_USAGE_LEDGER_EVENT = 'jarvis:ai-connection-usage:changed';

export interface ConnectionUsageEntry {
  connectionId: string;
  providerId: string;
  modelId: string;
  timestamp: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ConnectionUsageWindow {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number;
  models: string[];
  lastRequestAt: number | null;
  source: 'vibespace-local-request-ledger';
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;

function boundedNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeEntry(value: unknown): ConnectionUsageEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ConnectionUsageEntry>;
  if (
    typeof entry.connectionId !== 'string' ||
    !SAFE_ID.test(entry.connectionId) ||
    typeof entry.providerId !== 'string' ||
    !SAFE_ID.test(entry.providerId) ||
    typeof entry.modelId !== 'string' ||
    !SAFE_ID.test(entry.modelId) ||
    !Number.isSafeInteger(entry.timestamp) ||
    entry.timestamp! < 0
  ) {
    return null;
  }
  return {
    connectionId: entry.connectionId,
    providerId: entry.providerId,
    modelId: entry.modelId,
    timestamp: entry.timestamp!,
    inputTokens: boundedNumber(entry.inputTokens ?? 0),
    cachedInputTokens: boundedNumber(entry.cachedInputTokens ?? 0),
    outputTokens: boundedNumber(entry.outputTokens ?? 0),
    costUsd: boundedNumber(entry.costUsd ?? 0),
  };
}

export function readConnectionUsageLedger(): ConnectionUsageEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.map(normalizeEntry).filter((entry): entry is ConnectionUsageEntry => entry !== null)
      : [];
  } catch {
    return [];
  }
}

export function recordConnectionUsage(entry: ConnectionUsageEntry): void {
  const normalized = normalizeEntry(entry);
  if (!normalized || typeof window === 'undefined') return;
  const next = [...readConnectionUsageLedger(), normalized].slice(-MAX_ENTRIES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(CONNECTION_USAGE_LEDGER_EVENT));
  } catch {
    // Usage analytics are best-effort and never block a completed response.
  }
}

export function aggregateConnectionUsage(
  connectionId: string,
  since: number,
): ConnectionUsageWindow {
  const entries = readConnectionUsageLedger().filter(
    (entry) => entry.connectionId === connectionId && entry.timestamp >= since,
  );
  return {
    inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
    cachedInputTokens: entries.reduce((sum, entry) => sum + entry.cachedInputTokens, 0),
    outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
    requests: entries.length,
    costUsd: entries.reduce((sum, entry) => sum + entry.costUsd, 0),
    models: [...new Set(entries.map((entry) => entry.modelId))],
    lastRequestAt:
      entries.length > 0 ? Math.max(...entries.map((entry) => entry.timestamp)) : null,
    source: 'vibespace-local-request-ledger',
  };
}

export function resetConnectionUsageLedgerForTests(): void {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY);
}
