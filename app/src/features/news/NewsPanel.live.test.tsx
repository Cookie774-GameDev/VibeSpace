import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchLiveNews: vi.fn() }));
const subscriptions = vi.hoisted(() => ({
  fetch: vi.fn(),
  set: vi.fn(),
  notifications: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock('./newsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./newsApi')>()),
  fetchLiveNews: api.fetchLiveNews,
  configuredNewsApiUrl: () => 'https://news.example',
}));
vi.mock('@/lib/tauri', () => ({ openExternal: vi.fn(async () => undefined) }));
vi.mock('./creatorSubscriptions', () => ({
  fetchCreatorSubscriptions: subscriptions.fetch,
  setCreatorSubscription: subscriptions.set,
  fetchCreatorNotifications: subscriptions.notifications,
  acknowledgeCreatorNotifications: subscriptions.acknowledge,
}));

import { NewsPanel } from './NewsPanel';
import { useAuthStore } from '@/stores/auth';

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
        sourceId: 'example-ai-news',
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
    subscriptions.fetch.mockReset().mockResolvedValue([]);
    subscriptions.set.mockReset().mockResolvedValue(undefined);
    subscriptions.notifications.mockReset().mockResolvedValue([]);
    subscriptions.acknowledge.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({ cloudSession: null });
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
    expect(container.querySelector('svg.lucide-radar')).toBeTruthy();
    expect(container.querySelector('svg.lucide-sparkles')).toBeNull();
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

  it('retains verified items when a completed hourly response is failed and empty', async () => {
    api.fetchLiveNews.mockResolvedValueOnce(liveResponse()).mockResolvedValueOnce(
      liveResponse({
        freshness: {
          state: 'failed',
          ageMs: 90_000,
          warning: 'The latest hourly run failed after all sources were attempted.',
        },
        items: [],
      }),
    );
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    expect(await screen.findByText('Official model launch')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh AI news' }));

    expect(await screen.findByText('Last verified feed while live news reconnects.')).toBeTruthy();
    expect(screen.getByText('Official model launch')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Today\s+1/i })).toBeTruthy();
  });

  it('merges partial-source results with last verified items without duplicating ids', async () => {
    const retained = {
      ...liveResponse().items[0]!,
      id: 'story-retained',
      title: 'Retained verified launch',
    };
    const current = {
      ...liveResponse().items[0]!,
      id: 'story-current',
      title: 'Current partial-source launch',
    };
    api.fetchLiveNews
      .mockResolvedValueOnce(liveResponse({ items: [retained] }))
      .mockResolvedValueOnce(
        liveResponse({
          freshness: {
            state: 'degraded',
            ageMs: 45_000,
            warning: 'One official source did not complete.',
          },
          items: [current],
        }),
      );
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    expect(await screen.findByText('Retained verified launch')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh AI news' }));

    expect(
      await screen.findByText('Partial-source feed with last verified items retained.'),
    ).toBeTruthy();
    expect(screen.getByText('Retained verified launch')).toBeTruthy();
    expect(screen.getByText('Current partial-source launch')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('classifies Today by the local calendar instead of a rolling 24-hour window', async () => {
    const afterMidnight = new Date(2026, 7, 14, 0, 30, 0);
    const lateYesterday = new Date(2026, 7, 13, 23, 45, 0).toISOString();
    api.fetchLiveNews.mockResolvedValueOnce(
      liveResponse({
        items: [
          {
            ...liveResponse().items[0],
            id: 'late-yesterday',
            title: 'Late yesterday launch',
            publishedAt: lateYesterday,
          },
        ],
      }),
    );
    render(<NewsPanel open onOpenChange={vi.fn()} now={afterMidnight} runtimeEffectsEnabled />);

    expect(await screen.findByRole('tab', { name: /Today\s+0/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Last week\s+1/i }));
    expect(screen.getByText('Late yesterday launch')).toBeTruthy();
  });

  it('describes a failed live request as a reconnecting service, not user offline status', async () => {
    api.fetchLiveNews.mockRejectedValueOnce(
      new Error('Live AI News could not reach https://news.example.'),
    );
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);

    expect(await screen.findByText(/could not reach https:\/\/news\.example/i)).toBeTruthy();
    expect(screen.getByText('Saved snapshot while live news reconnects.')).toBeTruthy();
  });

  it('renders repository trends in a separate GitHub section', async () => {
    api.fetchLiveNews.mockResolvedValue(
      liveResponse({
        repositories: [
          {
            id: 'repository:ollama',
            title: 'ollama/ollama',
            summary: 'Run open models locally.',
            url: 'https://github.com/ollama/ollama',
            publishedAt: todayTimestamp,
            source: 'GitHub',
            sourceId: 'repository:ollama',
            platform: 'github',
            verification: 'official',
            category: 'repository-trend',
            kind: 'github',
            imageUrl: '',
            imageCredit: '',
            credit: 'Repository metadata · GitHub API',
            mediaType: 'none',
            tags: ['GitHub'],
            repository: {
              stars: 150000,
              starDelta: 42,
              forks: 12000,
              openIssues: 1000,
              language: 'Go',
              pushedAt: todayTimestamp,
              trendSignal: '+42 stars since last check',
            },
          },
        ],
      }),
    );
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    fireEvent.click(await screen.findByRole('button', { name: 'GitHub' }));
    expect(screen.getByText('Trending GitHub repositories')).toBeTruthy();
    expect(screen.getByText('ollama/ollama')).toBeTruthy();
    expect(screen.getByText('+42 stars since last check')).toBeTruthy();
  });

  it('rolls an optimistic creator follow back when persistence fails', async () => {
    useAuthStore.setState({
      cloudSession: { user_id: 'account-a', email: 'a@example.com', expires_at: 1 },
    });
    subscriptions.set.mockRejectedValueOnce(new Error('save failed'));
    render(<NewsPanel open onOpenChange={vi.fn()} now={now} runtimeEffectsEnabled />);
    await waitFor(() => expect(subscriptions.fetch).toHaveBeenCalledTimes(1));
    const bell = await screen.findByRole('button', { name: 'Follow Example AI' });
    fireEvent.click(bell);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Follow Example AI' }).getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    expect(subscriptions.set).toHaveBeenCalledWith('https://news.example', 'example-ai-news', true);
    expect(await screen.findByText(/save failed/i)).toBeTruthy();
  });
});
