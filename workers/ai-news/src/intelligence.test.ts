import { describe, expect, it } from 'vitest';
import { routeRequest } from './intelligence';
import type { Env } from './runtime';
import { resolveNewsFreshness } from './newsPipeline';

function healthEnv(newsStatus = 'success'): Env {
  const recent = new Date(Date.now() - 60_000).toISOString();
  const db = {
    prepare(sql: string) {
      const first = async (params: unknown[] = []) => {
        if (sql.includes('intelligence_pipeline_runs')) {
          const pipeline = params[0];
          return {
            pipeline,
            completed_at: recent,
            status: pipeline === 'news-hourly' ? newsStatus : 'success',
            fetched_count: 197,
            stored_count: 197,
            succeeded_sources: 1,
            failed_sources: 0,
            duration_ms: 100,
            metadata_json: '{"datasetId":"aa-incomplete"}',
            error_json: '[]',
          };
        }
        if (sql.includes('benchmark_current_v2')) {
          return {
            id: 'aa-incomplete',
            source_observed_at: recent,
            ingested_at: recent,
            row_count: 197,
            metadata_json: '{"api":"v2","validated":true}',
            promoted_at: recent,
          };
        }
        if (sql.includes('intelligence_news_events')) {
          return { item_count: 0, newest_item_at: null, last_write_at: null };
        }
        return null;
      };
      return {
        bind: (...params: unknown[]) => ({
          first: () => first(params),
          all: async () => ({ results: [] }),
        }),
        first: () => first(),
        all: async () => ({ results: [] }),
      };
    },
  } as unknown as D1Database;
  return { DB: db };
}

describe('intelligence health', () => {
  it('preserves stale and never states and degrades a new failure after a usable refresh', () => {
    const now = Date.parse('2026-09-07T21:30:00Z');
    const usable = { status: 'success', completed_at: '2026-09-07T21:07:00Z' };
    const failed = { status: 'failed', completed_at: '2026-09-07T21:20:00Z' };
    expect(resolveNewsFreshness(usable, failed, now).state).toBe('degraded');
    expect(resolveNewsFreshness(usable, usable, now).state).toBe('fresh');
    expect(resolveNewsFreshness(usable, failed, now + 5 * 3600_000).state).toBe('stale');
    expect(resolveNewsFreshness(null, null, now).state).toBe('never');
  });
  it('reports partial news ingestion as degraded in health as well as the feed', async () => {
    const response = await routeRequest(
      new Request('https://intelligence.example/health'),
      healthEnv('partial'),
      { waitUntil: () => {} },
    );
    const payload = (await response.json()) as {
      news: { freshness: { state: string; warning?: string } };
    };
    expect(payload.news.freshness).toMatchObject({
      state: 'degraded',
      warning: 'Some approved sources failed during the latest refresh.',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('reports a recent dataset without page completeness as degraded, not fresh', async () => {
    const response = await routeRequest(
      new Request('https://intelligence.example/health'),
      healthEnv(),
      { waitUntil: () => {} },
    );
    const payload = (await response.json()) as {
      benchmarks: {
        freshness: { state: string };
        currentDataset: { completeness: { state: string } };
        latestRun: { status: string; errors: unknown[] };
      };
    };
    expect(payload.benchmarks.freshness.state).toBe('degraded');
    expect(payload.benchmarks.currentDataset.completeness.state).toBe('unverified');
    expect(payload.benchmarks.latestRun).toMatchObject({ status: 'success', errors: [] });
  });
});
