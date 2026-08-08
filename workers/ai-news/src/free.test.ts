import { afterEach, describe, expect, it, vi } from 'vitest';

import worker from './free';

type Row = Record<string, unknown>;

function createDatabase(options?: { failAllWith?: Error }) {
  const prepare = vi.fn((query: string) => {
    const statement = {
      bind: vi.fn(() => statement),
      first: vi.fn(async () => {
        if (query.includes('COUNT(*)')) {
          return { count: 0 };
        }
        return null;
      }),
      all: vi.fn(async (): Promise<{ results: Row[] }> => {
        if (options?.failAllWith) throw options.failAllWith;
        return { results: [] };
      }),
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
    };
    return statement;
  });

  return {
    prepare,
    batch: vi.fn(async () => []),
  };
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
});
