import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDeepgramProjectUsage, parseDeepgramUsageBreakdown } from './usage';

describe('Deepgram project usage parsing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sums listen hours and requests while excluding TTS and agent rows', () => {
    expect(
      parseDeepgramUsageBreakdown({
        start: '2026-08-01',
        end: '2026-08-02',
        results: [
          { hours: 1.25, requests: 4, grouping: { endpoint: 'listen' } },
          { hours: 0.5, requests: 2, grouping: { endpoint: 'listen' } },
          { hours: 9, requests: 9, grouping: { endpoint: 'speak' } },
        ],
      }),
    ).toEqual({
      start: '2026-08-01',
      end: '2026-08-02',
      sttHours: 1.75,
      sttRequests: 6,
    });
  });

  it('rejects malformed provider values instead of fabricating zero usage', () => {
    expect(
      parseDeepgramUsageBreakdown({
        start: '2026-08-01',
        end: '2026-08-02',
        results: [{ hours: 'not-a-number', requests: 1, grouping: { endpoint: 'listen' } }],
      }),
    ).toBeNull();
  });

  it('requests only the official 30-day listen breakdown and rejects unavailable usage', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            start: '2026-07-03',
            end: '2026-08-02',
            results: [{ hours: 2.5, requests: 9, grouping: { endpoint: 'listen' } }],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetcher);

    await expect(
      fetchDeepgramProjectUsage('private-test-key', 'project/id', new Date('2026-08-02T12:00:00Z')),
    ).resolves.toMatchObject({ sttHours: 2.5, sttRequests: 9 });

    const [requestedUrl, requestInit] = fetcher.mock.calls[0]!;
    const url = new URL(String(requestedUrl));
    expect(url.pathname).toBe('/v1/projects/project%2Fid/usage/breakdown');
    expect(url.searchParams.get('start')).toBe('2026-07-03');
    expect(url.searchParams.get('end')).toBe('2026-08-02');
    expect(url.searchParams.get('grouping')).toBe('endpoint');
    expect(url.searchParams.get('endpoint')).toBe('listen');
    expect(requestInit).toEqual({
      headers: { Authorization: 'Token private-test-key' },
    });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(
      fetchDeepgramProjectUsage('invalid', 'project', new Date('2026-08-02T12:00:00Z')),
    ).rejects.toThrow('deepgram_usage_403');
  });
});
