export interface Env {
  DB: D1Database;
  AA_API_KEY?: string;
  X_BEARER_TOKEN?: string;
  NEWS_MAX_SOURCES_PER_RUN?: string;
  NEWS_MAX_X_SOURCES_PER_RUN?: string;
  NEWS_MAX_ITEMS_PER_RUN?: string;
  NEWS_MEDIA_ENRICHMENT_LIMIT?: string;
  NEWS_RETENTION_DAYS?: string;
  FRESHNESS_SLA_MINUTES?: string;
}

export type PipelineName = 'news-hourly' | 'benchmarks-hourly';
export type PipelineStatus = 'success' | 'partial' | 'failed' | 'skipped';

export interface PipelineRunResult {
  pipeline: PipelineName;
  runKey: string;
  status: PipelineStatus;
  fetchedCount: number;
  storedCount: number;
  succeededSources: number;
  failedSources: number;
  metadata?: Record<string, unknown>;
  errors?: Array<{ code: string; sourceId?: string }>;
}

export interface Lease {
  pipeline: PipelineName;
  runKey: string;
  fencingToken: string;
  acquiredAt: string;
  leaseUntil: string;
}

export interface BoundedFetchOptions {
  headers?: HeadersInit;
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  retries?: number;
  retryStatuses?: readonly number[];
  accept?: string;
}

export interface BoundedFetchResult {
  response: Response;
  finalUrl: string;
  bytes: Uint8Array;
  text: string;
  contentType: string;
}

export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

const DEFAULT_RETRY_STATUSES = [408, 425, 429, 500, 502, 503, 504] as const;
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-max-age': '86400',
};

export function envInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export function scheduledIso(scheduledTime: number | undefined): string {
  return new Date(scheduledTime ?? Date.now()).toISOString();
}

export function runKeyFor(pipeline: PipelineName, scheduledAt: string): string {
  return `${pipeline}:${scheduledAt.slice(0, 13)}`;
}

export function jsonResponse(payload: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', status >= 400 ? 'no-store' : 'public, max-age=60, stale-while-revalidate=300');
  for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
  return new Response(JSON.stringify(payload), { status, headers });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function safeErrorCode(error: unknown, fallback = 'UNKNOWN_ERROR'): string {
  if (error instanceof PipelineError) return error.code;
  if (error instanceof DOMException && error.name === 'AbortError') return 'SOURCE_TIMEOUT';
  if (error instanceof TypeError) return 'SOURCE_NETWORK_ERROR';
  return fallback;
}

export function safeHttpsUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalUrl(value: string): string | null {
  const safe = safeHttpsUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|ref$|ref_|source$|campaign$|mc_)/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  url.searchParams.sort();
  return url.toString();
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function stripHtml(value: string): string {
  return decodeXmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    );
}

export function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry as object)) throw new TypeError('Cannot stringify a cyclic value.');
    seen.add(entry as object);
    if (Array.isArray(entry)) return entry.map(normalize);
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function parseRetryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(5_000, Math.max(0, timestamp - Date.now()));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PipelineError('SOURCE_TOO_LARGE', 'Remote response exceeded the configured byte limit.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response too large');
        throw new PipelineError('SOURCE_TOO_LARGE', 'Remote response exceeded the configured byte limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Bounded, HTTPS-only fetch with small transient retries and redirect limits. */
export async function boundedFetch(
  initialUrl: string,
  options: BoundedFetchOptions = {},
): Promise<BoundedFetchResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const retries = options.retries ?? 1;
  const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const initial = safeHttpsUrl(initialUrl);
  if (!initial) throw new PipelineError('SOURCE_URL_INVALID', 'Only credential-free HTTPS URLs are allowed.');

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let currentUrl = initial;
    let redirects = 0;
    try {
      while (true) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          const headers = new Headers(options.headers);
          headers.set('accept', options.accept ?? 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, text/html;q=0.7');
          headers.set('user-agent', 'VibeSpace-AI-Intelligence/2.0 (+https://vibespaceos.com)');
          response = await fetch(currentUrl, {
            method: options.method ?? 'GET',
            headers,
            redirect: 'manual',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects >= maxRedirects) {
            throw new PipelineError('SOURCE_REDIRECT_LIMIT', 'Remote source exceeded the redirect limit.');
          }
          const location = response.headers.get('location');
          if (!location) throw new PipelineError('SOURCE_REDIRECT_INVALID', 'Redirect omitted a location.');
          const redirected = safeHttpsUrl(new URL(location, currentUrl).toString());
          if (!redirected) throw new PipelineError('SOURCE_REDIRECT_INVALID', 'Redirect left HTTPS.');
          currentUrl = redirected;
          redirects += 1;
          continue;
        }

        if (!response.ok) {
          const retryable = retryStatuses.includes(response.status);
          const error = new PipelineError(
            `SOURCE_HTTP_${response.status}`,
            `Remote source returned HTTP ${response.status}.`,
            retryable,
          );
          if (retryable && attempt < retries) {
            await sleep(parseRetryAfter(response) ?? 250 * 2 ** attempt);
            throw error;
          }
          throw error;
        }

        const bytes = await readBoundedBody(response, maxBytes);
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        return {
          response,
          finalUrl: currentUrl,
          bytes,
          text: new TextDecoder().decode(bytes),
          contentType,
        };
      }
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof PipelineError ? error.retryable : error instanceof TypeError || error instanceof DOMException;
      if (!retryable || attempt >= retries) break;
      await sleep(250 * 2 ** attempt);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new PipelineError('SOURCE_FETCH_FAILED', 'Remote source fetch failed.');
}

export async function acquirePipelineLease(
  db: D1Database,
  pipeline: PipelineName,
  runKey: string,
  acquiredAt: string,
  leaseMinutes = 12,
): Promise<Lease | null> {
  const fencingToken = crypto.randomUUID();
  const leaseUntil = new Date(Date.parse(acquiredAt) + leaseMinutes * 60_000).toISOString();
  const result = await db
    .prepare(
      `INSERT INTO intelligence_pipeline_leases
        (pipeline, run_key, fencing_token, acquired_at, lease_until)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pipeline) DO UPDATE SET
         run_key = excluded.run_key,
         fencing_token = excluded.fencing_token,
         acquired_at = excluded.acquired_at,
         lease_until = excluded.lease_until
       WHERE intelligence_pipeline_leases.lease_until <= excluded.acquired_at
         AND COALESCE(intelligence_pipeline_leases.last_completed_run_key, '') <> excluded.run_key`,
    )
    .bind(pipeline, runKey, fencingToken, acquiredAt, leaseUntil)
    .run();
  if ((result.meta.changes ?? 0) < 1) return null;
  return { pipeline, runKey, fencingToken, acquiredAt, leaseUntil };
}

export async function startPipelineRun(
  db: D1Database,
  lease: Lease,
  scheduledAt: string,
): Promise<number | null> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO intelligence_pipeline_runs
        (pipeline, run_key, scheduled_at, started_at, status)
       VALUES (?, ?, ?, ?, 'running')`,
    )
    .bind(lease.pipeline, lease.runKey, scheduledAt, lease.acquiredAt)
    .run();
  const row = await db
    .prepare(
      `SELECT id, status FROM intelligence_pipeline_runs
       WHERE pipeline = ? AND run_key = ? LIMIT 1`,
    )
    .bind(lease.pipeline, lease.runKey)
    .first<{ id: number; status: string }>();
  if (!row || row.status !== 'running') return null;
  return row.id;
}

export async function completePipelineRun(
  db: D1Database,
  lease: Lease,
  runId: number,
  result: PipelineRunResult,
  completedAt = nowIso(),
): Promise<void> {
  const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(lease.acquiredAt));
  const errorCode = result.errors?.[0]?.code ?? null;
  await db.batch([
    db
      .prepare(
        `UPDATE intelligence_pipeline_runs SET
           completed_at = ?, status = ?, fetched_count = ?, stored_count = ?,
           succeeded_sources = ?, failed_sources = ?, duration_ms = ?,
           metadata_json = ?, error_json = ?
         WHERE id = ? AND pipeline = ? AND run_key = ?`,
      )
      .bind(
        completedAt,
        result.status,
        result.fetchedCount,
        result.storedCount,
        result.succeededSources,
        result.failedSources,
        durationMs,
        JSON.stringify(result.metadata ?? {}),
        JSON.stringify(result.errors ?? []),
        runId,
        lease.pipeline,
        lease.runKey,
      ),
    db
      .prepare(
        `UPDATE intelligence_pipeline_leases SET
           last_completed_run_key = ?, last_completed_at = ?, last_status = ?,
           last_error_code = ?, lease_until = ?
         WHERE pipeline = ? AND run_key = ? AND fencing_token = ?`,
      )
      .bind(
        lease.runKey,
        completedAt,
        result.status,
        errorCode,
        completedAt,
        lease.pipeline,
        lease.runKey,
        lease.fencingToken,
      ),
  ]);
}

export async function recordSkippedLease(
  db: D1Database,
  pipeline: PipelineName,
): Promise<void> {
  await db
    .prepare(
      `UPDATE intelligence_pipeline_leases
       SET skip_count = skip_count + 1
       WHERE pipeline = ?`,
    )
    .bind(pipeline)
    .run();
}

export function freshnessFromTimestamp(
  timestamp: string | null | undefined,
  now = Date.now(),
  slaMinutes = 120,
): { state: 'fresh' | 'degraded' | 'stale' | 'failed' | 'never'; ageMs?: number; warning?: string } {
  if (!timestamp) return { state: 'never', warning: 'No completed ingestion run is available.' };
  const observed = Date.parse(timestamp);
  if (!Number.isFinite(observed)) return { state: 'failed', warning: 'Stored freshness timestamp is invalid.' };
  const ageMs = Math.max(0, now - observed);
  if (ageMs <= slaMinutes * 60_000) return { state: 'fresh', ageMs };
  if (ageMs <= slaMinutes * 2 * 60_000) {
    return { state: 'degraded', ageMs, warning: 'The latest dataset is outside the preferred freshness window.' };
  }
  return { state: 'stale', ageMs, warning: 'The latest dataset is stale; last-known-good data is retained.' };
}
