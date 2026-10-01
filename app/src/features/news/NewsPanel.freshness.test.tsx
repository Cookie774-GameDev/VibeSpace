import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const newsApi = vi.hoisted(() => ({
  fetchLiveNews: vi.fn(),
}));

vi.mock('./newsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./newsApi')>()),
  configuredNewsApiUrl: () => 'https://news.example',
  fetchLiveNews: newsApi.fetchLiveNews,
}));

import { NewsPanel } from './NewsPanel';

describe('NewsPanel freshness truth', () => {
  beforeEach(() => {
    newsApi.fetchLiveNews.mockReset();
    newsApi.fetchLiveNews.mockResolvedValue({
      freeOnly: true,
      generatedAt: '2026-08-09T08:08:00.000Z',
      lastCompletedAt: '2026-08-09T08:07:30.000Z',
      freshness: {
        state: 'failed',
        ageMs: 30_000,
        warning: 'The latest hourly refresh failed. Showing the last retained data.',
      },
      items: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a retained-data warning when the latest hourly ingestion failed', async () => {
    render(
      <NewsPanel open onOpenChange={() => undefined} now={new Date('2026-08-09T08:08:00.000Z')} />,
    );

    expect(
      await screen.findByText('The latest hourly refresh failed. Showing the last retained data.'),
    ).toBeTruthy();
  });

  it('refreshes an open panel every hour without requiring a reopen', async () => {
    vi.useFakeTimers();
    render(<NewsPanel open onOpenChange={() => undefined} />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(newsApi.fetchLiveNews).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      await Promise.resolve();
    });
    expect(newsApi.fetchLiveNews).toHaveBeenCalledTimes(2);
  });
});
