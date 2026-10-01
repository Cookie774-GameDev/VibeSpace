export interface Env {
  DB: D1Database;
  CORS_ORIGIN?: string;
  MAX_ITEMS_PER_RUN?: string;
  RETENTION_DAYS?: string;
  EXTRA_FEEDS?: string;
  NEWS_SOURCE_LIMIT?: string;
  NEWS_SOURCE_CONCURRENCY?: string;
  NEWS_MEDIA_ENRICH_LIMIT?: string;
  NEWS_STALE_AFTER_MINUTES?: string;
  BENCHMARK_STALE_AFTER_MINUTES?: string;
  BENCHMARK_MIN_ROWS?: string;
  AA_API_KEY?: string;
  AA_API_BASE_URL?: string;
  X_BEARER_TOKEN?: string;
}

export type PipelineStatus = 'success' | 'partial' | 'failed';
export type FreshnessState = 'fresh' | 'degraded' | 'stale' | 'failed' | 'never';

export interface Lease {
  lockKey: string;
  runKey: string;
  fencingToken: string;
}

export type LeaseAcquisition =
  | { state: 'acquired'; lease: Lease }
  | { state: 'duplicate_run' | 'active_lease' };

export const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
export const DEFAULT_MAX_REDIRECTS = 3;
export const RETRY_DELAYS_MS = [250, 1_000] as const;

export function clampInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function stableNormalize(value: string): string {
  return normalizeWhitespace(value)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 500);
}

export function parseIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function safeHttpsUrl(value: string, base?: string): URL | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLocaleLowerCase('en-US');
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname === '[::1]' ||
      hostname === '::1' ||
      isPrivateIpv4(hostname)
    ) return null;
    url.username = '';
    url.password = '';
    return url;
  } catch {
    return null;
  }
}
