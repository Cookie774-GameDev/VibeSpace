import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLiveNews, parseNewsResponse } from './newsApi';

const validPayload = {
  freeOnly: true,
  lastCompletedAt: '2026-08-05T19:07:00.000Z',
  items: [
    {
      id: 'story-1',
      title: 'A verified model release',
      url: 'https://example.com/release',
      sourceName: 'Example AI',
      sourcePlatform: 'official',
      verification: 'official',
      company: 'Example',
      category: 'model-release',
      publishedAt: '2026-08-05T18:00:00.000Z',
      summary: 'Release details from the original source.',
    },
  ],
};

describe('AI News API client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('validates and maps the free Worker response', () => {
    const parsed = parseNewsResponse(validPayload);
    expect(parsed.items[0]).toMatchObject({
      id: 'story-1',
      source: 'Example AI',
      platform: 'official',
      verification: 'official',
      kind: 'model_drop',
    });
  });

  it('rejects malformed or non-free responses', () => {
    expect(() => parseNewsResponse({ ...validPayload, freeOnly: false })).toThrow('free-only');
    expect(() => parseNewsResponse({ ...validPayload, items: [{}] })).toThrow('malformed');
  });

  it('fetches with a bounded request and canonical limit', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(validPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await fetchLiveNews('https://news.example', {
      fetcher,
      timeoutMs: 500,
    });
    expect(result.items).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://news.example/api/news?limit=50');
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
