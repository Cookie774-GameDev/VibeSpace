import { describe, expect, it } from 'vitest';
import type { NewsSourceDefinition } from './newsSources';
import {
  clusterNewsCandidates,
  parseOfficialFeed,
  parseOpenGraphMedia,
  parseXResponse,
  shouldClusterNews,
  titleSimilarity,
  type NewsCandidate,
} from './newsPipeline';

const feedSource: NewsSourceDefinition = {
  id: 'example-feed',
  company: 'Example AI',
  priority: 100,
  enabled: true,
  sourceType: 'rss',
  endpoint: 'https://example.com/feed.xml',
  officialSite: 'https://example.com/',
  verification: 'official',
  rotationGroup: 0,
};

function candidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    sourceId: 'example-feed',
    sourcePlatform: 'rss',
    company: 'Example AI',
    verification: 'official',
    externalId: 'launch-1',
    title: 'Example AI launches Model X with adaptive reasoning',
    summary: 'Example AI released Model X through its official source.',
    url: 'https://example.com/model-x',
    publishedAt: '2026-08-14T18:42:11Z',
    category: 'model-release',
    modelNames: ['Model X'],
    importanceScore: 95,
    mediaType: 'none',
    ...overrides,
  };
}

describe('official news parsing and clustering', () => {
  it('preserves full timestamps and RSS media metadata', () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel><item>
        <guid>launch-1</guid>
        <title><![CDATA[Example AI launches GPT-7 Preview]]></title>
        <link>https://example.com/gpt-7?utm_source=rss</link>
        <pubDate>Fri, 14 Aug 2026 18:42:11 GMT</pubDate>
        <description><![CDATA[Official API and model launch details.]]></description>
        <media:thumbnail url="https://cdn.example.com/gpt-7.webp" />
      </item></channel></rss>`;
    const parsed = parseOfficialFeed(feedSource, xml, '2026-08-14T18:45:00Z');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      publishedAt: '2026-08-14T18:42:11.000Z',
      url: 'https://example.com/gpt-7',
      imageUrl: 'https://cdn.example.com/gpt-7.webp',
      mediaType: 'image',
      mediaSource: 'rss-media',
    });
    expect(parsed[0]?.modelNames).toContain('GPT-7 Preview');
  });

  it('extracts official YouTube video thumbnails without downloading video', () => {
    const source: NewsSourceDefinition = {
      ...feedSource,
      id: 'example-youtube',
      sourceType: 'youtube_feed',
      endpoint: 'https://www.youtube.com/feeds/videos.xml?channel_id=official',
    };
    const xml = `<feed><entry>
      <id>yt:video:abc123XYZ</id>
      <yt:videoId>abc123XYZ</yt:videoId>
      <title>Example AI model launch video</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=abc123XYZ" />
      <published>2026-08-14T18:42:11Z</published>
      <summary>Official AI model launch.</summary>
    </entry></feed>`;
    const parsed = parseOfficialFeed(source, xml);
    expect(parsed[0]).toMatchObject({
      videoUrl: 'https://www.youtube.com/watch?v=abc123XYZ',
      imageUrl: 'https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg',
      mediaType: 'video',
      mediaSource: 'youtube-feed',
    });
  });

  it('rejects HTML error pages and malformed feeds', () => {
    expect(() => parseOfficialFeed(feedSource, '<html>upstream error</html>')).toThrow(
      /returned HTML/i,
    );
    expect(() => parseOfficialFeed(feedSource, '<rss><channel /></rss>')).toThrow(
      /no item or entry/i,
    );
  });

  it('parses X media only through the authenticated API response shape', () => {
    const source: NewsSourceDefinition = {
      ...feedSource,
      id: 'example-x',
      sourceType: 'x',
      endpoint: undefined,
      xHandle: 'ExampleAI',
    };
    const parsed = parseXResponse(source, {
      data: [
        {
          id: '123456',
          text: 'We are launching GPT-7 Preview today with a new API.',
          created_at: '2026-08-14T18:42:11Z',
          attachments: { media_keys: ['3_1'] },
        },
      ],
      includes: {
        media: [
          {
            media_key: '3_1',
            type: 'video',
            preview_image_url: 'https://pbs.twimg.com/media/preview.jpg',
          },
        ],
      },
    });
    expect(parsed[0]).toMatchObject({
      url: 'https://x.com/ExampleAI/status/123456',
      videoUrl: 'https://x.com/ExampleAI/status/123456',
      imageUrl: 'https://pbs.twimg.com/media/preview.jpg',
      mediaType: 'video',
      mediaSource: 'x-api',
      verification: 'official',
    });
  });

  it('clusters same-event official blog/X cross-posts but not unrelated stories', () => {
    const blog = candidate();
    const xPost = candidate({
      sourceId: 'example-x',
      sourcePlatform: 'x',
      externalId: 'x-1',
      title: 'Model X adaptive reasoning is now available',
      summary: 'Model X is available now.',
      url: 'https://x.com/ExampleAI/status/1',
      publishedAt: '2026-08-14T19:02:00Z',
    });
    const unrelated = candidate({
      externalId: 'pricing-1',
      title: 'Example AI changes enterprise API pricing',
      summary: 'A separate pricing update.',
      url: 'https://example.com/pricing-update',
      publishedAt: '2026-08-14T19:10:00Z',
      category: 'pricing-and-limits',
      modelNames: [],
    });
    expect(shouldClusterNews(blog, xPost)).toBe(true);
    expect(shouldClusterNews(blog, unrelated)).toBe(false);
    const clusters = clusterNewsCandidates([blog, xPost, unrelated]);
    expect(clusters).toHaveLength(2);
    expect(clusters.find((cluster) => cluster.sources.length === 2)?.primary.sourcePlatform).toBe(
      'rss',
    );
  });

  it('uses strict title/model overlap rather than company name alone', () => {
    expect(
      titleSimilarity(
        'Example AI launches Model X with adaptive reasoning',
        'Model X adaptive reasoning is now available',
      ),
    ).toBeGreaterThan(0.45);
    expect(
      titleSimilarity(
        'Example AI launches Model X with adaptive reasoning',
        'Example AI opens a new office in Paris',
      ),
    ).toBeLessThan(0.45);
  });

  it('extracts only HTTPS Open Graph image/video metadata', () => {
    const media = parseOpenGraphMedia(
      `<html><head>
        <meta property="og:image" content="/cover.webp" />
        <meta property="og:video:secure_url" content="https://video.example.com/watch/1" />
      </head></html>`,
      'https://example.com/story',
    );
    expect(media).toEqual({
      imageUrl: 'https://example.com/cover.webp',
      videoUrl: 'https://video.example.com/watch/1',
      mediaType: 'video',
      mediaSource: 'open-graph',
    });
    expect(
      parseOpenGraphMedia(
        '<meta property="og:image" content="javascript:alert(1)" />',
        'https://example.com/story',
      ),
    ).toEqual({ mediaType: 'none' });
  });
});
