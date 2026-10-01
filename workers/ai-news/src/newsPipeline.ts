import { NEWS_SOURCES, selectNewsSourcesForRun, validateNewsSourceRegistry, type NewsSourceDefinition } from './newsSources';
import {
  PipelineError,
  acquirePipelineLease,
  boundedFetch,
  canonicalUrl,
  completePipelineRun,
  decodeXmlEntities,
  envInteger,
  freshnessFromTimestamp,
  normalizeText,
  nowIso,
  recordSkippedLease,
  runKeyFor,
  safeErrorCode,
  safeHttpsUrl,
  sha256,
  startPipelineRun,
  stripHtml,
  truncate,
  type Env,
  type PipelineRunResult,
} from './runtime';

export type NewsMediaType = 'none' | 'image' | 'video';

export interface NewsCandidate {
  sourceId: string;
  sourcePlatform: string;
  company: string;
  verification: 'official' | 'confirmed';
  externalId: string;
  title: string;
  summary: string;
  url: string;
  publishedAt: string;
  category: string;
  modelNames: string[];
  importanceScore: number;
  imageUrl?: string;
  imageCredit?: string;
  videoUrl?: string;
  mediaType: NewsMediaType;
  mediaSource?: string;
  metadata?: Record<string, unknown>;
}

interface SourceFetchResult {
  source: NewsSourceDefinition;
  status: 'healthy' | 'failed' | 'unavailable';
  candidates: NewsCandidate[];
  errorCode?: string;
}

interface NewsCluster {
  primary: NewsCandidate;
  sources: NewsCandidate[];
}

interface ExistingEvent {
  id: string;
  event_key: string;
  title: string;
  company: string | null;
  published_at: string;
  model_names: string;
  primary_url: string;
}

interface StoredNewsEvent {
  id: string;
  event_key: string;
  title: string;
  summary: string;
  primary_url: string;
  company: string | null;
  category: string;
  verification: 'official' | 'confirmed';
  importance_score: number;
  published_at: string;
  collected_at: string;
  updated_at: string;
  image_url: string | null;
  image_credit: string | null;
  video_url: string | null;
  media_type: NewsMediaType;
  media_source: string | null;
  model_names: string;
  source_count: number;
}

interface StoredEventSource {
  event_id: string;
  source_id: string;
  company: string;
  url: string;
  source_platform: string;
  verification: 'official' | 'confirmed';
}

const AI_RELEVANCE = /\b(ai|artificial intelligence|llm|language model|multimodal|reasoning|agent|inference|transformer|embedding|vision model|text-to-image|text-to-video|speech model|model weights|api|sdk|mcp)\b/i;
const MAJOR_RELEASE = /\b(launch(?:es|ed)?|releas(?:e|es|ed)|introduc(?:e|es|ed)|announce(?:s|d)?|available now|open weights|new model|preview)\b/i;
const PRICING_CHANGE = /\b(pricing|price|cost|rate limit|context window|token limit)\b/i;
const BENCHMARK_NEWS = /\b(benchmark|leaderboard|evaluation|intelligence index|arena)\b/i;
const MODEL_PATTERNS: readonly RegExp[] = [
  /\bGPT[-\s]?\d(?:\.\d+)?(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bClaude(?:\s+[A-Za-z0-9.]+){1,4}\b/gi,
  /\bGemini(?:\s+[A-Za-z0-9.]+){1,4}\b/gi,
  /\bGrok(?:\s+[A-Za-z0-9.]+){0,3}\b/gi,
  /\bLlama(?:\s+[A-Za-z0-9.]+){0,3}\b/gi,
  /\bDeepSeek(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bQwen(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bKimi(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bGLM(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bMistral(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bMiniMax(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bCommand(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bNemotron(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
  /\bPhi(?:[-\s][A-Za-z0-9.]+){0,3}\b/gi,
];
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'new',
  'of',
  'on',
  'our',
  'the',
  'to',
  'with',
  'official',
  'release',
  'launch',
  'announcing',
  'introducing',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlTag(block: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i').exec(block);
    if (!match?.[1]) continue;
    return decodeXmlEntities(match[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim();
  }
  return undefined;
}

function xmlAttribute(block: string, elementPattern: string, attribute: string): string | undefined {
  const match = new RegExp(
    `<${elementPattern}\\b[^>]*\\b${escapeRegExp(attribute)}=["']([^"']+)["'][^>]*>`,
    'i',
  ).exec(block);
  return match?.[1] ? decodeXmlEntities(match[1]).trim() : undefined;
}

function atomLink(block: string): string | undefined {
  const alternate = /<link\b(?=[^>]*\brel=["']alternate["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(
    block,
  );
  if (alternate?.[1]) return decodeXmlEntities(alternate[1]);
  return xmlAttribute(block, 'link', 'href') ?? xmlTag(block, ['link']);
}

function parseTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function youtubeId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0];
    if (url.hostname.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v') ?? undefined;
      return /^\/(?:shorts|embed)\/([^/?#]+)/.exec(url.pathname)?.[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function extractModelNames(value: string): string[] {
  const matches: string[] = [];
  for (const pattern of MODEL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const cleaned = match[0].replace(/[),.;:]+$/, '').trim();
      if (cleaned.length >= 3) matches.push(cleaned);
    }
  }
  const unique = new Map<string, string>();
  for (const match of matches) unique.set(normalizeText(match), match);
  return [...unique.values()].slice(0, 8);
}

function categoryFor(value: string): string {
  if (PRICING_CHANGE.test(value)) return 'pricing-and-limits';
  if (BENCHMARK_NEWS.test(value)) return 'benchmarks';
  if (/\b(api|sdk|developer|tool|mcp|agent|coding)\b/i.test(value)) return 'developer-tools';
  if (/\b(research|paper|study|safety|alignment)\b/i.test(value)) return 'research';
  if (MAJOR_RELEASE.test(value) || /\bmodel\b/i.test(value)) return 'model-release';
  return 'company-update';
}

function importanceFor(source: NewsSourceDefinition, value: string, modelNames: readonly string[]): number {
  let score = Math.round(source.priority * 0.65);
  if (MAJOR_RELEASE.test(value)) score += 18;
  if (PRICING_CHANGE.test(value)) score += 12;
  if (BENCHMARK_NEWS.test(value)) score += 8;
  if (modelNames.length) score += 8;
  if (source.verification === 'official') score += 5;
  return Math.max(0, Math.min(100, score));
}

function bestMedia(block: string, pageUrl: string): {
  imageUrl?: string;
  videoUrl?: string;
  mediaType: NewsMediaType;
  mediaSource?: string;
} {
  const mediaImage =
    xmlAttribute(block, 'media:(?:content|thumbnail)', 'url') ??
    xmlAttribute(block, 'enclosure(?=[^>]*(?:image|thumbnail))', 'url');
  const mediaVideo = xmlAttribute(block, 'enclosure(?=[^>]*video)', 'url');
  const id = youtubeId(pageUrl) ?? xmlTag(block, ['yt:videoId']);
  const videoUrl = safeHttpsUrl(mediaVideo) ?? (id ? `https://www.youtube.com/watch?v=${id}` : null);
  const imageUrl =
    safeHttpsUrl(mediaImage) ?? (id ? `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg` : null);
  if (videoUrl) {
    return {
      ...(imageUrl ? { imageUrl } : {}),
      videoUrl,
      mediaType: 'video',
      mediaSource: id ? 'youtube-feed' : 'feed-enclosure',
    };
  }
  if (imageUrl) return { imageUrl, mediaType: 'image', mediaSource: 'rss-media' };
  return { mediaType: 'none' };
}

export function parseOfficialFeed(
  source: NewsSourceDefinition,
  xml: string,
  observedAt = nowIso(),
): NewsCandidate[] {
  const trimmed = xml.trim();
  if (!trimmed || /^<!doctype\s+html|^<html\b/i.test(trimmed)) {
    throw new PipelineError('SOURCE_HTML_RESPONSE', 'Feed endpoint returned HTML instead of RSS/Atom.');
  }
  const blocks = [...trimmed.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(
    (match) => match[2] ?? '',
  );
  if (!blocks.length) throw new PipelineError('SOURCE_FEED_MALFORMED', 'Feed contained no item or entry elements.');

  const candidates: NewsCandidate[] = [];
  for (const block of blocks.slice(0, 20)) {
    const title = truncate(stripHtml(xmlTag(block, ['title']) ?? ''), 240);
    const rawUrl = atomLink(block);
    const url = rawUrl ? canonicalUrl(new URL(rawUrl, source.endpoint).toString()) : null;
    const publishedAt = parseTimestamp(
      xmlTag(block, ['published', 'updated', 'pubDate', 'dc:date', 'date']),
    );
    if (!title || !url || !publishedAt) continue;
    const description = stripHtml(
      xmlTag(block, ['summary', 'description', 'content:encoded', 'content']) ?? '',
    );
    const combined = `${title} ${description}`;
    if (!AI_RELEVANCE.test(combined) && source.sourceType !== 'github_releases') continue;
    const modelNames = extractModelNames(combined);
    const media = bestMedia(block, url);
    const externalId = truncate(
      stripHtml(xmlTag(block, ['guid', 'id']) ?? url),
      500,
    );
    candidates.push({
      sourceId: source.id,
      sourcePlatform:
        source.sourceType === 'github_releases'
          ? 'github'
          : source.sourceType === 'youtube_feed'
            ? 'youtube'
            : source.sourceType,
      company: source.company,
      verification: source.verification,
      externalId,
      title,
      summary: truncate(description || title, 480),
      url,
      publishedAt,
      category: categoryFor(combined),
      modelNames,
      importanceScore: importanceFor(source, combined, modelNames),
      ...media,
      ...(media.imageUrl ? { imageCredit: `${source.company} official source` } : {}),
      metadata: { observedAt },
    });
  }
  return candidates;
}

function xTitle(text: string): string {
  const firstLine = text.split(/\n+/).find((line) => line.trim()) ?? text;
  return truncate(firstLine, 180);
}

export function parseXResponse(
  source: NewsSourceDefinition,
  payload: unknown,
): NewsCandidate[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PipelineError('X_PAYLOAD_MALFORMED', 'X API returned a malformed response.');
  }
  const root = payload as Record<string, unknown>;
  const data = Array.isArray(root.data) ? root.data : [];
  const includes =
    root.includes && typeof root.includes === 'object' && !Array.isArray(root.includes)
      ? (root.includes as Record<string, unknown>)
      : {};
  const mediaItems = Array.isArray(includes.media) ? includes.media : [];
  const mediaByKey = new Map<string, Record<string, unknown>>();
  for (const item of mediaItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const media = item as Record<string, unknown>;
    if (typeof media.media_key === 'string') mediaByKey.set(media.media_key, media);
  }

  return data.flatMap((item): NewsCandidate[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const tweet = item as Record<string, unknown>;
    const id = typeof tweet.id === 'string' ? tweet.id : '';
    const body = typeof tweet.text === 'string' ? stripHtml(tweet.text) : '';
    const publishedAt = parseTimestamp(typeof tweet.created_at === 'string' ? tweet.created_at : undefined);
    if (!id || !body || !publishedAt || !source.xHandle) return [];
    const url = `https://x.com/${source.xHandle}/status/${id}`;
    const attachments =
      tweet.attachments && typeof tweet.attachments === 'object' && !Array.isArray(tweet.attachments)
        ? (tweet.attachments as Record<string, unknown>)
        : {};
    const mediaKeys = Array.isArray(attachments.media_keys)
      ? attachments.media_keys.filter((key): key is string => typeof key === 'string')
      : [];
    let imageUrl: string | undefined;
    let videoUrl: string | undefined;
    let mediaType: NewsMediaType = 'none';
    for (const key of mediaKeys) {
      const media = mediaByKey.get(key);
      if (!media) continue;
      const type = typeof media.type === 'string' ? media.type : '';
      const image = safeHttpsUrl(
        typeof media.url === 'string'
          ? media.url
          : typeof media.preview_image_url === 'string'
            ? media.preview_image_url
            : undefined,
      );
      if (image && !imageUrl) imageUrl = image;
      if ((type === 'video' || type === 'animated_gif') && !videoUrl) videoUrl = url;
      if (videoUrl) mediaType = 'video';
      else if (imageUrl) mediaType = 'image';
    }
    const modelNames = extractModelNames(body);
    return [
      {
        sourceId: source.id,
        sourcePlatform: 'x',
        company: source.company,
        verification: 'official',
        externalId: id,
        title: xTitle(body),
        summary: truncate(body, 480),
        url,
        publishedAt,
        category: categoryFor(body),
        modelNames,
        importanceScore: importanceFor(source, body, modelNames),
        ...(imageUrl ? { imageUrl, imageCredit: `${source.company} on X` } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        mediaType,
        ...(mediaType !== 'none' ? { mediaSource: 'x-api' } : {}),
      },
    ];
  });
}

async function fetchXSource(source: NewsSourceDefinition, bearerToken: string): Promise<NewsCandidate[]> {
  if (!source.xHandle) throw new PipelineError('X_HANDLE_MISSING', 'X source omitted its official handle.');
  const query = encodeURIComponent(`from:${source.xHandle} -is:retweet`);
  const endpoint =
    `https://api.x.com/2/tweets/search/recent?query=${query}` +
    '&max_results=10&tweet.fields=created_at,attachments,entities' +
    '&expansions=attachments.media_keys&media.fields=url,preview_image_url,type';
  const fetched = await boundedFetch(endpoint, {
    headers: { authorization: `Bearer ${bearerToken}` },
    accept: 'application/json',
    timeoutMs: 8_000,
    maxBytes: 750_000,
    maxRedirects: 1,
    retries: 1,
  });
  let payload: unknown;
  try {
    payload = JSON.parse(fetched.text);
  } catch {
    throw new PipelineError('X_JSON_INVALID', 'X API returned invalid JSON.');
  }
  return parseXResponse(source, payload);
}

async function fetchOneSource(env: Env, source: NewsSourceDefinition): Promise<SourceFetchResult> {
  try {
    if (source.sourceType === 'x') {
      if (!env.X_BEARER_TOKEN?.trim()) {
        return { source, status: 'unavailable', candidates: [], errorCode: 'X_API_UNAVAILABLE' };
      }
      return {
        source,
        status: 'healthy',
        candidates: await fetchXSource(source, env.X_BEARER_TOKEN.trim()),
      };
    }
    if (!source.endpoint) throw new PipelineError('SOURCE_ENDPOINT_MISSING', 'Enabled source omitted an endpoint.');
    const fetched = await boundedFetch(source.endpoint, {
      timeoutMs: 8_000,
      maxBytes: 1_500_000,
      maxRedirects: 3,
      retries: 1,
    });
    return {
      source,
      status: 'healthy',
      candidates: parseOfficialFeed(source, fetched.text),
    };
  } catch (error) {
    return {
      source,
      status: 'failed',
      candidates: [],
      errorCode: safeErrorCode(error, 'SOURCE_FETCH_FAILED'),
    };
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function titleTokens(value: string): Set<string> {
  return new Set(
    normalizeText(value)
      .split(' ')
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

export function titleSimilarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function modelOverlap(left: readonly string[], right: readonly string[]): boolean {
  const normalized = new Set(left.map(normalizeText));
  return right.some((model) => normalized.has(normalizeText(model)));
}

function withinHours(left: string, right: string, hours: number): boolean {
  const delta = Math.abs(Date.parse(left) - Date.parse(right));
  return Number.isFinite(delta) && delta <= hours * 60 * 60_000;
}

export function shouldClusterNews(left: NewsCandidate, right: NewsCandidate): boolean {
  if (left.company !== right.company || !withinHours(left.publishedAt, right.publishedAt, 72)) return false;
  if (canonicalUrl(left.url) === canonicalUrl(right.url)) return true;
  const similarity = titleSimilarity(left.title, right.title);
  if (similarity >= 0.72) return true;
  return modelOverlap(left.modelNames, right.modelNames) && similarity >= 0.48;
}

function primaryScore(candidate: NewsCandidate): number {
  const platformScore =
    candidate.sourcePlatform === 'rss' || candidate.sourcePlatform === 'atom'
      ? 30
      : candidate.sourcePlatform === 'github'
        ? 25
        : candidate.sourcePlatform === 'youtube'
          ? 20
          : candidate.sourcePlatform === 'x'
            ? 10
            : 0;
  return candidate.importanceScore + platformScore + (candidate.summary.length >= 80 ? 5 : 0);
}

export function clusterNewsCandidates(candidates: readonly NewsCandidate[]): NewsCluster[] {
  const ordered = candidates
    .slice()
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  const clusters: NewsCluster[] = [];
  for (const candidate of ordered) {
    const existing = clusters.find((cluster) => cluster.sources.some((source) => shouldClusterNews(source, candidate)));
    if (existing) {
      existing.sources.push(candidate);
      if (primaryScore(candidate) > primaryScore(existing.primary)) existing.primary = candidate;
    } else {
      clusters.push({ primary: candidate, sources: [candidate] });
    }
  }
  return clusters;
}

function absoluteHttps(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined;
  try {
    return safeHttpsUrl(new URL(decodeXmlEntities(value), baseUrl).toString()) ?? undefined;
  } catch {
    return undefined;
  }
}

export function parseOpenGraphMedia(html: string, pageUrl: string): {
  imageUrl?: string;
  videoUrl?: string;
  mediaType: NewsMediaType;
  mediaSource?: string;
} {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const values = new Map<string, string>();
  for (const tag of tags) {
    const property = /\b(?:property|name)=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1];
    if (property && content && !values.has(property)) values.set(property, content);
  }
  const videoUrl = absoluteHttps(values.get('og:video:secure_url') ?? values.get('og:video'), pageUrl);
  const imageUrl = absoluteHttps(
    values.get('og:image:secure_url') ?? values.get('og:image') ?? values.get('twitter:image'),
    pageUrl,
  );
  if (videoUrl) {
    return {
      ...(imageUrl ? { imageUrl } : {}),
      videoUrl,
      mediaType: 'video',
      mediaSource: 'open-graph',
    };
  }
  if (imageUrl) return { imageUrl, mediaType: 'image', mediaSource: 'open-graph' };
  return { mediaType: 'none' };
}

async function enrichClusterMedia(cluster: NewsCluster): Promise<NewsCluster> {
  if (cluster.primary.mediaType !== 'none' || cluster.sources.some((source) => source.mediaType !== 'none')) {
    const mediaSource = cluster.sources.find((source) => source.mediaType !== 'none');
    if (mediaSource && cluster.primary.mediaType === 'none') {
      cluster.primary = {
        ...cluster.primary,
        imageUrl: mediaSource.imageUrl,
        imageCredit: mediaSource.imageCredit,
        videoUrl: mediaSource.videoUrl,
        mediaType: mediaSource.mediaType,
        mediaSource: mediaSource.mediaSource,
      };
    }
    return cluster;
  }
  try {
    const fetched = await boundedFetch(cluster.primary.url, {
      accept: 'text/html, application/xhtml+xml',
      timeoutMs: 5_000,
      maxBytes: 600_000,
      maxRedirects: 2,
      retries: 0,
    });
    if (!/html/i.test(fetched.contentType) && !/<(?:html|meta)\b/i.test(fetched.text)) return cluster;
    const media = parseOpenGraphMedia(fetched.text, fetched.finalUrl);
    if (media.mediaType !== 'none') {
      cluster.primary = {
        ...cluster.primary,
        ...media,
        ...(media.imageUrl ? { imageCredit: `${cluster.primary.company} official page` } : {}),
      };
    }
  } catch {
    // Media enrichment is optional and must never fail the core news run.
  }
  return cluster;
}

async function seedSourceRegistry(db: D1Database, at: string): Promise<void> {
  const validation = validateNewsSourceRegistry();
  if (!validation.valid) {
    throw new PipelineError('SOURCE_REGISTRY_INVALID', validation.errors.join('; '));
  }
  const statements: D1PreparedStatement[] = [];
  for (const source of NEWS_SOURCES) {
    statements.push(
      db
        .prepare(
          `INSERT INTO intelligence_news_sources
            (id, company, priority, enabled, source_type, endpoint, official_site, x_handle,
             verification, rotation_group, disabled_reason, metadata_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             company = excluded.company,
             priority = excluded.priority,
             enabled = excluded.enabled,
             source_type = excluded.source_type,
             endpoint = excluded.endpoint,
             official_site = excluded.official_site,
             x_handle = excluded.x_handle,
             verification = excluded.verification,
             rotation_group = excluded.rotation_group,
             disabled_reason = excluded.disabled_reason,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .bind(
          source.id,
          source.company,
          source.priority,
          source.enabled ? 1 : 0,
          source.sourceType,
          source.endpoint ?? null,
          source.officialSite ?? null,
          source.xHandle ?? null,
          source.verification,
          source.rotationGroup,
          source.disabledReason ?? null,
          JSON.stringify({ tags: source.tags ?? [] }),
          at,
        ),
      db
        .prepare(
          `INSERT INTO intelligence_news_source_health(source_id, status, metadata_json)
           VALUES (?, ?, '{}')
           ON CONFLICT(source_id) DO UPDATE SET
             status = CASE WHEN ? = 0 THEN 'disabled'
                           WHEN intelligence_news_source_health.status = 'disabled' THEN 'never'
                           ELSE intelligence_news_source_health.status END,
             last_error_code = CASE WHEN ? = 0 THEN 'SOURCE_DISABLED' ELSE last_error_code END`,
        )
        .bind(source.id, source.enabled ? 'never' : 'disabled', source.enabled ? 1 : 0, source.enabled ? 1 : 0),
    );
  }
  await db.batch(statements);
}

async function updateSourceHealth(db: D1Database, result: SourceFetchResult, at: string): Promise<void> {
  const newestItemAt = result.candidates
    .map((candidate) => candidate.publishedAt)
    .sort()
    .at(-1) ?? null;
  const status = result.status;
  await db
    .prepare(
      `INSERT INTO intelligence_news_source_health
        (source_id, last_attempt_at, last_success_at, last_item_at, status,
         failure_count, last_error_code, last_error_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = CASE WHEN excluded.status = 'healthy' THEN excluded.last_success_at
                                ELSE intelligence_news_source_health.last_success_at END,
         last_item_at = COALESCE(excluded.last_item_at, intelligence_news_source_health.last_item_at),
         status = excluded.status,
         failure_count = CASE WHEN excluded.status = 'healthy' THEN 0
                              ELSE intelligence_news_source_health.failure_count + 1 END,
         last_error_code = excluded.last_error_code,
         last_error_at = excluded.last_error_at,
         metadata_json = excluded.metadata_json`,
    )
    .bind(
      result.source.id,
      at,
      status === 'healthy' ? at : null,
      newestItemAt,
      status,
      status === 'healthy' ? 0 : 1,
      result.errorCode ?? null,
      status === 'healthy' ? null : at,
      JSON.stringify({ itemCount: result.candidates.length }),
    )
    .run();
}

function parseStoredModelNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function existingMatchesCluster(existing: ExistingEvent, cluster: NewsCluster): boolean {
  const candidate = cluster.primary;
  if (existing.primary_url === candidate.url) return true;
  if (existing.company !== candidate.company || !withinHours(existing.published_at, candidate.publishedAt, 72)) {
    return false;
  }
  const similarity = titleSimilarity(existing.title, candidate.title);
  if (similarity >= 0.72) return true;
  return modelOverlap(parseStoredModelNames(existing.model_names), candidate.modelNames) && similarity >= 0.48;
}

async function eventIdentity(cluster: NewsCluster): Promise<{ eventKey: string; id: string }> {
  const models = cluster.sources.flatMap((source) => source.modelNames).map(normalizeText).sort();
  const title = normalizeText(cluster.primary.title);
  const day = cluster.sources.map((source) => source.publishedAt).sort()[0]?.slice(0, 10) ?? '';
  const eventKey = await sha256(`${normalizeText(cluster.primary.company)}|${models.join('|')}|${day}|${title}`);
  return { eventKey, id: `evt-${eventKey.slice(0, 28)}` };
}

async function persistClusters(
  db: D1Database,
  clusters: readonly NewsCluster[],
  collectedAt: string,
): Promise<number> {
  if (!clusters.length) return 0;
  const recentSince = new Date(Date.parse(collectedAt) - 14 * 86_400_000).toISOString();
  const existingRows = await db
    .prepare(
      `SELECT id, event_key, title, company, published_at, model_names, primary_url
       FROM intelligence_news_events
       WHERE published_at >= ?
       ORDER BY published_at DESC
       LIMIT 500`,
    )
    .bind(recentSince)
    .all<ExistingEvent>();
  const existing = existingRows.results.slice();
  let stored = 0;

  for (const cluster of clusters) {
    const identity = await eventIdentity(cluster);
    const matched = existing.find((event) => existingMatchesCluster(event, cluster));
    const id = matched?.id ?? identity.id;
    const eventKey = matched?.event_key ?? identity.eventKey;
    const publishedAt = cluster.sources.map((source) => source.publishedAt).sort()[0] ?? cluster.primary.publishedAt;
    const allModels = [
      ...new Map(
        cluster.sources
          .flatMap((source) => source.modelNames)
          .map((model) => [normalizeText(model), model] as const),
      ).values(),
    ].slice(0, 12);
    const verification = cluster.sources.every((source) => source.verification === 'official')
      ? 'official'
      : 'confirmed';
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          `INSERT INTO intelligence_news_events
            (id, event_key, title, summary, primary_url, company, category, verification,
             importance_score, published_at, collected_at, updated_at, image_url,
             image_credit, video_url, media_type, media_source, model_names, source_count, metadata_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             summary = excluded.summary,
             primary_url = excluded.primary_url,
             category = excluded.category,
             verification = excluded.verification,
             importance_score = MAX(intelligence_news_events.importance_score, excluded.importance_score),
             published_at = MIN(intelligence_news_events.published_at, excluded.published_at),
             updated_at = excluded.updated_at,
             image_url = COALESCE(excluded.image_url, intelligence_news_events.image_url),
             image_credit = COALESCE(excluded.image_credit, intelligence_news_events.image_credit),
             video_url = COALESCE(excluded.video_url, intelligence_news_events.video_url),
             media_type = CASE WHEN excluded.media_type <> 'none' THEN excluded.media_type
                               ELSE intelligence_news_events.media_type END,
             media_source = COALESCE(excluded.media_source, intelligence_news_events.media_source),
             model_names = excluded.model_names,
             metadata_json = excluded.metadata_json`,
        )
        .bind(
          id,
          eventKey,
          cluster.primary.title,
          cluster.primary.summary,
          cluster.primary.url,
          cluster.primary.company,
          cluster.primary.category,
          verification,
          Math.max(...cluster.sources.map((source) => source.importanceScore)),
          publishedAt,
          collectedAt,
          collectedAt,
          cluster.primary.imageUrl ?? null,
          cluster.primary.imageCredit ?? null,
          cluster.primary.videoUrl ?? null,
          cluster.primary.mediaType,
          cluster.primary.mediaSource ?? null,
          JSON.stringify(allModels),
          JSON.stringify({ clusteredSources: cluster.sources.length }),
        ),
    ];
    for (const source of cluster.sources) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO intelligence_news_event_sources
              (event_id, source_id, external_id, url, title, published_at,
               source_platform, verification, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            id,
            source.sourceId,
            source.externalId,
            source.url,
            source.title,
            source.publishedAt,
            source.sourcePlatform,
            source.verification,
            JSON.stringify(source.metadata ?? {}),
          ),
      );
    }
    statements.push(
      db
        .prepare(
          `UPDATE intelligence_news_events
           SET source_count = (SELECT COUNT(*) FROM intelligence_news_event_sources WHERE event_id = ?)
           WHERE id = ?`,
        )
        .bind(id, id),
    );
    await db.batch(statements);
    if (!matched) {
      existing.push({
        id,
        event_key: eventKey,
        title: cluster.primary.title,
        company: cluster.primary.company,
        published_at: publishedAt,
        model_names: JSON.stringify(allModels),
        primary_url: cluster.primary.url,
      });
    }
    stored += 1;
  }
  return stored;
}

async function applyRetention(db: D1Database, retentionDays: number, at: string): Promise<void> {
  const cutoff = new Date(Date.parse(at) - retentionDays * 86_400_000).toISOString();
  await db.prepare('DELETE FROM intelligence_news_events WHERE published_at < ?').bind(cutoff).run();
}

export async function runNewsIngestion(env: Env, scheduledAt: string): Promise<PipelineRunResult> {
  const pipeline = 'news-hourly' as const;
  const runKey = runKeyFor(pipeline, scheduledAt);
  const lease = await acquirePipelineLease(env.DB, pipeline, runKey, nowIso());
  if (!lease) {
    await recordSkippedLease(env.DB, pipeline);
    return {
      pipeline,
      runKey,
      status: 'skipped',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 0,
      metadata: { reason: 'lease-held-or-duplicate' },
    };
  }
  const runId = await startPipelineRun(env.DB, lease, scheduledAt);
  if (!runId) {
    await recordSkippedLease(env.DB, pipeline);
    return {
      pipeline,
      runKey,
      status: 'skipped',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 0,
      metadata: { reason: 'duplicate-run' },
    };
  }

  let result: PipelineRunResult;
  try {
    const at = nowIso();
    await seedSourceRegistry(env.DB, at);
    const selected = selectNewsSourcesForRun(scheduledAt, {
      maxSources: envInteger(env.NEWS_MAX_SOURCES_PER_RUN, 24, 8, 30),
      maxX: envInteger(env.NEWS_MAX_X_SOURCES_PER_RUN, 2, 0, 4),
    });
    const fetched = await mapWithConcurrency(selected, 6, (source) => fetchOneSource(env, source));
    await mapWithConcurrency(fetched, 6, (sourceResult) => updateSourceHealth(env.DB, sourceResult, at));

    const healthy = fetched.filter((entry) => entry.status === 'healthy');
    const failures = fetched.filter((entry) => entry.status === 'failed');
    const unavailable = fetched.filter((entry) => entry.status === 'unavailable');
    if (!healthy.length) {
      throw new PipelineError('NEWS_ALL_SOURCES_FAILED', 'No selected source completed successfully.');
    }
    const maxItems = envInteger(env.NEWS_MAX_ITEMS_PER_RUN, 40, 10, 80);
    const candidates = healthy
      .flatMap((entry) => entry.candidates)
      .sort(
        (left, right) =>
          Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
          right.importanceScore - left.importanceScore,
      )
      .slice(0, maxItems);
    let clusters = clusterNewsCandidates(candidates);
    const enrichmentLimit = envInteger(env.NEWS_MEDIA_ENRICHMENT_LIMIT, 4, 0, 8);
    const needsEnrichment = clusters.filter((cluster) => cluster.primary.mediaType === 'none').slice(0, enrichmentLimit);
    const enriched = await mapWithConcurrency(needsEnrichment, 2, enrichClusterMedia);
    const enrichedByPrimaryUrl = new Map(enriched.map((cluster) => [cluster.primary.url, cluster]));
    clusters = clusters.map((cluster) => enrichedByPrimaryUrl.get(cluster.primary.url) ?? cluster);
    const storedCount = await persistClusters(env.DB, clusters, at);
    await applyRetention(env.DB, envInteger(env.NEWS_RETENTION_DAYS, 45, 7, 180), at);

    result = {
      pipeline,
      runKey,
      status: failures.length || unavailable.length ? 'partial' : 'success',
      fetchedCount: candidates.length,
      storedCount,
      succeededSources: healthy.length,
      failedSources: failures.length,
      metadata: {
        selectedSources: selected.length,
        clusteredEvents: clusters.length,
        unavailableSources: unavailable.length,
        xActive: Boolean(env.X_BEARER_TOKEN?.trim()),
        sourceRegistryCount: NEWS_SOURCES.length,
        mediaEnrichmentAttempts: needsEnrichment.length,
      },
      errors: [
        ...failures.map((entry) => ({ code: entry.errorCode ?? 'SOURCE_FETCH_FAILED', sourceId: entry.source.id })),
        ...unavailable.map((entry) => ({ code: entry.errorCode ?? 'SOURCE_UNAVAILABLE', sourceId: entry.source.id })),
      ],
    };
  } catch (error) {
    result = {
      pipeline,
      runKey,
      status: 'failed',
      fetchedCount: 0,
      storedCount: 0,
      succeededSources: 0,
      failedSources: 1,
      metadata: { retainedLastKnownGood: true, sourceRegistryCount: NEWS_SOURCES.length },
      errors: [{ code: safeErrorCode(error, 'NEWS_INGESTION_FAILED') }],
    };
  }
  await completePipelineRun(env.DB, lease, runId, result);
  return result;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export async function readNewsApi(env: Env, requestedLimit: number): Promise<Record<string, unknown>> {
  const limit = Math.min(100, Math.max(1, Math.floor(requestedLimit || 50)));
  const events = await env.DB
    .prepare(
      `SELECT * FROM intelligence_news_events
       ORDER BY published_at DESC, importance_score DESC, id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<StoredNewsEvent>();
  const ids = events.results.map((event) => event.id);
  const sourceRows = ids.length
    ? await env.DB
        .prepare(
          `SELECT es.event_id, es.source_id, s.company, es.url, es.source_platform, es.verification
           FROM intelligence_news_event_sources es
           JOIN intelligence_news_sources s ON s.id = es.source_id
           WHERE es.event_id IN (${ids.map(() => '?').join(',')})
           ORDER BY es.published_at ASC, es.source_id ASC`,
        )
        .bind(...ids)
        .all<StoredEventSource>()
    : { results: [] as StoredEventSource[] };
  const byEvent = new Map<string, StoredEventSource[]>();
  for (const source of sourceRows.results) {
    const list = byEvent.get(source.event_id) ?? [];
    list.push(source);
    byEvent.set(source.event_id, list);
  }
  const latestRun = await env.DB
    .prepare(
      `SELECT completed_at, status, fetched_count, stored_count, succeeded_sources,
              failed_sources, metadata_json, error_json
       FROM intelligence_pipeline_runs
       WHERE pipeline = 'news-hourly' AND status IN ('success', 'partial')
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .first<{
      completed_at: string | null;
      status: string;
      fetched_count: number;
      stored_count: number;
      succeeded_sources: number;
      failed_sources: number;
      metadata_json: string;
      error_json: string;
    }>();
  const slaMinutes = Number.parseInt(env.FRESHNESS_SLA_MINUTES ?? '120', 10) || 120;
  const freshness = freshnessFromTimestamp(latestRun?.completed_at, Date.now(), slaMinutes);

  return {
    freeOnly: true,
    generatedAt: nowIso(),
    lastCompletedAt: latestRun?.completed_at ?? undefined,
    freshness,
    latestRun: latestRun
      ? {
          completed_at: latestRun.completed_at,
          status: latestRun.status,
          fetchedCount: latestRun.fetched_count,
          storedCount: latestRun.stored_count,
          succeededSources: latestRun.succeeded_sources,
          failedSources: latestRun.failed_sources,
        }
      : null,
    items: events.results.map((event) => {
      const references = byEvent.get(event.id) ?? [];
      const primary = references[0];
      return {
        id: event.id,
        title: event.title,
        summary: event.summary,
        url: event.primary_url,
        source: {
          name: primary?.company ?? event.company ?? 'Official source',
          platform: primary?.source_platform ?? 'official',
        },
        verification: event.verification,
        company: event.company ?? undefined,
        category: event.category,
        modelNames: parseJsonArray(event.model_names),
        publishedAt: event.published_at,
        imageUrl: event.image_url ?? undefined,
        imageCredit: event.image_credit ?? undefined,
        videoUrl: event.video_url ?? undefined,
        mediaType: event.media_type,
        mediaSource: event.media_source ?? undefined,
        sourceReferences: references.map((reference) => ({
          name: reference.company,
          url: reference.url,
          platform: reference.source_platform,
        })),
      };
    }),
  };
}

export async function readSourcesApi(env: Env): Promise<Record<string, unknown>> {
  const sources = await env.DB
    .prepare(
      `SELECT s.id, s.company, s.priority, s.enabled, s.source_type, s.official_site,
              s.x_handle, s.disabled_reason, h.last_attempt_at, h.last_success_at,
              h.last_item_at, h.status, h.failure_count, h.last_error_code
       FROM intelligence_news_sources s
       LEFT JOIN intelligence_news_source_health h ON h.source_id = s.id
       ORDER BY s.priority DESC, s.company ASC, s.id ASC`,
    )
    .all<Record<string, unknown>>();
  return {
    generatedAt: nowIso(),
    sourceCount: NEWS_SOURCES.length,
    registryValidation: validateNewsSourceRegistry(),
    xConfigured: Boolean(env.X_BEARER_TOKEN?.trim()),
    sources: sources.results,
  };
}
