interface Env {
  DB: D1Database;
  CORS_ORIGIN?: string;
  MAX_ITEMS_PER_RUN?: string;
  RETENTION_DAYS?: string;
  EXTRA_FEEDS?: string;
}

type Verification = "official" | "confirmed";
type Platform = "official" | "release" | "media";

interface FeedSource {
  name: string;
  url: string;
  platform: Platform;
  verification: Verification;
  company?: string;
}

interface NewsCandidate {
  sourcePlatform: Platform;
  externalId: string;
  sourceName: string;
  sourceUrl: string;
  title: string;
  text: string;
  company?: string;
  publishedAt: string;
  verification: Verification;
}

interface StoredNews extends NewsCandidate {
  summary: string;
  category: string;
  modelNames: string[];
  importanceScore: number;
  dedupeKey: string;
}

interface IngestionResult {
  status: "success" | "partial" | "failed";
  fetched: number;
  stored: number;
  errors: Array<{ source: string; message: string }>;
  startedAt: string;
  completedAt: string;
}

const DEFAULT_FEEDS: FeedSource[] = [
  {
    name: "OpenAI News",
    url: "https://openai.com/news/rss.xml",
    platform: "official",
    verification: "official",
    company: "OpenAI",
  },
  {
    name: "Google AI Blog",
    url: "https://blog.google/technology/ai/rss/",
    platform: "official",
    verification: "official",
    company: "Google",
  },
  {
    name: "Google DeepMind",
    url: "https://deepmind.google/blog/rss.xml",
    platform: "official",
    verification: "official",
    company: "Google DeepMind",
  },
  {
    name: "Hugging Face Blog",
    url: "https://huggingface.co/blog/feed.xml",
    platform: "official",
    verification: "official",
    company: "Hugging Face",
  },
  {
    name: "NVIDIA Generative AI",
    url: "https://developer.nvidia.com/blog/category/generative-ai/feed/",
    platform: "official",
    verification: "official",
    company: "NVIDIA",
  },
  {
    name: "Ollama Releases",
    url: "https://github.com/ollama/ollama/releases.atom",
    platform: "release",
    verification: "official",
    company: "Ollama",
  },
  {
    name: "Transformers Releases",
    url: "https://github.com/huggingface/transformers/releases.atom",
    platform: "release",
    verification: "official",
    company: "Hugging Face",
  },
  {
    name: "AI Model News",
    url: "https://news.google.com/rss/search?q=%28OpenAI%20OR%20Anthropic%20OR%20Claude%20OR%20Gemini%20OR%20DeepSeek%20OR%20Qwen%20OR%20Mistral%20OR%20Grok%29%20AI%20model&hl=en-US&gl=US&ceid=US%3Aen",
    platform: "media",
    verification: "confirmed",
  },
];

const MODEL_PATTERNS: Array<[RegExp, string]> = [
  [/\bGPT[- ]?[\w.]+\b/gi, "GPT"],
  [/\bClaude(?:\s+[\w.]+){0,3}\b/gi, "Claude"],
  [/\bGemini(?:\s+[\w.]+){0,3}\b/gi, "Gemini"],
  [/\bGrok(?:\s+[\w.]+){0,2}\b/gi, "Grok"],
  [/\bDeepSeek(?:[- ]?[\w.]+)?\b/gi, "DeepSeek"],
  [/\bQwen(?:[- ]?[\w.]+)?\b/gi, "Qwen"],
  [/\bMistral(?:\s+[\w.]+){0,2}\b/gi, "Mistral"],
  [/\bLlama(?:\s+[\w.]+){0,2}\b/gi, "Llama"],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, headers);
    }

    try {
      if (url.pathname === "/") {
        return json(
          {
            service: "VibeSpace Free AI News",
            freeOnly: true,
            schedule: "7 * * * *",
            endpoints: ["/health", "/api/sources", "/api/news", "/api/news.json"],
          },
          200,
          headers,
        );
      }

      if (url.pathname === "/api/sources") {
        return json({ sources: getFeeds(env) }, 200, headers);
      }

      if (url.pathname === "/health") {
        const latestRun = await env.DB.prepare(
          `SELECT started_at, completed_at, status, fetched_count, stored_count, error_json
           FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
        ).first();
        const count = await countNews(env);
        return json({ ok: true, freeOnly: true, itemCount: count, latestRun }, 200, headers);
      }

      if (url.pathname === "/api/news" || url.pathname === "/api/news.json") {
        return await getNews(url, env, headers);
      }

      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      console.error("Request failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return json({ error: "News service failed" }, 500, headers);
    }
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(runIngestion(env, new Date(controller.scheduledTime).toISOString()));
  },
} satisfies ExportedHandler<Env>;

async function getNews(url: URL, env: Env, headers: Headers): Promise<Response> {
  const limit = clampInteger(url.searchParams.get("limit"), 30, 1, 100);
  const verification = url.searchParams.get("verification");
  const company = url.searchParams.get("company");
  const category = url.searchParams.get("category");
  const platform = url.searchParams.get("platform");

  const conditions: string[] = [];
  const bindings: Array<string | number> = [];

  if (verification === "official" || verification === "confirmed") {
    conditions.push("verification_status = ?");
    bindings.push(verification);
  }
  if (company) {
    conditions.push("company = ?");
    bindings.push(company.slice(0, 100));
  }
  if (category) {
    conditions.push("category = ?");
    bindings.push(category.slice(0, 50));
  }
  if (platform === "official" || platform === "release" || platform === "media") {
    conditions.push("source_platform = ?");
    bindings.push(platform);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await env.DB.prepare(
    `SELECT
       id, source_platform, source_name, source_url, raw_title, ai_headline, ai_summary,
       company, model_names, category, verification_status, importance_score,
       published_at, collected_at
     FROM news_items
     ${where}
     ORDER BY published_at DESC, importance_score DESC
     LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all<Record<string, unknown>>();

  const items = (result.results ?? []).map((row) => ({
    id: row.id,
    title: row.ai_headline || row.raw_title,
    summary: row.ai_summary || "",
    url: row.source_url,
    source: {
      platform: row.source_platform,
      name: row.source_name,
    },
    company: row.company,
    modelNames: safeJsonArray(row.model_names),
    category: row.category,
    verification: row.verification_status,
    importance: row.importance_score,
    publishedAt: row.published_at,
    collectedAt: row.collected_at,
  }));

  const latestRun = await env.DB.prepare(
    `SELECT completed_at, status, fetched_count, stored_count
     FROM ingestion_runs ORDER BY id DESC LIMIT 1`,
  ).first();

  return json(
    {
      freeOnly: true,
      generatedAt: new Date().toISOString(),
      count: items.length,
      latestRun,
      items,
    },
    200,
    headers,
  );
}

async function runIngestion(env: Env, scheduledAt?: string): Promise<IngestionResult> {
  const startedAt = scheduledAt ?? new Date().toISOString();
  const sources = getFeeds(env).slice(0, 12);
  const collected = await collectInBatches(sources, 4);

  const errors = collected
    .filter((entry) => entry.error)
    .map((entry) => ({ source: entry.source, message: entry.error ?? "Unknown error" }));

  const candidates = uniqueCandidates(
    collected
      .flatMap((entry) => entry.items)
      .filter(isLikelyAiNews)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
  );

  const maxItems = clampInteger(env.MAX_ITEMS_PER_RUN, 30, 1, 40);
  const selected = candidates.slice(0, maxItems).map(enrichWithoutAi);
  const collectedAt = new Date().toISOString();

  let stored = 0;
  if (selected.length) {
    const statements = selected.map((item) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO news_items (
           source_platform, external_id, source_name, source_author, source_url,
           raw_title, raw_text, ai_headline, ai_summary, company, model_names,
           category, verification_status, importance_score, dedupe_key,
           published_at, collected_at, metadata_json
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
      ).bind(
        item.sourcePlatform,
        item.externalId,
        item.sourceName,
        item.sourceUrl,
        truncate(item.title, 500),
        truncate(item.text, 4000),
        truncate(item.title, 300),
        truncate(item.summary, 1000),
        item.company ?? null,
        JSON.stringify(item.modelNames),
        item.category,
        item.verification,
        item.importanceScore,
        item.dedupeKey,
        item.publishedAt,
        collectedAt,
      ),
    );

    const results = await env.DB.batch(statements);
    stored = results.reduce((total, result) => total + Number(result.meta.changes ?? 0), 0);
  }

  const retentionDays = clampInteger(env.RETENTION_DAYS, 45, 7, 180);
  await env.DB.prepare(
    `DELETE FROM news_items WHERE published_at < datetime('now', ?)`
  ).bind(`-${retentionDays} days`).run();

  const completedAt = new Date().toISOString();
  const status: IngestionResult["status"] =
    errors.length === 0 ? "success" : selected.length > 0 ? "partial" : "failed";

  await env.DB.prepare(
    `INSERT INTO ingestion_runs (
       started_at, completed_at, status, fetched_count, stored_count, error_json
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      startedAt,
      completedAt,
      status,
      candidates.length,
      stored,
      JSON.stringify(errors),
    )
    .run();

  const result: IngestionResult = {
    status,
    fetched: candidates.length,
    stored,
    errors,
    startedAt,
    completedAt,
  };
  console.log(JSON.stringify({ event: "free_news_ingestion_complete", ...result }));
  return result;
}

async function collectInBatches(
  sources: FeedSource[],
  batchSize: number,
): Promise<Array<{ source: string; items: NewsCandidate[]; error?: string }>> {
  const results: Array<{ source: string; items: NewsCandidate[]; error?: string }> = [];

  for (let index = 0; index < sources.length; index += batchSize) {
    const batch = sources.slice(index, index + batchSize);
    const settled = await Promise.allSettled(batch.map(collectFeed));
    settled.forEach((entry, entryIndex) => {
      const source = batch[entryIndex].name;
      if (entry.status === "fulfilled") results.push({ source, items: entry.value });
      else {
        const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
        console.error(`Feed ${source} failed`, entry.reason);
        results.push({ source, items: [], error: message });
      }
    });
  }

  return results;
}

async function collectFeed(source: FeedSource): Promise<NewsCandidate[]> {
  const response = await fetch(source.url, {
    headers: {
      Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "VibeSpaceNews/1.0 (+https://vibespaceos.com)",
    },
    redirect: "follow",
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 2_000_000) throw new Error("Feed is larger than 2 MB");

  const xml = (await response.text()).slice(0, 2_000_000);
  const blocks = [...extractBlocks(xml, "item"), ...extractBlocks(xml, "entry")].slice(0, 12);

  return blocks.flatMap((block, index) => {
    const title = cleanText(readTag(block, ["title"]));
    const url = readAtomLink(block) || cleanText(readTag(block, ["link"]));
    const id = cleanText(readTag(block, ["guid", "id"])) || url || `${source.url}#${index}`;
    const text = cleanText(readTag(block, ["description", "summary", "content:encoded", "content"]));
    const publishedAt = normalizeDate(readTag(block, ["pubDate", "published", "updated", "dc:date"]));

    if (!title || !url) return [];
    return [
      {
        sourcePlatform: source.platform,
        externalId: id,
        sourceName: source.name,
        sourceUrl: url,
        title,
        text,
        company: source.company ?? inferCompany(`${title} ${text}`),
        publishedAt,
        verification: source.verification,
      } satisfies NewsCandidate,
    ];
  });
}

function enrichWithoutAi(item: NewsCandidate): StoredNews {
  const combined = `${item.title} ${item.text}`;
  return {
    ...item,
    summary: truncate(item.text || item.title, 500),
    category: inferCategory(combined, item.sourcePlatform),
    modelNames: findModelNames(combined),
    importanceScore: scoreImportance(item, combined),
    dedupeKey: hashString(`${normalize(item.title)}|${normalize(item.company ?? "")}`),
  };
}

function getFeeds(env: Env): FeedSource[] {
  const extras = parseExtraFeeds(env.EXTRA_FEEDS);
  const seen = new Set<string>();
  return [...DEFAULT_FEEDS, ...extras].filter((feed) => {
    if (!feed.name || !feed.url || seen.has(feed.url)) return false;
    if (!feed.url.startsWith("https://")) return false;
    seen.add(feed.url);
    return true;
  });
}

function parseExtraFeeds(value?: string): FeedSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      if (typeof value.name !== "string" || typeof value.url !== "string") return [];
      const platform: Platform =
        value.platform === "release" || value.platform === "media" ? value.platform : "official";
      const verification: Verification = value.verification === "confirmed" ? "confirmed" : "official";
      return [{
        name: value.name.slice(0, 100),
        url: value.url,
        company: typeof value.company === "string" ? value.company.slice(0, 100) : undefined,
        platform,
        verification,
      }];
    });
  } catch {
    return [];
  }
}

function uniqueCandidates(items: NewsCandidate[]): NewsCandidate[] {
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  return items.filter((item) => {
    const titleKey = normalize(item.title);
    if (!item.sourceUrl || seenUrls.has(item.sourceUrl) || seenTitles.has(titleKey)) return false;
    seenUrls.add(item.sourceUrl);
    seenTitles.add(titleKey);
    return true;
  });
}

function isLikelyAiNews(item: NewsCandidate): boolean {
  if (item.sourceName !== "AI Model News") return true;
  const text = ` ${item.title} ${item.text} `.toLowerCase();
  return [
    " ai ", "artificial intelligence", "model", "llm", "openai", "anthropic", "claude",
    "gemini", "deepseek", "qwen", "mistral", "grok", "llama",
  ].some((term) => text.includes(term));
}

function inferCategory(text: string, platform: Platform): string {
  const value = text.toLowerCase();
  if (platform === "release" || /\b(release|launch|introduc|announce|new model|model update)\b/.test(value)) {
    return "model-release";
  }
  if (/\b(research|paper|benchmark|evaluation|study|arxiv)\b/.test(value)) return "research";
  if (/\b(api|sdk|developer|framework|agent|coding|tool|library)\b/.test(value)) return "developer-tools";
  if (/\b(safety|security|policy|regulation|governance)\b/.test(value)) return "safety-policy";
  if (/\b(partner|funding|acquire|business|enterprise)\b/.test(value)) return "business";
  return "general";
}

function inferCompany(text: string): string | undefined {
  const matchers: Array<[RegExp, string]> = [
    [/\bopenai\b|\bchatgpt\b|\bcodex\b/i, "OpenAI"],
    [/\banthropic\b|\bclaude\b/i, "Anthropic"],
    [/\bdeepmind\b/i, "Google DeepMind"],
    [/\bgemini\b|\bgoogle ai\b/i, "Google"],
    [/\bxai\b|\bgrok\b/i, "xAI"],
    [/\bmeta ai\b|\bllama\b/i, "Meta"],
    [/\bdeepseek\b/i, "DeepSeek"],
    [/\bqwen\b|\balibaba\b/i, "Alibaba"],
    [/\bmistral\b/i, "Mistral AI"],
    [/\bhugging face\b|\bhuggingface\b/i, "Hugging Face"],
    [/\bnvidia\b/i, "NVIDIA"],
  ];
  return matchers.find(([pattern]) => pattern.test(text))?.[1];
}

function findModelNames(text: string): string[] {
  const names = new Set<string>();
  for (const [pattern, family] of MODEL_PATTERNS) {
    const matches = text.match(pattern) ?? [];
    for (const match of matches.slice(0, 3)) names.add(match.trim() || family);
  }
  return [...names].slice(0, 8);
}

function scoreImportance(item: NewsCandidate, text: string): number {
  let score = item.verification === "official" ? 75 : 55;
  if (item.sourcePlatform === "release") score += 10;
  if (/\b(release|launch|introducing|available now|new model)\b/i.test(text)) score += 10;
  if (/\b(frontier|major|breakthrough|state[- ]of[- ]the[- ]art)\b/i.test(text)) score += 5;
  return Math.min(100, score);
}

function extractBlocks(xml: string, tag: string): string[] {
  const expression = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return xml.match(expression) ?? [];
}

function readTag(block: string, tags: string[]): string {
  for (const tag of tags) {
    const expression = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, "i");
    const match = block.match(expression);
    if (match?.[1]) return match[1];
  }
  return "";
}

function readAtomLink(block: string): string {
  const preferred = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (preferred?.[1]) return decodeEntities(preferred[1]);
  const any = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return any?.[1] ? decodeEntities(any[1]) : "";
}

function cleanText(value: string): string {
  return decodeEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return value
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function normalizeDate(value: string): string {
  const timestamp = Date.parse(cleanText(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 300);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampInteger(value: string | null | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function safeJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function countNews(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM news_items").first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function corsHeaders(env: Env): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
  });
}

function json(payload: unknown, status: number, baseHeaders: Headers): Response {
  const headers = new Headers(baseHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status, headers });
}
