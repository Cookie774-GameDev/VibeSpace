import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativeFetch', () => ({ nativeFetch: vi.fn() }));

import { nativeFetch } from '@/lib/nativeFetch';
import type { BenchmarkRow } from './benchmarkData';
import {
  clearNewsBenchmarkCache,
  discoverNewsBenchmarkPair,
  pickLatestModelRelease,
  selectNewsBenchmarkPair,
  type NewsModelRelease,
} from './newsModelDiscovery';

const mockedFetch = vi.mocked(nativeFetch);

function row(model: string, provider: string, score: number): BenchmarkRow {
  return {
    model,
    provider,
    arena_score: score,
    ci_low: score - 2,
    ci_high: score + 2,
    open_source: false,
    source: 'snapshot',
    fetched_at: Date.parse('2026-08-01T00:00:00Z'),
  };
}

function release(modelName: string, company = 'OpenAI'): NewsModelRelease {
  return {
    modelName,
    company,
    title: `${modelName} announced`,
    summary: '',
    url: 'https://example.com/release',
    sourceName: 'Official News',
    sourcePlatform: 'official',
    verification: 'official',
    importance: 95,
    publishedAt: Date.parse('2026-08-05T12:00:00Z'),
  };
}

const rows = [
  row('GPT-5.6', 'openai', 151),
  row('GPT-5.5', 'openai', 147),
  row('Claude Opus 4.5', 'anthropic', 149),
];

describe('news model benchmark discovery', () => {
  beforeEach(() => {
    clearNewsBenchmarkCache();
    mockedFetch.mockReset();
  });
  it('uses only verified model-release news and places the newest release first', () => {
    const selected = pickLatestModelRelease([
      {
        title: 'Rumored GPT-7',
        url: 'https://example.com/rumor',
        category: 'model-release',
        verification: 'unverified',
        modelNames: ['GPT-7'],
        publishedAt: '2026-08-05T15:00:00Z',
      },
      {
        title: 'Research about Claude 5',
        url: 'https://example.com/research',
        category: 'research',
        verification: 'official',
        modelNames: ['Claude 5'],
        publishedAt: '2026-08-05T14:00:00Z',
      },
      {
        title: 'Claude 5 is here',
        url: 'https://example.com/claude-5',
        category: 'model-release',
        verification: 'official',
        company: 'Anthropic',
        source: { platform: 'official', name: 'Anthropic News' },
        modelNames: ['Claude 5 is here'],
        importance: 98,
        publishedAt: '2026-08-05T13:00:00Z',
      },
    ]);

    expect(selected?.modelName).toBe('Claude 5');
    expect(selected?.verification).toBe('official');
  });

  it('chooses the same canonical model name regardless of feed ordering', () => {
    const base = {
      title: 'Two models announced',
      url: 'https://example.com/models',
      category: 'model-release',
      verification: 'official',
      publishedAt: '2026-08-05T13:00:00Z',
    };

    const left = pickLatestModelRelease([{ ...base, modelNames: ['GPT-5.7', 'GPT-5.6'] }]);
    const right = pickLatestModelRelease([{ ...base, modelNames: ['GPT-5.6', 'GPT-5.7'] }]);

    expect(left?.modelName).toBe('GPT-5.6');
    expect(right?.modelName).toBe('GPT-5.6');
  });

  it('puts an exact leaderboard match in position one and a same-family model second', () => {
    const pair = selectNewsBenchmarkPair(release('GPT-5.6'), rows, 123);

    expect(pair.primary.position).toBe(1);
    expect(pair.primary.modelName).toBe('GPT-5.6');
    expect(pair.primary.row?.arena_score).toBe(151);
    expect(pair.primary.status).toBe('leaderboard-match');
    expect(pair.secondary?.position).toBe(2);
    expect(pair.secondary?.modelName).toBe('GPT-5.5');
    expect(pair.comparisonReason).toBe('same-family');
  });

  it('keeps a newly announced model score pending and never borrows another score', () => {
    const pair = selectNewsBenchmarkPair(release('GPT-6'), rows);

    expect(pair.primary.position).toBe(1);
    expect(pair.primary.row).toBeNull();
    expect(pair.primary.status).toBe('benchmark-pending');
    expect(pair.secondary?.modelName).toBe('GPT-5.6');
  });

  it('falls back to the actual leaderboard leader when no family or provider match exists', () => {
    const pair = selectNewsBenchmarkPair(release('Nova 1', 'Unknown Lab'), rows);

    expect(pair.primary.row).toBeNull();
    expect(pair.secondary?.modelName).toBe('GPT-5.6');
    expect(pair.comparisonReason).toBe('leaderboard-leader');
  });

  it('shares only the news fetch while selecting against each caller leaderboard', async () => {
    let releaseFetch: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    mockedFetch.mockImplementationOnce(async () => {
      await gate;
      return {
        ok: true,
        json: async () => ({
          freshness: { state: 'fresh' },
          items: [
            {
              title: 'GPT-6 announced',
              url: 'https://example.com/gpt-6',
              category: 'model-release',
              verification: 'official',
              company: 'OpenAI',
              modelNames: ['GPT-6'],
              publishedAt: '2026-08-05T13:00:00Z',
            },
          ],
        }),
      } as Response;
    });

    const withExactModel = [row('GPT-6', 'openai', 160), ...rows];
    const withoutExactModel = rows;
    const first = discoverNewsBenchmarkPair(withExactModel, {
      force: true,
      newsApiUrl: 'https://news.example',
    });
    const second = discoverNewsBenchmarkPair(withoutExactModel, {
      force: true,
      newsApiUrl: 'https://news.example',
    });
    releaseFetch?.();
    const [left, right] = await Promise.all([first, second]);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(left.status === 'ready' ? left.pair.primary.row?.model : null).toBe('GPT-6');
    expect(right.status === 'ready' ? right.pair.primary.row : 'not-ready').toBeNull();
  });
});
