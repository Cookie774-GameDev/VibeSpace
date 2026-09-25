import { describe, expect, it, vi } from 'vitest';
import { fetchLiveNews, parseNewsResponse } from './newsApi';

const baseItem = {
  id: 42,
  title: 'A current official model launch',
  summary: 'Source-provided launch details.',
  url: 'https://example.com/launch',
  source: { name: 'Example AI', platform: 'official' },
  verification: 'official',
  category: 'model-release',
  company: 'Example AI',
  modelNames: ['Example-2'],
  publishedAt: '2026-08-14T18:42:11-05:00',
};

function responsePayload(item: Record<string, unknown> = baseItem) {
  return {
    freeOnly: true,
    generatedAt: '2026-08-14T23:43:00Z',
    latestRun: { completed_at: '2026-08-14T23:42:30Z' },
    freshness: { state: 'fresh', ageMs: 30000 },
    items: [item],
  };
}

describe('live AI news API adapter', () => {
  it('keeps general AI updates out of model drops while retaining real launches', () => {
    const items = [
      {
        ...baseItem,
        id: 1,
        title: 'Meta announces two new AI game creation tools',
        modelNames: [],
      },
      { ...baseItem, id: 2, title: 'Introducing NV-Reason-CT Open 3D CT VLM', modelNames: [] },
      {
        ...baseItem,
        id: 3,
        title: 'DeepMind wants Gemini 4 out the door soon',
        modelNames: ['Gemini 4'],
      },
    ];
    const parsed = parseNewsResponse({ ...responsePayload(), items });
    expect(parsed.items.map((item) => item.kind)).toEqual(['ai_news', 'model_drop', 'ai_news']);
  });

  it('parses repository metadata into a separate measured GitHub trend section', () => {
    const parsed = parseNewsResponse({
      ...responsePayload(),
      repositories: [
        {
          id: 'ollama',
          fullName: 'ollama/ollama',
          url: 'https://github.com/ollama/ollama',
          description: 'Run open models locally.',
          stars: 150000,
          starDelta: 42,
          forks: 12000,
          openIssues: 1000,
          language: 'Go',
          pushedAt: '2026-08-14T18:40:00Z',
          observedAt: '2026-08-14T18:45:00Z',
        },
      ],
    });
    expect(parsed.repositories?.[0]).toMatchObject({
      kind: 'github',
      title: 'ollama/ollama',
      repository: { stars: 150000, starDelta: 42, trendSignal: '+42 stars since last check' },
    });
  });

  it('preserves full publication time and consumes real image metadata', () => {
    const parsed = parseNewsResponse(
      responsePayload({
        ...baseItem,
        imageUrl: 'https://cdn.example.com/launch.webp',
        imageCredit: 'Example AI newsroom',
        mediaType: 'image',
        mediaSource: 'rss-media',
      }),
    );

    expect(parsed.items[0]).toMatchObject({
      publishedAt: '2026-08-14T23:42:11.000Z',
      imageUrl: 'https://cdn.example.com/launch.webp',
      imageCredit: 'Example AI newsroom',
      mediaType: 'image',
      mediaSource: 'rss-media',
    });
    expect(parsed.lastCompletedAt).toBe('2026-08-14T23:42:30.000Z');
  });

  it('renders official video metadata with a legitimate YouTube thumbnail', () => {
    const parsed = parseNewsResponse(
      responsePayload({
        ...baseItem,
        url: 'https://www.youtube.com/watch?v=abc123XYZ',
        videoUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
        mediaType: 'video',
      }),
    );

    expect(parsed.items[0]).toMatchObject({
      kind: 'youtube',
      youtubeId: 'abc123XYZ',
      videoUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
      imageUrl: 'https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg',
      mediaType: 'video',
    });
  });

  it('drops unsafe image URLs so the UI uses its explicit fallback', () => {
    const parsed = parseNewsResponse(
      responsePayload({ ...baseItem, imageUrl: 'javascript:alert(1)', mediaType: 'image' }),
    );
    expect(parsed.items[0]?.imageUrl).toBe('');
    expect(parsed.items[0]?.mediaType).toBe('image');
  });

  it('rejects a backend that truncates publication timestamps to a date', () => {
    expect(() =>
      parseNewsResponse(responsePayload({ ...baseItem, publishedAt: '2026-08-14' })),
    ).toThrow(/discarded publication time precision/i);
  });

  it('rejects data that is not from the declared free-only path', () => {
    expect(() => parseNewsResponse({ ...responsePayload(), freeOnly: false })).toThrow(
      /free-only data path/i,
    );
  });

  it('keeps freshness truth from the backend', () => {
    const parsed = parseNewsResponse({
      ...responsePayload(),
      freshness: { state: 'degraded', ageMs: 120000, warning: 'Two sources failed.' },
    });
    expect(parsed.freshness).toEqual({
      state: 'degraded',
      ageMs: 120000,
      warning: 'Two sources failed.',
    });
  });

  it('accepts numeric D1 identifiers from the production Worker', () => {
    const parsed = parseNewsResponse(responsePayload({ ...baseItem, id: 42 }));
    expect(parsed.items[0]?.id).toBe('42');
  });

  it('strips retained feed markup before rendering a summary', () => {
    const parsed = parseNewsResponse(
      responsePayload({
        ...baseItem,
        summary:
          '<img src="https://example.com/tracker.png"><h2>Release</h2><p>Model <strong>details</strong> &amp; availability.</p>',
      }),
    );
    expect(parsed.items[0]?.summary).toBe('Release Model details & availability.');
    expect(parsed.items[0]?.summary).not.toMatch(/<[^>]+>/u);
  });

  it('uses the configured origin and bounded request path', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify(responsePayload()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const parsed = await fetchLiveNews('https://news.example', { fetcher, timeoutMs: 1000 });
    expect(parsed.items).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://news.example/api/news?limit=100');
  });

  it('reports a public-news transport failure without claiming the user is offline', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      fetchLiveNews('https://news.example', { fetcher, timeoutMs: 1000 }),
    ).rejects.toThrow(/could not reach https:\/\/news\.example/i);
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://news.example/api/news?limit=100'),
      expect.objectContaining({ credentials: 'omit', mode: 'cors' }),
    );
  });
});
