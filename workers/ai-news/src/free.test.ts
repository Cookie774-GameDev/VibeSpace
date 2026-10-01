import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from './free';

type Row = Record<string, unknown>;

function createDatabase(options?: {
  failAllWith?: Error;
  failOnceQuery?: { includes: string; error: Error };
  failReleaseWith?: Error;
  latestRun?: Row;
  newsRows?: Row[];
  benchmarkSnapshot?: Row;
  lease?: {
    runKey: string;
    leaseUntil: string;
    lastCompletedRunKey?: string;
  };
}) {
  let failedConfiguredQuery = false;
  let ingestionLeaseHeld = Boolean(options?.lease);
  let ingestionLeaseUntil = options?.lease?.leaseUntil;
  let lastIngestionRunKey: unknown = options?.lease?.runKey;
  let lastCompletedRunKey: unknown = options?.lease?.lastCompletedRunKey;
  let fencingToken: unknown = options?.lease ? 'existing-fence' : undefined;
  let latestRun: Row | null = options?.latestRun ?? null;
  let benchmarkSnapshot: Row | null = options?.benchmarkSnapshot ?? null;
  const prepare = vi.fn((query: string) => {
    const bindings: unknown[] = [];
    const statement = {
      bind: vi.fn((...values: unknown[]) => {
        bindings.push(...values);
        return statement;
      }),
      first: vi.fn(async () => {
        if (query.includes('COUNT(*)')) {
          return { count: 0 };
        }
        if (query.includes('SELECT run_key, lease_until')) {
          return lastIngestionRunKey === undefined
            ? null
            : {
                run_key: lastIngestionRunKey,
                lease_until:
                  ingestionLeaseUntil ??
                  (ingestionLeaseHeld ? '9999-12-31T23:59:59.999Z' : '2000-01-01T00:00:00.000Z'),
                last_completed_run_key: lastCompletedRunKey,
              };
        }
        if (query.includes('FROM ingestion_runs')) {
          return latestRun;
        }
        if (query.includes('FROM benchmark_snapshots')) {
          return benchmarkSnapshot;
        }
        return null;
      }),
      all: vi.fn(async (): Promise<{ results: Row[] }> => {
        if (options?.failAllWith) throw options.failAllWith;
        if (query.includes('FROM news_items')) {
          return { results: options?.newsRows ?? [] };
        }
        return { results: [] };
      }),
      run: vi.fn(async () => {
        if (
          options?.failOnceQuery &&
          !failedConfiguredQuery &&
          query.includes(options.failOnceQuery.includes)
        ) {
          failedConfiguredQuery = true;
          throw options.failOnceQuery.error;
        }
        if (query.includes('INSERT INTO ingestion_leases')) {
          const acquiredAt = String(bindings[2]);
          const hasCompletionIdentity = query.includes('last_completed_run_key');
          const leaseIsActive =
            ingestionLeaseHeld &&
            ingestionLeaseUntil !== undefined &&
            ingestionLeaseUntil > acquiredAt;
          const completedSameRun = hasCompletionIdentity && lastCompletedRunKey === bindings[0];
          const legacySameRunBlock = !hasCompletionIdentity && lastIngestionRunKey === bindings[0];
          if (leaseIsActive || completedSameRun || legacySameRunBlock) {
            return { meta: { changes: 0 } };
          }
          ingestionLeaseHeld = true;
          lastIngestionRunKey = bindings[0];
          fencingToken = bindings[1];
          ingestionLeaseUntil = String(bindings[3]);
          return { meta: { changes: 1 } };
        }
        if (query.includes('UPDATE ingestion_leases') && query.includes('last_status')) {
          if (options?.failReleaseWith) throw options.failReleaseWith;
          const suppliedFence = bindings.at(-1);
          if (query.includes('fencing_token') && suppliedFence !== fencingToken) {
            return { meta: { changes: 0 } };
          }
          ingestionLeaseHeld = false;
          ingestionLeaseUntil = String(bindings[0]);
          if (query.includes('last_completed_run_key')) {
            lastCompletedRunKey = bindings[3];
          }
          return { meta: { changes: 1 } };
        }
        if (query.includes('INSERT INTO ingestion_runs')) {
          latestRun = query.includes("'failed'")
            ? {
                started_at: bindings[0],
                completed_at: bindings[1],
                status: 'failed',
                fetched_count: 0,
                stored_count: 0,
                error_json: bindings[2],
              }
            : {
                started_at: bindings[0],
                completed_at: bindings[1],
                status: bindings[2],
                fetched_count: bindings[3],
                stored_count: bindings[4],
                error_json: bindings[5],
              };
          return { meta: { changes: 1 } };
        }
        if (query.includes('INSERT INTO benchmark_snapshots')) {
          benchmarkSnapshot = {
            source_name: bindings[0],
            source_url: bindings[1],
            benchmark_date: bindings[2],
            ingested_at: bindings[3],
            row_count: bindings[4],
            payload_json: bindings[5],
          };
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }),
    };
    return statement;
  });

  return {
    prepare,
    batch: vi.fn(async () => []),
  };
}

function scheduledExecution(
  workerEnv: ReturnType<typeof createDatabase>,
  scheduledTime: number,
  extraEnv: Record<string, unknown> = {},
) {
  let execution: Promise<unknown> | undefined;
  const context = {
    waitUntil(promise: Promise<unknown>) {
      execution = promise;
    },
  };

  void worker.scheduled(
    { scheduledTime } as ScheduledController,
    { DB: workerEnv, ...extraEnv } as never,
    context as ExecutionContext,
  );

  if (!execution) throw new Error('scheduled handler did not register background work');
  return execution;
}

describe('AI News public request boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not trigger feed ingestion when a public news read finds an empty database', async () => {
    const upstreamFetch = vi.fn();
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    const response = await worker.fetch(
      new Request('https://news.example/api/news'),
      { DB } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ count: 0, items: [] });
    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(DB.prepare.mock.calls.some(([query]) => String(query).includes('ingestion_runs'))).toBe(
      true,
    );
  });

  it('does not expose internal exception text in a public failure response', async () => {
    const sentinel = 'private upstream credential context';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const DB = createDatabase({ failAllWith: new Error(sentinel) });

    const response = await worker.fetch(
      new Request('https://news.example/api/news'),
      { DB } as never,
      {} as never,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain('News service failed');
    expect(body).not.toContain(sentinel);
    expect(body).not.toContain('detail');
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sentinel);
  });

  it('reports a failed hourly refresh without presenting retained items as fresh', async () => {
    const DB = createDatabase({
      latestRun: {
        completed_at: '2026-08-09T08:07:30.000Z',
        status: 'failed',
        fetched_count: 0,
        stored_count: 0,
      },
    });

    const response = await worker.fetch(
      new Request('https://news.example/api/news'),
      { DB } as never,
      {} as never,
    );

    expect(await response.json()).toMatchObject({
      freshness: {
        state: 'failed',
        warning: 'The latest hourly refresh failed. Showing the last retained data.',
      },
    });
  });

  it('sanitizes retained HTML summaries at the public response boundary', async () => {
    const DB = createDatabase({
      newsRows: [
        {
          id: 7,
          source_platform: 'official',
          source_name: 'Example AI',
          source_url: 'https://example.com/release',
          raw_title: 'Example release',
          ai_headline: 'Example release',
          ai_summary:
            '<img src="https://example.com/tracker.png"><h2>Release</h2><p>Model <strong>details</strong> &amp; availability.</p>',
          company: 'Example AI',
          model_names: '["Example"]',
          category: 'model-release',
          verification_status: 'official',
          importance_score: 90,
          published_at: '2026-08-10T18:00:00.000Z',
          collected_at: '2026-08-10T18:07:00.000Z',
        },
      ],
    });

    const response = await worker.fetch(
      new Request('https://news.example/api/news'),
      { DB } as never,
      {} as never,
    );

    expect(await response.json()).toMatchObject({
      items: [{ summary: 'Release Model details & availability.' }],
    });
  });

  it('serves only a retained structured Arena snapshot from the benchmark endpoint', async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
      model: `verified-model-${index + 1}`,
      vendor: 'Example AI',
      license: 'proprietary',
      score: 1500 - index,
      ci: 4,
      votes: 100 + index,
    }));
    const DB = createDatabase({
      benchmarkSnapshot: {
        source_name: 'Arena',
        source_url: 'https://arena.example/leaderboard',
        benchmark_date: '2026-08-10T18:00:00.000Z',
        ingested_at: '2026-08-10T18:07:00.000Z',
        row_count: rows.length,
        payload_json: JSON.stringify(rows),
      },
    });

    const response = await worker.fetch(
      new Request('https://news.example/api/benchmarks'),
      { DB } as never,
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: {
        kind: 'independent-preference',
        name: 'Arena',
        url: 'https://arena.example/leaderboard',
      },
      benchmarkDate: '2026-08-10T18:00:00.000Z',
      ingestedAt: '2026-08-10T18:07:00.000Z',
      rows,
    });
  });
});

describe('AI News hourly ingestion boundary', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows only one active ingestion for the same hourly tick', async () => {
    const upstreamFetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();
    const scheduledTime = Date.parse('2026-08-09T07:07:00.000Z');

    await Promise.all([
      scheduledExecution(DB, scheduledTime),
      scheduledExecution(DB, scheduledTime),
    ]);

    expect(upstreamFetch).toHaveBeenCalledTimes(8);
  });

  it('does not repeat a completed ingestion when the hourly event is redelivered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const upstreamFetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();
    const scheduledTime = Date.parse('2026-08-09T07:07:00.000Z');

    await scheduledExecution(DB, scheduledTime);
    await scheduledExecution(DB, scheduledTime);

    expect(upstreamFetch).toHaveBeenCalledTimes(8);
    expect(log.mock.calls.flat()).toContain(
      '{"event":"free_news_ingestion_skipped","reason":"duplicate_run"}',
    );
  });

  it('stores a validated Arena snapshot during the hourly run', async () => {
    const benchmarkUrl = 'https://arena.example/leaderboard.json';
    const rows = Array.from({ length: 20 }, (_, index) => ({
      rank: index + 1,
      model: `hourly-model-${index + 1}`,
      vendor: 'Example AI',
      license: index === 19 ? 'open' : 'proprietary',
      score: 1500 - index,
      ci: 4,
      votes: 500 + index,
    }));
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === benchmarkUrl
        ? new Response(
            JSON.stringify({
              meta: {
                source_url: 'https://arena.example/leaderboard',
                fetched_at: '2026-08-10T19:00:00.000Z',
              },
              models: rows,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : new Response('<rss></rss>', { status: 200 }),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    await scheduledExecution(DB, Date.parse('2026-08-10T19:07:00.000Z'), {
      BENCHMARK_SOURCE_URL: benchmarkUrl,
    });

    const response = await worker.fetch(
      new Request('https://news.example/api/benchmarks'),
      { DB } as never,
      {} as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      benchmarkDate: '2026-08-10T19:00:00.000Z',
      rows,
    });
  });

  it('rejects a chunked benchmark response above two megabytes before parsing it', async () => {
    const benchmarkUrl = 'https://arena.example/oversized.json';
    let cancelledBodies = 0;
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== benchmarkUrl) {
        return new Response('<rss></rss>', { status: 200 });
      }
      const chunks = [
        new TextEncoder().encode('['),
        new Uint8Array(1_000_000),
        new Uint8Array(1_000_000),
      ];
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks.shift();
              if (!chunk) {
                controller.close();
                return;
              }
              controller.enqueue(chunk);
            },
            cancel() {
              cancelledBodies += 1;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    await scheduledExecution(DB, Date.parse('2026-08-10T20:07:00.000Z'), {
      BENCHMARK_SOURCE_URL: benchmarkUrl,
    });

    const health = await worker.fetch(new Request('https://news.example/health'), {
      DB,
    } as never);
    expect(await health.json()).toMatchObject({
      latestRun: {
        status: 'failed',
        error_json: expect.stringContaining('Feed is larger than 2 MB'),
      },
    });
    expect(cancelledBodies).toBe(1);
  });

  it('reacquires an expired incomplete lease for the same hourly run after a crash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-09T07:30:00.000Z');
    const upstreamFetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const scheduledAt = '2026-08-09T07:07:00.000Z';
    const DB = createDatabase({
      lease: {
        runKey: `hourly:${scheduledAt}`,
        leaseUntil: '2026-08-09T07:22:00.000Z',
      },
    });

    await scheduledExecution(DB, Date.parse(scheduledAt));

    expect(upstreamFetch).toHaveBeenCalledTimes(8);
  });

  it('uses a unique fencing token so an expired holder cannot finalize a recovered lease', async () => {
    const upstreamFetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    await scheduledExecution(DB, Date.parse('2026-08-09T07:07:00.000Z'));
    await scheduledExecution(DB, Date.parse('2026-08-09T08:07:00.000Z'));

    const acquisitionIndexes = DB.prepare.mock.calls
      .map(([query], index) => ({ query: String(query), index }))
      .filter(({ query }) => query.includes('INSERT INTO ingestion_leases'));
    const finalizationIndexes = DB.prepare.mock.calls
      .map(([query], index) => ({ query: String(query), index }))
      .filter(
        ({ query }) =>
          query.includes('UPDATE ingestion_leases') && query.includes('last_completed_run_key'),
      );
    const acquisitionTokens = acquisitionIndexes.map(
      ({ index }) => DB.prepare.mock.results[index].value.bind.mock.calls[0][1],
    );
    const finalizationTokens = finalizationIndexes.map(({ index }) =>
      DB.prepare.mock.results[index].value.bind.mock.calls[0].at(-1),
    );

    expect(acquisitionIndexes).toHaveLength(2);
    expect(acquisitionIndexes.every(({ query }) => query.includes('fencing_token'))).toBe(true);
    expect(new Set(acquisitionTokens).size).toBe(2);
    expect(finalizationIndexes).toHaveLength(2);
    expect(
      finalizationIndexes.every(({ query }) =>
        /WHERE lock_key = 'hourly' AND run_key = \? AND fencing_token = \?/u.test(query),
      ),
    ).toBe(true);
    expect(finalizationTokens).toEqual(acquisitionTokens);
  });

  it('persists bounded failure freshness without masking the original ingestion error', async () => {
    const privateDetail = 'private ingestion storage detail';
    const original = new Error(privateDetail);
    const releaseFailure = new Error('secondary lease release failure');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const upstreamFetch = vi.fn(async () => new Response('<rss></rss>', { status: 200 }));
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase({
      latestRun: {
        completed_at: '2026-08-09T06:07:30.000Z',
        status: 'success',
        fetched_count: 5,
        stored_count: 2,
      },
      failOnceQuery: {
        includes: 'DELETE FROM news_items',
        error: original,
      },
      failReleaseWith: releaseFailure,
    });

    await expect(scheduledExecution(DB, Date.parse('2026-08-09T07:07:00.000Z'))).rejects.toBe(
      original,
    );

    const response = await worker.fetch(new Request('https://news.example/api/news'), {
      DB,
    } as never);
    expect(await response.json()).toMatchObject({
      latestRun: {
        status: 'failed',
        fetched_count: 0,
        stored_count: 0,
        error_json: '[{"source":"scheduler","message":"Unexpected ingestion failure"}]',
      },
      freshness: {
        state: 'failed',
      },
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateDetail);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(releaseFailure.message);
  });

  it('retries a transient source failure with bounded backoff before recording success', async () => {
    vi.useFakeTimers();
    const attemptsByUrl = new Map<string, number>();
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const attempts = (attemptsByUrl.get(url) ?? 0) + 1;
      attemptsByUrl.set(url, attempts);
      if (attempts === 1) throw new TypeError('temporary network failure');
      return new Response('<rss></rss>', { status: 200 });
    });
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    const execution = scheduledExecution(DB, Date.parse('2026-08-09T08:07:00.000Z'));
    await vi.runAllTimersAsync();
    await execution;

    expect([...attemptsByUrl.values()]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);

    const health = await worker.fetch(
      new Request('https://news.example/health'),
      { DB } as never,
      {} as never,
    );
    expect(await health.json()).toMatchObject({
      latestRun: {
        status: 'success',
      },
    });
  });

  it('times out stalled sources and records only a bounded failure reason', async () => {
    vi.useFakeTimers();
    const privateDetail = 'https://private.example/feed?credential=secret';
    const upstreamFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!init?.signal) throw new TypeError(privateDetail);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException(privateDetail, 'AbortError')),
            {
              once: true,
            },
          );
        });
      },
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    const execution = scheduledExecution(DB, Date.parse('2026-08-09T09:07:00.000Z'));
    await vi.runAllTimersAsync();
    await execution;

    expect(upstreamFetch).toHaveBeenCalledTimes(24);
    const health = await worker.fetch(
      new Request('https://news.example/health'),
      { DB } as never,
      {} as never,
    );
    const body = await health.json();
    expect(body).toMatchObject({
      latestRun: {
        status: 'failed',
        error_json: expect.stringContaining('Source timed out'),
      },
    });
    expect(JSON.stringify(body)).not.toContain(privateDetail);
  });

  it('keeps the source timeout active when headers arrive but the body stalls', async () => {
    vi.useFakeTimers();
    const privateDetail = 'private stalled body credential context';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let cancelledBodies = 0;
    const upstreamFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              cancelledBodies += 1;
              throw new Error(privateDetail);
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    const execution = scheduledExecution(DB, Date.parse('2026-08-09T10:07:00.000Z'));
    await vi.runAllTimersAsync();
    let settled = false;
    void execution.finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(true);
    await execution;
    expect(upstreamFetch).toHaveBeenCalledTimes(24);
    expect(cancelledBodies).toBe(24);

    const health = await worker.fetch(new Request('https://news.example/health'), {
      DB,
    } as never);
    const body = await health.json();
    expect(body).toMatchObject({
      latestRun: {
        status: 'failed',
        error_json: expect.stringContaining('Source timed out'),
      },
    });
    expect(JSON.stringify(body)).not.toContain(privateDetail);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateDetail);
  });

  it('rejects chunked feeds above two megabytes without retrying or retaining the excess', async () => {
    let cancelledBodies = 0;
    let chunksRead = 0;
    const upstreamFetch = vi.fn(async () => {
      const chunks = [new Uint8Array(1_000_000), new Uint8Array(1_000_000), new Uint8Array(1)];
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              const chunk = chunks.shift();
              if (!chunk) {
                controller.close();
                return;
              }
              chunksRead += 1;
              controller.enqueue(chunk);
            },
            cancel() {
              cancelledBodies += 1;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', upstreamFetch);
    const DB = createDatabase();

    await scheduledExecution(DB, Date.parse('2026-08-09T11:07:00.000Z'));

    expect(upstreamFetch).toHaveBeenCalledTimes(8);
    expect(cancelledBodies).toBe(8);
    expect(chunksRead).toBeLessThanOrEqual(24);
    const health = await worker.fetch(new Request('https://news.example/health'), {
      DB,
    } as never);
    expect(await health.json()).toMatchObject({
      latestRun: {
        status: 'failed',
        error_json: expect.stringContaining('Feed is larger than 2 MB'),
      },
    });
  });
});
