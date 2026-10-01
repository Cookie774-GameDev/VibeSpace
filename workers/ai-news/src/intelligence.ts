import { readBenchmarkApi, runBenchmarkIngestion } from './benchmarkPipeline';
import { NEWS_SOURCES } from './newsSources';
import { readNewsApi, readSourcesApi, runNewsIngestion } from './newsPipeline';
import {
  freshnessFromTimestamp,
  jsonResponse,
  nowIso,
  optionsResponse,
  safeErrorCode,
  scheduledIso,
  type Env,
} from './runtime';

interface LatestRunRow {
  pipeline: 'news-hourly' | 'benchmarks-hourly';
  completed_at: string | null;
  status: string;
  fetched_count: number;
  stored_count: number;
  succeeded_sources: number;
  failed_sources: number;
  duration_ms: number | null;
  metadata_json: string;
  error_json: string;
}

interface SourceHealthCount {
  status: string;
  count: number;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function latestRun(env: Env, pipeline: LatestRunRow['pipeline']): Promise<LatestRunRow | null> {
  return env.DB
    .prepare(
      `SELECT pipeline, completed_at, status, fetched_count, stored_count,
              succeeded_sources, failed_sources, duration_ms, metadata_json, error_json
       FROM intelligence_pipeline_runs
       WHERE pipeline = ? AND completed_at IS NOT NULL
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(pipeline)
    .first<LatestRunRow>();
}

async function latestUsableRun(
  env: Env,
  pipeline: LatestRunRow['pipeline'],
): Promise<LatestRunRow | null> {
  return env.DB
    .prepare(
      `SELECT pipeline, completed_at, status, fetched_count, stored_count,
              succeeded_sources, failed_sources, duration_ms, metadata_json, error_json
       FROM intelligence_pipeline_runs
       WHERE pipeline = ? AND completed_at IS NOT NULL AND status IN ('success', 'partial')
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .bind(pipeline)
    .first<LatestRunRow>();
}

function publicRun(row: LatestRunRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    pipeline: row.pipeline,
    completedAt: row.completed_at,
    status: row.status,
    fetchedCount: row.fetched_count,
    storedCount: row.stored_count,
    succeededSources: row.succeeded_sources,
    failedSources: row.failed_sources,
    durationMs: row.duration_ms,
    metadata: parseJson(row.metadata_json),
    errors: parseJson(row.error_json),
  };
}

async function healthPayload(env: Env): Promise<Record<string, unknown>> {
  const [newsLatest, benchmarkLatest, newsUsable, benchmarkUsable, healthCounts, benchmarkCurrent, newsStats] =
    await Promise.all([
      latestRun(env, 'news-hourly'),
      latestRun(env, 'benchmarks-hourly'),
      latestUsableRun(env, 'news-hourly'),
      latestUsableRun(env, 'benchmarks-hourly'),
      env.DB
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM intelligence_news_source_health
           GROUP BY status
           ORDER BY status ASC`,
        )
        .all<SourceHealthCount>(),
      env.DB
        .prepare(
          `SELECT d.id, d.source_observed_at, d.ingested_at, d.row_count, c.promoted_at
           FROM benchmark_current_v2 c
           JOIN benchmark_datasets_v2 d ON d.id = c.dataset_id
           WHERE c.singleton = 1 AND d.status = 'current'
           LIMIT 1`,
        )
        .first<{
          id: string;
          source_observed_at: string;
          ingested_at: string;
          row_count: number;
          promoted_at: string;
        }>(),
      env.DB
        .prepare(
          `SELECT COUNT(*) AS item_count, MAX(published_at) AS newest_item_at,
                  MAX(updated_at) AS last_write_at
           FROM intelligence_news_events`,
        )
        .first<{ item_count: number; newest_item_at: string | null; last_write_at: string | null }>(),
    ]);

  const slaMinutes = Number.parseInt(env.FRESHNESS_SLA_MINUTES ?? '120', 10) || 120;
  const newsFreshness = freshnessFromTimestamp(newsUsable?.completed_at, Date.now(), slaMinutes);
  const benchmarkFreshness = freshnessFromTimestamp(
    benchmarkCurrent?.promoted_at ?? benchmarkUsable?.completed_at,
    Date.now(),
    slaMinutes,
  );
  const sourceCounts = Object.fromEntries(
    healthCounts.results.map((entry) => [entry.status, Number(entry.count)]),
  );
  const enabledYouTubeSources = NEWS_SOURCES.filter(
    (source) => source.enabled && source.sourceType === 'youtube_feed',
  ).length;
  const aggregateState =
    newsFreshness.state === 'failed' || benchmarkFreshness.state === 'failed'
      ? 'failed'
      : newsFreshness.state === 'stale' || benchmarkFreshness.state === 'stale'
        ? 'stale'
        : newsFreshness.state === 'degraded' || benchmarkFreshness.state === 'degraded'
          ? 'degraded'
          : newsFreshness.state === 'never' || benchmarkFreshness.state === 'never'
            ? 'degraded'
            : 'fresh';

  return {
    ok: aggregateState === 'fresh' || aggregateState === 'degraded',
    state: aggregateState,
    generatedAt: nowIso(),
    worker: 'vibespace-ai-news',
    schedule: '7 * * * *',
    news: {
      freshness: newsFreshness,
      latestRun: publicRun(newsLatest),
      latestUsableRun: publicRun(newsUsable),
      itemCount: Number(newsStats?.item_count ?? 0),
      newestItemAt: newsStats?.newest_item_at ?? null,
      lastWriteAt: newsStats?.last_write_at ?? null,
      sourceRegistryCount: NEWS_SOURCES.length,
      sourceHealth: sourceCounts,
      x: {
        active: Boolean(env.X_BEARER_TOKEN?.trim()),
        status: env.X_BEARER_TOKEN?.trim() ? 'configured' : 'unavailable',
      },
      youtube: {
        activeFeedSources: enabledYouTubeSources,
        mediaParserActive: true,
      },
    },
    benchmarks: {
      freshness: benchmarkFreshness,
      latestRun: publicRun(benchmarkLatest),
      latestUsableRun: publicRun(benchmarkUsable),
      currentDataset: benchmarkCurrent
        ? {
            id: benchmarkCurrent.id,
            source: 'Artificial Analysis',
            metric: 'Artificial Analysis Intelligence Index',
            sourceObservedAt: benchmarkCurrent.source_observed_at,
            ingestedAt: benchmarkCurrent.ingested_at,
            promotedAt: benchmarkCurrent.promoted_at,
            rowCount: benchmarkCurrent.row_count,
          }
        : null,
      sourceCapability: env.AA_API_KEY?.trim() ? 'configured' : 'unavailable',
    },
  };
}

function headOnly(request: Request, response: Response): Response {
  if (request.method !== 'HEAD') return response;
  return new Response(null, { status: response.status, headers: response.headers });
}

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') return optionsResponse();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, HEAD, OPTIONS' });
  }
  const url = new URL(request.url);
  let response: Response;
  switch (url.pathname) {
    case '/':
      response = jsonResponse({
        service: 'VibeSpace AI Intelligence',
        freeOnly: true,
        schedule: '7 * * * *',
        endpoints: ['/api/news', '/api/benchmarks', '/api/sources', '/health'],
      });
      break;
    case '/api/news':
    case '/api/news.json': {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const payload = await readNewsApi(env, limit);
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (items.length === 0) {
        ctx.waitUntil(runNewsIngestion(env, nowIso()).then(() => undefined));
      }
      response = jsonResponse(payload);
      break;
    }
    case '/api/benchmarks':
    case '/api/benchmarks.json':
      response = jsonResponse(await readBenchmarkApi(env));
      break;
    case '/api/sources':
      response = jsonResponse(await readSourcesApi(env));
      break;
    case '/health':
      response = jsonResponse(await healthPayload(env), 200, { 'cache-control': 'no-store' });
      break;
    default:
      response = jsonResponse({ error: 'NOT_FOUND' }, 404);
  }
  return headOnly(request, response);
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await routeRequest(request, env, ctx);
    } catch (error) {
      return jsonResponse(
        {
          error: 'INTELLIGENCE_BACKEND_UNAVAILABLE',
          code: safeErrorCode(error, 'DATABASE_OR_RUNTIME_ERROR'),
        },
        503,
        { 'cache-control': 'no-store' },
      );
    }
  },

  async scheduled(event, env, ctx): Promise<void> {
    const scheduledAt = scheduledIso(event.scheduledTime);
    ctx.waitUntil(
      Promise.allSettled([
        runNewsIngestion(env, scheduledAt),
        runBenchmarkIngestion(env, scheduledAt),
      ]).then(() => undefined),
    );
  },
};

export default worker;
export { healthPayload, routeRequest };
