import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchLiveNews: vi.fn() }));
vi.mock('./newsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./newsApi')>()),
  fetchLiveNews: api.fetchLiveNews,
  configuredNewsApiUrl: () => 'https://news.example',
}));
vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));

import { NewsPanel } from './NewsPanel';

const now = new Date(2026, 7, 14, 19, 0, 0);
const todayTimestamp = new Date(2026, 7, 14, 18, 42, 11).toISOString();

function liveResponse(overrides: Record<string, unknown> = {}) {
  return {
    freeOnly: true as const,
    generatedAt: new Date(2026, 7, 14, 18, 43, 0).toISOString(),
    lastCompletedAt: new Date(2026, 7, 14, 18, 42, 30).toISOString(),
    freshness: { state: 'fresh' as const, ageMs: 30_000 },
    items: [
      {
        id: 'story-1',
        title: 'Official model launch',
        summary: 'A factual source-provided launch summary.',
        url: 'https://example.com/launch',
        publishedAt: todayTimestamp,
        source: 'Example AI',
        platform: 'official',
        verification: 'official' as const,
        company: 'Example AI',
        category: 'model-release',
        kind: 'model_drop' as const,
        imageUrl: 'https://cdn.example.com/launch.webp',
        imageCredit: 'Example AI newsroom',
        credit: 'Official source · Example AI',
        mediaType: 'image' as const,
        tags: ['official'],
      },
    ],
    ...overrides,
  };
}

describe('NewsPanel live cards', () => {
  beforeEach(() => {
    api.fetchLiveNews.mockReset();
    api.fetchLiveNews.mockResolvedValue(liveResponse());
  });

  it('renders a live image, full timestamp, and local Today count', async () => {
    const { container } = render(
      <NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />,
    );
    expect(await screen.findByText('Official model launch')).toBeTruthy();
    const image = container.querySelector('img[src="https://cdn.example.com/launch.webp"]');
    expect(image).toBeTruthy();
    expect(container.querySelector(`time[datetime="${todayTimestamp}"]`)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Today\s+1/i })).toBeTruthy();
  });

  it('switches to the explicit fallback when a remote image fails', async () => {
    const { container } = render(
      <NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />,
    );
    const image = await waitFor(() => {
      const element = container.querySelector('img[src="https://cdn.example.com/launch.webp"]');
      expect(element).toBeTruthy();
      return element as HTMLImageElement;
    });
    fireEvent.error(image);
    expect(container.querySelector('[data-news-media-fallback="true"]')).toBeTruthy();
  });

  it('renders a video play treatment for official video metadata', async () => {
    api.fetchLiveNews.mockResolvedValue(
      liveResponse({
        items: [
          {
            ...liveResponse().items[0],
            kind: 'youtube',
            mediaType: 'video',
            videoUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
            youtubeId: 'abc123XYZ',
          },
        ],
      }),
    );
    const { container } = render(
      <NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />,
    );
    await screen.findByText('Official model launch');
    expect(container.querySelector('[data-news-video-badge="true"]')).toBeTruthy();
  });

  it('shows backend freshness warnings without removing valid cards', async () => {
    api.fetchLiveNews.mockResolvedValue(
      liveResponse({
        freshness: {
          state: 'degraded',
          ageMs: 150_000,
          warning: 'Two official sources failed during the latest hourly run.',
        },
      }),
    );
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    expect(await screen.findByText('Official model launch')).toBeTruthy();
    expect(
      screen.getByText('Two official sources failed during the latest hourly run.'),
    ).toBeTruthy();
  });

  it('keeps the last-good live card after a later manual refresh fails', async () => {
    api.fetchLiveNews
      .mockResolvedValueOnce(liveResponse())
      .mockRejectedValueOnce(new Error('network unavailable'));
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    expect(await screen.findByText('Official model launch')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh AI news' }));
    expect(await screen.findByText(/Keeping the last live results/i)).toBeTruthy();
    expect(screen.getByText('Official model launch')).toBeTruthy();
  });
});
