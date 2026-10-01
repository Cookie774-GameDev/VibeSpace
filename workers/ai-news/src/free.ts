interface Env {
  DB: D1Database;
  CORS_ORIGIN?: string;
  MAX_ITEMS_PER_RUN?: string;
  RETENTION_DAYS?: string;
  EXTRA_FEEDS?: string;
  BENCHMARK_SOURCE_URL?: string;
}

type Verification = 'official' | 'confirmed';
type Platform = 'official' | 'release' | 'media';

interface FeedSource {
  name: string;
  url: string;
  platform: Platform;
  verification: Verification;
  company?: string;
}

interface NewsCandidate {
  sourcePlatform: Platform;
  externalId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  text: string;
  company?: string;
  publishedAt: string;
  verification: Verification;
}

interface StoredNews extends NewsCandidate {
  summary: string;
  category: string;
  modelNames: string[];
  importanceScore: number;
  dedupeKey: string;
}

interface IngestionResult {
  status: 'success' | 'partial' | 'failed';
  fetched: number;
  stored: number;
  errors: Array<{ source: string; message: string }>;
  startedAt: string;
  completedAt: string;
}

const INGESTION_LEASE_MS = 15 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 12_000;
const SOURCE_RETRY_DELAYS_MS = [250, 1_000] as const;
const FRESHNESS_WARNING_MS = 2 * 60 * 60 * 1000;
const MAX_FEED_BYTES = 2_000_000;
const MIN_BENCHMARK_ROWS = 10;
const MAX_BENCHMARK_ROWS = 100;

const DEFAULT_FEEDS: FeedSource[] = [
  {
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    platform: 'official',
    verification: 'official',
    company: 'OpenAI',
  },
  {
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    platform: 'official',
    verification: 'official',
    company: 'Google',
  },
  {
    name: 'Google DeepMind',
    url: 'https://deepmind.google/blog/rss.xml',
    platform: 'official',
    verification: 'official',
    company: 'Google DeepMind',
  },
  {
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    platform: 'official',
    verification: 'official',
    company: 'Hugging Face',
  },
  {
    name: 'NVIDIA Generative AI',
    url: 'https://developer.nvidia.com/blog/category/generative-ai/feed/',
    platform: 'official',
    verification: 'official',
    company: 'NVIDIA',
  },
  {
    name: 'Ollama Releases',
    url: 'https://github.com/ollama/ollama/releases.atom',
    platform: 'release',
    verification: 'official',
    company: 'Ollama',
  },
  {
    name: 'Transformers Releases',
    url: 'https://github.com/huggingface/transformers/releases.atom',
    platform: 'release',
    verification: 'official',
    company: 'Hugging Face',
  },
  {
    name: 'Qwen Blog',
    url: 'https://qwenlm.github.io/blog/index.xml',
    platform: 'official',
    verification: 'official',
    company: 'Qwen',
  },
];

const MODEL_PATTERNS: Array<[RegExp, string]> = [
  [/\bGPT[- ]?[\w.]+\b/gi, 'GPT'],
  [/\bClaude(?:\s+[\w.]+){0,3}\b/gi, 'Claude'],
  [/\bGemini(?:\s+[\w.]+){0,3}\b/gi, 'Gemini'],
  [/\bGrok(?:\s+[\w.]+){0,2}\b/gi, 'Grok'],
  [/\bDeepSeek(?:[- ]?[\w.]+)?\b/gi, 'DeepSeek'],
  [/\bQwen(?:[- ]?[\w.]+)?\b/gi, 'Qwen'],
  [/\bMistral(?:\s+[\w.]+){0,2}\b/gi, 'Mistral'],
  [/\bLlama(?:\s+[\w.]+){0,2}\b/gi, 'Llama'],
];

export default {
  async fetch(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const headers = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, headers);
    }

    try {
      if (url.pathname === '/') {
        return json(
          {
            service: 'VibeSpace Free AI News',
            freeOnly: true,
            schedule: '7 * * * *',
            endpoints: [
              '/health',
              '/api/sources',
              '/api/news',
              '/api/news.json',
              '/api/benchmarks',
            ],
          },
          200,
          headers,
        );
      }

      if (url.pathname === '/api/sources') {
        return json({ sources: getFeeds(env) }, 200, headers);
      }

      if (url.pathname === '/health') {
        const latestRun = await env.DB.prepare(
          `SELECT started_at, completed_at, status, fetched_count, stored_count, error_json
           FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
        ).first();
        const count = await countNews(env);
        return json({ ok: true, freeOnly: true, itemCount: count, latestRun }, 200, headers);
      }

      if (url.pathname === '/api/news' || url.pathname === '/api/news.json') {
        return await getNews(url, env, headers);
      }

      if (url.pathname === '/api/benchmarks') {
        return await getBenchmarks(env, headers);
      }

      return json({ error: 'Not found' }, 404, headers);
    } catch (error) {
      console.error('Request failed', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return json({ error: 'News service failed' }, 500, headers);
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngestion(env, new Date(controller.scheduledTime).toISOString()));
  },
} satisfies ExportedHandler<Env>;

async function getNews(url: URL, env: Env, headers: Headers): Promise<Response> {
  const limit = clampInteger(url.searchParams.get('limit'), 30, 1, 100);
  const verification = url.searchParams.get('verification');
  const company = url.searchParams.get('company');
  const category = url.searchParams.get('category');
  const platform = url.searchParams.get('platform');

  const conditions: string[] = [];
  const bindings: Array<string | number> = [];

  if (verification === 'official' || verification === 'confirmed') {
    conditions.push('verification_status = ?');
    bindings.push(verification);
  }
  if (company) {
    conditions.push('company = ?');
    bindings.push(company.slice(0, 100));
  }
  if (category) {
    conditions.push('category = ?');
    bindings.push(category.slice(0, 50));
  }
  if (platform === 'official' || platform === 'release' || platform === 'media') {
    conditions.push('source_platform = ?');
    bindings.push(platform);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await env.DB.prepare(
    `SELECT
       id, source_platform, source_name, source_url, raw_title, ai_headline, ai_summary,
       company, model_names, category, verification_status, importance_score,
       published_at, collected_at
     FROM news_items
     ${where}
     ORDER BY published_at DESC, importance_score DESC
     LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<Record<string, unknown>>();

  const items = (result.results ?? []).map((row) => ({
    id: row.id,
    title: row.ai_headline || row.raw_title,
    summary: cleanText(String(row.ai_summary || '')),
    url: row.source_url,
    source: {
      platform: row.source_platform,
      name: row.source_name,
    },
    company: row.company,
    modelNames: safeJsonArray(row.model_names),
    category: row.category,
    verification: row.verification_status,
    importance: row.importance_score,
    publishedAt: row.published_at,
    collectedAt: row.collected_at,
  }));

  const latestRun = await env.DB.prepare(
    `SELECT completed_at, status, fetched_count, stored_count
     FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
  ).first();

  return json(
    {
      freeOnly: true,
      generatedAt: new Date().toISOString(),
      count: items.length,
      latestRun,
      freshness: freshnessForLatestRun(latestRun),
      items,
    },
    200,
    headers,
  );
}

async function getBenchmarks(env: Env, headers: Headers): Promise<Response> {
  const snapshot = await env.DB.prepare(
    `SELECT source_name, source_url, benchmark_date, ingested_at, row_count, payload_json
     FROM benchmark_snapshots ORDER BY id DESC LIMIT 1`,
  ).first<Record<string, unknown>>();
  if (!snapshot) {
    return json(
      {
        error: 'No verified benchmark snapshot is available yet.',
        source: { kind: 'independent-preference', name: 'Arena' },
        rows: [],
      },
      503,
      headers,
    );
  }

  const parsed = safeJsonArray(snapshot.payload_json);
  const rows = validateBenchmarkRows(parsed);
  if (rows.length < MIN_BENCHMARK_ROWS) {
    return json(
      {
        error: 'The retained benchmark snapshot did not pass validation.',
        source: { kind: 'independent-preference', name: 'Arena' },
        rows: [],
      },
      503,
      headers,
    );
  }

  return json(
    {
      freeOnly: true,
      source: {
        kind: 'independent-preference',
        name: String(snapshot.source_name || 'Arena'),
        url: String(snapshot.source_url || ''),
      },
      benchmarkDate: String(snapshot.benchmark_date || ''),
      ingestedAt: String(snapshot.ingested_at || ''),
      rowCount: rows.length,
      metric: 'Arena rating',
      normalizationNote:
        'Arena preference ratings are comparable only within this snapshot and are never merged with provider-published evaluations.',
      rows,
    },
    200,
    headers,
  );
}

function freshnessForLatestRun(latestRun: unknown): {
  state: 'fresh' | 'stale' | 'degraded' | 'failed' | 'never';
  ageMs?: number;
  warning?: string;
} {
  if (!latestRun || typeof latestRun !== 'object') {
    return {
      state: 'never',
      warning: 'No hourly refresh has completed yet. Showing retained data if available.',
    };
  }
  const row = latestRun as Record<string, unknown>;
  const completedAt =
    typeof row.completed_at === 'string' ? Date.parse(row.completed_at) : Number.NaN;
  if (!Number.isFinite(completedAt)) {
    return {
      state: 'never',
      warning:
        'No valid hourly refresh timestamp is available. Showing retained data if available.',
    };
  }
  const ageMs = Math.max(0, Date.now() - completedAt);
  if (row.status === 'failed') {
    return {
      state: 'failed',
      ageMs,
      warning: 'The latest hourly refresh failed. Showing the last retained data.',
    };
  }
  if (ageMs > FRESHNESS_WARNING_MS) {
    return {
      state: 'stale',
      ageMs,
      warning:
        row.status === 'partial'
          ? 'Hourly news data is stale and the last refresh was partial. Showing the last retained data.'
          : 'Hourly news data is stale. Showing the last retained data.',
    };
  }
  if (row.status === 'partial') {
    return {
      state: 'degraded',
      ageMs,
      warning: 'Some sources failed during the latest hourly refresh.',
    };
  }
  return { state: 'fresh', ageMs };
}

async function runIngestion(env: Env, scheduledAt?: string): Promise<IngestionResult | null> {
  const startedAt = new Date().toISOString();
  const runKey = `hourly:${scheduledAt ?? startedAt}`;
  const lease = await acquireIngestionLease(env, runKey);
  if (lease.state !== 'acquired') {
    await recordSkippedIngestion(env);
    console.log(JSON.stringify({ event: 'free_news_ingestion_skipped', reason: lease.state }));
    return null;
  }
  const fencingToken = lease.fencingToken;

  let finalStatus: IngestionResult['status'] = 'failed';
  let completedRun = false;
  let hasOriginalFailure = false;
  try {
    const sources = getFeeds(env).slice(0, 12);
    const collected = await collectInBatches(sources, 4);

    const errors = collected
      .filter((entry) => entry.error)
      .map((entry) => ({ source: entry.source, message: entry.error ?? 'Source failed' }));

    if (env.BENCHMARK_SOURCE_URL) {
      try {
        await refreshBenchmarkSnapshot(env, env.BENCHMARK_SOURCE_URL);
      } catch (error) {
        errors.push({ source: 'Arena benchmark', message: boundedSourceError(error) });
        console.error('Arena benchmark refresh failed', {
          kind: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }

    const candidates = uniqueCandidates(
      collected
        .flatMap((entry) => entry.items)
        .filter(isLikelyAiNews)
        .sort(compareCandidates),
    );

    const maxItems = clampInteger(env.MAX_ITEMS_PER_RUN, 30, 1, 40);
    const selected = candidates.slice(0, maxItems).map(enrichWithoutAi);
    if (selected.length === 0) {
      errors.push({
        source: 'scheduler',
        message: 'No usable dated news entries were found',
      });
    }
    const collectedAt = new Date().toISOString();

    // Fetching is the longest phase. Renew and verify the fencing token before
    // any retained data is mutated, so a recovered scheduler invocation cannot
    // be overwritten by an expired holder.
    await renewIngestionLease(env, runKey, fencingToken);

    let stored = 0;
    if (selected.length) {
      const statements = selected.map((item) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO news_items (
             source_platform, external_id, source_name, source_author, source_url,
             raw_title, raw_text, ai_headline, ai_summary, company, model_names,
             category, verification_status, importance_score, dedupe_key,
             published_at, collected_at, metadata_json
           )
           SELECT ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}'
           WHERE EXISTS (
             SELECT 1 FROM ingestion_leases
             WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?
           )`,
        ).bind(
          item.sourcePlatform,
          item.externalId,
          item.sourceName,
          item.sourceUrl,
          truncate(item.title, 500),
          truncate(item.text, 4000),
          truncate(item.title, 300),
          truncate(item.summary, 1000),
          item.company ?? null,
          JSON.stringify(item.modelNames),
          item.category,
          item.verification,
          item.importanceScore,
          item.dedupeKey,
          item.publishedAt,
          collectedAt,
          runKey,
          fencingToken,
        ),
      );

      const results = await env.DB.batch(statements);
      stored = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
    }

    const completedAt = new Date().toISOString();
    const status: IngestionResult['status'] =
      selected.length === 0 ? 'failed' : errors.length === 0 ? 'success' : 'partial';
    finalStatus = status;

    const auditStatement = env.DB.prepare(
      `INSERT INTO ingestion_runs (
         started_at, completed_at, status, fetched_count, stored_count, error_json
       )
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM ingestion_leases
         WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?
       )`,
    ).bind(
      startedAt,
      completedAt,
      status,
      candidates.length,
      stored,
      JSON.stringify(errors),
      runKey,
      fencingToken,
    );
    const retentionDays = clampInteger(env.RETENTION_DAYS, 45, 7, 180);
    const retentionStatement = env.DB.prepare(
      `DELETE FROM news_items
         WHERE published_at < datetime('now', ?)
           AND EXISTS (
             SELECT 1 FROM ingestion_leases
             WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?
           )`,
    ).bind(`-${retentionDays} days`, runKey, fencingToken);
    // D1 batch executes transactionally. Every mutation is fence-guarded; the
    // insert batch is also idempotent, so recovery can safely replay after loss.
    const [audit] = await env.DB.batch([auditStatement, retentionStatement]);
    completedRun = Number(audit?.meta.changes ?? 0) === 1;
    if (!completedRun) {
      throw new Error('Ingestion lease lost before audit finalization');
    }

    const result: IngestionResult = {
      status,
      fetched: candidates.length,
      stored,
      errors,
      startedAt,
      completedAt,
    };
    console.log(JSON.stringify({ event: 'free_news_ingestion_complete', ...result }));
    return result;
  } catch (error) {
    hasOriginalFailure = true;
    if (!completedRun) {
      completedRun = await recordUnexpectedIngestionFailure(env, startedAt, runKey, fencingToken);
    }
    console.error('AI News ingestion failed unexpectedly.');
    throw error;
  } finally {
    try {
      await releaseIngestionLease(env, runKey, fencingToken, finalStatus, completedRun);
    } catch (releaseError) {
      console.error('AI News ingestion lease release failed.');
      if (!hasOriginalFailure) throw releaseError;
    }
  }
}

type IngestionLeaseAcquisition =
  | { state: 'acquired'; fencingToken: string }
  | { state: 'duplicate_run' | 'active_lease' };

async function acquireIngestionLease(env: Env, runKey: string): Promise<IngestionLeaseAcquisition> {
  const acquiredAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + INGESTION_LEASE_MS).toISOString();
  const fencingToken = crypto.randomUUID();
  const result = await env.DB.prepare(
    `INSERT INTO ingestion_leases (lock_key, run_key, fencing_token, acquired_at, lease_until)
     VALUES ('hourly', ?, ?, ?, ?)
     ON CONFLICT(lock_key) DO UPDATE SET
       run_key = excluded.run_key,
       fencing_token = excluded.fencing_token,
       acquired_at = excluded.acquired_at,
       lease_until = excluded.lease_until
     WHERE ingestion_leases.lease_until <= excluded.acquired_at
       AND (
         ingestion_leases.last_completed_run_key IS NULL
         OR ingestion_leases.last_completed_run_key <> excluded.run_key
       )`,
  )
    .bind(runKey, fencingToken, acquiredAt, leaseUntil)
    .run();
  if (Number(result.meta.changes ?? 0) === 1) {
    return { state: 'acquired', fencingToken };
  }
  const current = await env.DB.prepare(
    `SELECT run_key, lease_until, last_completed_run_key
     FROM ingestion_leases WHERE lock_key = 'hourly'`,
  ).first<{ run_key: string; lease_until: string; last_completed_run_key?: string }>();
  return {
    state: current?.last_completed_run_key === runKey ? 'duplicate_run' : 'active_lease',
  };
}

async function recordSkippedIngestion(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE ingestion_leases
     SET last_skipped_at = ?, skip_count = skip_count + 1
     WHERE lock_key = 'hourly'`,
  )
    .bind(now)
    .run();
}

async function renewIngestionLease(env: Env, runKey: string, fencingToken: string): Promise<void> {
  const renewedUntil = new Date(Date.now() + INGESTION_LEASE_MS).toISOString();
  const result = await env.DB.prepare(
    `UPDATE ingestion_leases
     SET lease_until = ?
     WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?`,
  )
    .bind(renewedUntil, runKey, fencingToken)
    .run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error('Ingestion lease lost before persistence');
  }
}

async function recordUnexpectedIngestionFailure(
  env: Env,
  startedAt: string,
  runKey: string,
  fencingToken: string,
): Promise<boolean> {
  const completedAt = new Date().toISOString();
  try {
    const audit = await env.DB.prepare(
      `INSERT INTO ingestion_runs (
         started_at, completed_at, status, fetched_count, stored_count, error_json
       )
       SELECT ?, ?, 'failed', 0, 0, ?
       WHERE EXISTS (
         SELECT 1 FROM ingestion_leases
         WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?
       )`,
    )
      .bind(
        startedAt,
        completedAt,
        JSON.stringify([{ source: 'scheduler', message: 'Unexpected ingestion failure' }]),
        runKey,
        fencingToken,
      )
      .run();
    return Number(audit.meta.changes ?? 0) === 1;
  } catch {
    console.error('AI News failed-run audit persistence failed.');
    return false;
  }
}

async function releaseIngestionLease(
  env: Env,
  runKey: string,
  fencingToken: string,
  status: IngestionResult['status'],
  completedRun: boolean,
): Promise<void> {
  const completedAt = new Date().toISOString();
  if (!completedRun) {
    await env.DB.prepare(
      `UPDATE ingestion_leases
       SET lease_until = ?, last_status = ?
       WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?`,
    )
      .bind(completedAt, status, runKey, fencingToken)
      .run();
    return;
  }
  await env.DB.prepare(
    `UPDATE ingestion_leases
     SET lease_until = ?, last_completed_at = ?, last_status = ?,
         last_completed_run_key = ?
     WHERE lock_key = 'hourly' AND run_key = ? AND fencing_token = ?`,
  )
    .bind(completedAt, completedAt, status, runKey, runKey, fencingToken)
    .run();
}

async function collectInBatches(
  sources: FeedSource[],
  batchSize: number,
): Promise<Array<{ source: string; items: NewsCandidate[]; error?: string }>> {
  const results: Array<{ source: string; items: NewsCandidate[]; error?: string }> = [];

  for (let index = 0; index < sources.length; index += batchSize) {
    const batch = sources.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(collectFeed));
    settled.forEach((entry, entryIndex) => {
      const source = batch[entryIndex].name;
      if (entry.status === 'fulfilled') results.push({ source, items: entry.value });
      else {
        const message = boundedSourceError(entry.reason);
        console.error('AI News feed failed', {
          source,
          kind: entry.reason instanceof Error ? entry.reason.name : 'UnknownError',
        });
        results.push({ source, items: [], error: message });
      }
    });
  }

  return results;
}

async function collectFeed(source: FeedSource): Promise<NewsCandidate[]> {
  const xml = await fetchFeedTextWithRetry(source);
  const blocks = [...extractBlocks(xml, 'item'), ...extractBlocks(xml, 'entry')].slice(0, 12);

  return blocks.flatMap((block, index) => {
    const title = cleanText(readTag(block, ['title']));
    const url = readAtomLink(block) || cleanText(readTag(block, ['link']));
    const id = cleanText(readTag(block, ['guid', 'id'])) || url || `${source.url}#${index}`;
    const text = cleanText(
      readTag(block, ['description', 'summary', 'content:encoded', 'content']),
    );
    const publishedAt = normalizeDate(
      readTag(block, ['pubDate', 'published', 'updated', 'dc:date']),
    );

    if (!title || !url || !publishedAt) return [];
    return [
      {
        sourcePlatform: source.platform,
        externalId: id,
        sourceName: source.name,
        sourceUrl: url,
        title,
        text,
        company: source.company ?? inferCompany(`${title} ${text}`),
        publishedAt,
        verification: source.verification,
      } satisfies NewsCandidate,
    ];
  });
}

async function fetchFeedTextWithRetry(source: FeedSource): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SOURCE_RETRY_DELAYS_MS.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
    try {
      const response = await fetch(source.url, {
        headers: {
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          'User-Agent': 'VibeSpaceNews/1.0 (+https://vibespaceos.com)',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) {
        cancelResponseBody(response);
        throw new Error(`HTTP ${response.status}`);
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (contentLength > MAX_FEED_BYTES) {
        cancelResponseBody(response);
        throw new Error('Feed is larger than 2 MB');
      }
      return await readBoundedFeedBody(response, controller.signal);
    } catch (error) {
      lastError = error;
      if (attempt >= SOURCE_RETRY_DELAYS_MS.length || !isRetryableSourceError(error)) throw error;
      await sleep(SOURCE_RETRY_DELAYS_MS[attempt]);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function cancelResponseBody(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => undefined);
}

async function readBoundedFeedBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let totalBytes = 0;
  let complete = false;
  let cancelRequested = false;

  const cancelReader = () => {
    if (cancelRequested) return;
    cancelRequested = true;
    void reader.cancel().catch(() => undefined);
  };
  let rejectForAbort: ((reason: DOMException) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const onAbort = () => {
    rejectForAbort?.(new DOMException('Source timed out', 'AbortError'));
    cancelReader();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) {
        parts.push(decoder.decode());
        complete = true;
        return parts.join('');
      }
      if (totalBytes + chunk.value.byteLength > MAX_FEED_BYTES) {
        cancelReader();
        throw new Error('Feed is larger than 2 MB');
      }
      totalBytes += chunk.value.byteLength;
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!complete) cancelReader();
    try {
      reader.releaseLock();
    } catch {
      // A pending read releases after cancellation settles.
    }
  }
}

function isRetryableSourceError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  return error instanceof Error && /^HTTP (408|429|5\d\d)$/.test(error.message);
}

function boundedSourceError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Source timed out';
  if (error instanceof TypeError) return 'Source network request failed';
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) return error.message;
  if (error instanceof Error && error.message === 'Feed is larger than 2 MB') return error.message;
  return 'Source response failed';
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function enrichWithoutAi(item: NewsCandidate): StoredNews {
  const combined = `${item.title} ${item.text}`;
  return {
    ...item,
    summary: truncate(item.text || item.title, 500),
    category: inferCategory(combined, item.sourcePlatform),
    modelNames: findModelNames(combined),
    importanceScore: scoreImportance(item, combined),
    dedupeKey: hashString(`${normalize(item.title)}|${normalize(item.company ?? '')}`),
  };
}

function getFeeds(env: Env): FeedSource[] {
  const extras = parseExtraFeeds(env.EXTRA_FEEDS);
  const seen = new Set<string>();
  return [...DEFAULT_FEEDS, ...extras].filter((feed) => {
    if (!feed.name || !feed.url || seen.has(feed.url)) return false;
    if (!feed.url.startsWith('https://')) return false;
    seen.add(feed.url);
    return true;
  });
}

function parseExtraFeeds(value?: string): FeedSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.name !== 'string' || typeof value.url !== 'string') return [];
      const platform: Platform =
        value.platform === 'release' || value.platform === 'media' ? value.platform : 'official';
      const verification: Verification =
        value.verification === 'confirmed' ? 'confirmed' : 'official';
      return [
        {
          name: value.name.slice(0, 100),
          url: value.url,
          company: typeof value.company === 'string' ? value.company.slice(0, 100) : undefined,
          platform,
          verification,
        },
      ];
    });
  } catch {
    return [];
  }
}

function uniqueCandidates(items: NewsCandidate[]): NewsCandidate[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  return items.filter((item) => {
    const titleKey = normalize(item.title);
    if (!item.sourceUrl || seenUrls.has(item.sourceUrl) || seenTitles.has(titleKey)) return false;
    seenUrls.add(item.sourceUrl);
    seenTitles.add(titleKey);
    return true;
  });
}

function compareCandidates(left: NewsCandidate, right: NewsCandidate): number {
  const publishedDelta = Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  if (publishedDelta !== 0) return publishedDelta;
  const titleDelta = normalize(left.title).localeCompare(normalize(right.title), 'en');
  if (titleDelta !== 0) return titleDelta;
  return left.sourceUrl.localeCompare(right.sourceUrl, 'en');
}

function isLikelyAiNews(item: NewsCandidate): boolean {
  if (item.sourcePlatform !== 'media') return true;
  const text = ` ${item.title} ${item.text} `.toLowerCase();
  return [
    ' ai ',
    'artificial intelligence',
    'model',
    'llm',
    'openai',
    'anthropic',
    'claude',
    'gemini',
    'deepseek',
    'qwen',
    'mistral',
    'grok',
    'llama',
  ].some((term) => text.includes(term));
}

function inferCategory(text: string, platform: Platform): string {
  const value = text.toLowerCase();
  if (
    platform === 'release' ||
    /\b(release|launch|introduc|announce|new model|model update)\b/.test(value)
  ) {
    return 'model-release';
  }
  if (/\b(research|paper|benchmark|evaluation|study|arxiv)\b/.test(value)) return 'research';
  if (/\b(api|sdk|developer|framework|agent|coding|tool|library)\b/.test(value))
    return 'developer-tools';
  if (/\b(safety|security|policy|regulation|governance)\b/.test(value)) return 'safety-policy';
  if (/\b(partner|funding|acquire|business|enterprise)\b/.test(value)) return 'business';
  return 'general';
}

function inferCompany(text: string): string | undefined {
  const matchers: Array<[RegExp, string]> = [
    [/\bopenai\b|\bchatgpt\b|\bcodex\b/i, 'OpenAI'],
    [/\banthropic\b|\bclaude\b/i, 'Anthropic'],
    [/\bdeepmind\b/i, 'Google DeepMind'],
    [/\bgemini\b|\bgoogle ai\b/i, 'Google'],
    [/\bxai\b|\bgrok\b/i, 'xAI'],
    [/\bmeta ai\b|\bllama\b/i, 'Meta'],
    [/\bdeepseek\b/i, 'DeepSeek'],
    [/\bqwen\b|\balibaba\b/i, 'Alibaba'],
    [/\bmistral\b/i, 'Mistral AI'],
    [/\bhugging face\b|\bhuggingface\b/i, 'Hugging Face'],
    [/\bnvidia\b/i, 'NVIDIA'],
  ];
  return matchers.find(([pattern]) => pattern.test(text))?.[1];
}

function findModelNames(text: string): string[] {
  const names = new Set<string>();
  for (const [pattern, family] of MODEL_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches.slice(0, 3)) names.add(match.trim() || family);
  }
  return [...names]
    .sort((left, right) => {
      const normalized = normalize(left).localeCompare(normalize(right), 'en');
      return normalized || left.localeCompare(right, 'en');
    })
    .slice(0, 8);
}

function scoreImportance(item: NewsCandidate, text: string): number {
  let score = item.verification === 'official' ? 75 : 55;
  if (item.sourcePlatform === 'release') score += 10;
  if (/\b(release|launch|introducing|available now|new model)\b/i.test(text)) score += 10;
  if (/\b(frontier|major|breakthrough|state[- ]of[- ]the[- ]art)\b/i.test(text)) score += 5;
  return Math.min(100, score);
}

function extractBlocks(xml: string, tag: string): string[] {
  const expression = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return xml.match(expression) ?? [];
}

function readTag(block: string, tags: string[]): string {
  for (const tag of tags) {
    const expression = new RegExp(
      `<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`,
      'i',
    );
    const match = block.match(expression);
    if (match?.[1]) return match[1];
  }
  return '';
}

function readAtomLink(block: string): string {
  const preferred = block.match(
    /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i,
  );
  if (preferred?.[1]) return decodeEntities(preferred[1]);
  const any = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return any?.[1] ? decodeEntities(any[1]) : '';
}

function cleanText(value: string): string {
  return decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return value
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function normalizeDate(value: string): string | null {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 300);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

interface BenchmarkSnapshotRow {
  rank: number;
  model: string;
  vendor: string;
  license: string | null;
  score: number;
  ci: number;
  votes: number;
}

function validateBenchmarkRows(value: unknown): BenchmarkSnapshotRow[] {
  if (!Array.isArray(value)) return [];
  const rows: BenchmarkSnapshotRow[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, MAX_BENCHMARK_ROWS)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const model = typeof row.model === 'string' ? row.model.trim().slice(0, 160) : '';
    const vendor = typeof row.vendor === 'string' ? row.vendor.trim().slice(0, 100) : '';
    const score = typeof row.score === 'number' ? row.score : Number.NaN;
    const ci = typeof row.ci === 'number' ? row.ci : 0;
    const votes = typeof row.votes === 'number' ? row.votes : 0;
    const key = model.toLowerCase();
    if (
      !model ||
      !vendor ||
      seen.has(key) ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 5_000 ||
      !Number.isFinite(ci) ||
      ci < 0 ||
      ci > 500 ||
      !Number.isFinite(votes) ||
      votes < 0
    ) {
      continue;
    }
    seen.add(key);
    rows.push({
      rank: rows.length + 1,
      model,
      vendor,
      license:
        typeof row.license === 'string' && row.license.trim()
          ? row.license.trim().slice(0, 80)
          : null,
      score: Math.round(score),
      ci: Math.round(ci),
      votes: Math.round(votes),
    });
  }
  return rows;
}

async function refreshBenchmarkSnapshot(env: Env, sourceUrl: string): Promise<void> {
  if (!sourceUrl.startsWith('https://')) throw new Error('Benchmark source URL is invalid');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'VibeSpaceBenchmarks/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) {
      cancelResponseBody(response);
      throw new Error(`HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_FEED_BYTES) {
      cancelResponseBody(response);
      throw new Error('Feed is larger than 2 MB');
    }
    const body = await readBoundedFeedBody(response, controller.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new Error('Benchmark response failed');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Benchmark response failed');
    }
    const root = payload as Record<string, unknown>;
    const rows = validateBenchmarkRows(root.models);
    if (rows.length < MIN_BENCHMARK_ROWS) {
      throw new Error('Benchmark response failed');
    }
    const meta =
      root.meta && typeof root.meta === 'object' && !Array.isArray(root.meta)
        ? (root.meta as Record<string, unknown>)
        : {};
    const benchmarkDateRaw =
      typeof meta.fetched_at === 'string' ? meta.fetched_at : new Date().toISOString();
    const benchmarkDate = Number.isFinite(Date.parse(benchmarkDateRaw))
      ? new Date(benchmarkDateRaw).toISOString()
      : new Date().toISOString();
    const reportedSource =
      typeof meta.source_url === 'string' && meta.source_url.startsWith('https://')
        ? meta.source_url
        : sourceUrl;
    const ingestedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO benchmark_snapshots (
         source_name, source_url, benchmark_date, ingested_at, row_count, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind('Arena', reportedSource, benchmarkDate, ingestedAt, rows.length, JSON.stringify(rows))
      .run();
    await env.DB.prepare(
      `DELETE FROM benchmark_snapshots
       WHERE id NOT IN (SELECT id FROM benchmark_snapshots ORDER BY id DESC LIMIT 72)`,
    ).run();
  } finally {
    clearTimeout(timeout);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function countNews(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM news_items').first<{
    count: number;
  }>();
  return Number(row?.count ?? 0);
}

function corsHeaders(env: Env): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
  });
}

function json(payload: unknown, status: number, baseHeaders: Headers): Response {
  const headers = new Headers(baseHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(payload), { status, headers });
}
