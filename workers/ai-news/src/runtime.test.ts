import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './intelligence';
import {
  PipelineError,
  acquirePipelineLease,
  boundedFetch,
  runKeyFor,
  type Env,
} from './runtime';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bounded Worker runtime', () => {
  it('rejects oversized responses before unbounded parsing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('large', {
          status: 200,
          headers: { 'content-length': '5000000', 'content-type': 'text/xml' },
        }),
      ),
    );
    await expect(
      boundedFetch('https://example.com/feed.xml', { maxBytes: 1000, retries: 0 }),
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });

  it('enforces the HTTPS redirect bound', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        new Response(null, {
          status: 302,
          headers: { location: `${String(input)}/again` },
        }),
      ),
    );
    await expect(
      boundedFetch('https://example.com/feed.xml', { maxRedirects: 1, retries: 0 }),
    ).rejects.toMatchObject({ code: 'SOURCE_REDIRECT_LIMIT' });
  });

  it('times out a stalled source request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    await expect(
      boundedFetch('https://example.com/feed.xml', { timeoutMs: 5, retries: 0 }),
    ).rejects.toBeInstanceOf(DOMException);
  });

  it('uses the same idempotency key for duplicate delivery in one clock hour', () => {
    expect(runKeyFor('news-hourly', '2026-08-14T23:07:00Z')).toBe(
      runKeyFor('news-hourly', '2026-08-14T23:59:59Z'),
    );
    expect(runKeyFor('news-hourly', '2026-08-14T23:07:00Z')).not.toBe(
      runKeyFor('benchmarks-hourly', '2026-08-14T23:07:00Z'),
    );
  });

  it('rejects duplicate lease acquisition when D1 reports no fenced write', async () => {
    let first = true;
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => {
            const changes = first ? 1 : 0;
            first = false;
            return { meta: { changes } };
          }),
        })),
      })),
    } as unknown as D1Database;
    const acquiredAt = '2026-08-14T23:07:00Z';
    const firstLease = await acquirePipelineLease(db, 'news-hourly', 'news-hourly:2026-08-14T23', acquiredAt);
    const duplicate = await acquirePipelineLease(db, 'news-hourly', 'news-hourly:2026-08-14T23', acquiredAt);
    expect(firstLease?.fencingToken).toBeTruthy();
    expect(duplicate).toBeNull();
  });

  it('registers one scheduled promise that isolates the two pipelines', async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
        })),
      })),
    } as unknown as D1Database;
    let scheduledPromise: Promise<unknown> | null = null;
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        scheduledPromise = promise;
      }),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;
    const scheduled = worker.scheduled;
    if (!scheduled) throw new Error('Worker scheduled handler is missing.');
    await scheduled(
      { scheduledTime: Date.parse('2026-08-14T23:07:00Z'), cron: '7 * * * *', noRetry: () => {} },
      { DB: db } as Env,
      ctx,
    );
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await scheduledPromise;
  });
});
