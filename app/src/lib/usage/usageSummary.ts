import { db, openDb } from '@/lib/db';
import type { ProviderId } from '@/types';

export interface UsageSummaryInput {
  provider: ProviderId;
  apiKey?: string;
  providerLabel: string;
}

export interface LocalUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  calls: number;
  lastUsed: number | null;
}

interface LiveOpenAiUsage {
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
  source: 'live' | 'unavailable';
  error?: string;
}

interface LiveOpenRouterUsage {
  usageUsd: number | null;
  usageMonthlyUsd: number | null;
  usageDailyUsd: number | null;
  limitUsd: number | null;
  remainingUsd: number | null;
  reset: string | null;
  label: string | null;
  source: 'live' | 'unavailable';
  error?: string;
}

export function monthStartMs(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

const EMPTY_USAGE: LocalUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  calls: 0,
  lastUsed: null,
};

function emptyUsageTotals(): LocalUsageTotals {
  return { ...EMPTY_USAGE };
}

function monthStartSeconds(): number {
  return Math.floor(monthStartMs() / 1000);
}

function usd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

async function getLocalUsage(provider: ProviderId): Promise<LocalUsageTotals> {
  await openDb();
  const start = monthStartMs();
  const messages = await db.messages.toArray();
  return summarizeLocalProviderUsage(messages, provider, start);
}

type UsageMessage = {
  created_at: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_usd?: number;
    provider?: ProviderId;
  };
};

function accumulateUsageTotals(
  totals: LocalUsageTotals,
  message: UsageMessage,
  provider: ProviderId,
  sinceMs: number,
): void {
  if (message.created_at < sinceMs) return;
  const usage = message.usage;
  if (!usage) return;
  if (usage.provider && usage.provider !== provider) return;

  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cachedTokens += (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
  totals.costUsd += usage.cost_usd ?? 0;
  totals.calls += 1;
  totals.lastUsed = Math.max(totals.lastUsed ?? 0, message.created_at);
}

export function summarizeLocalProviderUsage(
  messages: UsageMessage[],
  provider: ProviderId,
  sinceMs = monthStartMs(),
): LocalUsageTotals {
  const totals = emptyUsageTotals();
  for (const message of messages) {
    accumulateUsageTotals(totals, message, provider, sinceMs);
  }
  return totals;
}

/** Single-pass monthly usage rollup for every BYOK provider row in Settings. */
export function summarizeAllLocalProviderUsage(
  messages: UsageMessage[],
  providers: readonly ProviderId[],
  sinceMs = monthStartMs(),
): Partial<Record<ProviderId, LocalUsageTotals>> {
  const totals = Object.fromEntries(
    providers.map((provider) => [provider, emptyUsageTotals()]),
  ) as Record<ProviderId, LocalUsageTotals>;

  for (const message of messages) {
    if (message.created_at < sinceMs) continue;
    const usage = message.usage;
    const provider = usage?.provider;
    if (!usage || !provider || !totals[provider]) continue;

    const bucket = totals[provider];
    bucket.inputTokens += usage.input_tokens ?? 0;
    bucket.outputTokens += usage.output_tokens ?? 0;
    bucket.cachedTokens += (usage.cache_read_tokens ?? 0) + (usage.cache_write_tokens ?? 0);
    bucket.costUsd += usage.cost_usd ?? 0;
    bucket.calls += 1;
    bucket.lastUsed = Math.max(bucket.lastUsed ?? 0, message.created_at);
  }

  return totals;
}

function sumOpenAiUsageBucket(
  payload: unknown,
): Pick<LiveOpenAiUsage, 'inputTokens' | 'outputTokens' | 'requests'> {
  const buckets = Array.isArray((payload as { data?: unknown[] })?.data)
    ? (payload as { data: unknown[] }).data
    : [];

  let inputTokens = 0;
  let outputTokens = 0;
  let requests = 0;

  for (const bucket of buckets) {
    const results = Array.isArray((bucket as { results?: unknown[] })?.results)
      ? (bucket as { results: unknown[] }).results
      : [];
    for (const result of results) {
      const row = result as Record<string, unknown>;
      inputTokens += Number(row.input_tokens ?? row.prompt_tokens ?? 0);
      outputTokens += Number(row.output_tokens ?? row.completion_tokens ?? 0);
      requests += Number(row.num_model_requests ?? row.requests ?? 0);
    }
  }

  return { inputTokens, outputTokens, requests };
}

function sumOpenAiCosts(payload: unknown): number | null {
  const buckets = Array.isArray((payload as { data?: unknown[] })?.data)
    ? (payload as { data: unknown[] }).data
    : [];

  let total = 0;
  let sawAmount = false;

  for (const bucket of buckets) {
    const results = Array.isArray((bucket as { results?: unknown[] })?.results)
      ? (bucket as { results: unknown[] }).results
      : [];
    for (const result of results) {
      const row = result as Record<string, unknown>;
      const amount = row.amount as { value?: unknown } | undefined;
      const value = Number(amount?.value ?? row.amount_usd ?? row.cost_usd ?? 0);
      if (Number.isFinite(value) && value !== 0) {
        total += value;
        sawAmount = true;
      }
    }
  }

  return sawAmount ? total : null;
}

async function fetchOpenAiLiveUsage(apiKey: string): Promise<LiveOpenAiUsage> {
  const params = new URLSearchParams({
    start_time: String(monthStartSeconds()),
    end_time: String(Math.floor(Date.now() / 1000)),
    bucket_width: '1d',
    limit: '31',
  });
  params.append('group_by[]', 'model');

  const headers = { Authorization: `Bearer ${apiKey}` };
  const [usageRes, costRes] = await Promise.all([
    fetch(`https://api.openai.com/v1/organization/usage/completions?${params.toString()}`, {
      headers,
    }),
    fetch(`https://api.openai.com/v1/organization/costs?${params.toString()}`, { headers }),
  ]);

  if (!usageRes.ok) {
    const errorText = await usageRes.text().catch(() => usageRes.statusText);
    return {
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      costUsd: null,
      source: 'unavailable',
      error: `OpenAI usage API returned ${usageRes.status}: ${errorText.slice(0, 180)}`,
    };
  }

  const usagePayload = await usageRes.json();
  const usageTotals = sumOpenAiUsageBucket(usagePayload);
  let costUsd: number | null = null;

  if (costRes.ok) {
    costUsd = sumOpenAiCosts(await costRes.json());
  }

  return {
    ...usageTotals,
    costUsd,
    source: 'live',
  };
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function fetchOpenRouterLiveUsage(apiKey: string): Promise<LiveOpenRouterUsage> {
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    return {
      usageUsd: null,
      usageMonthlyUsd: null,
      usageDailyUsd: null,
      limitUsd: null,
      remainingUsd: null,
      reset: null,
      label: null,
      source: 'unavailable',
      error: `OpenRouter key usage API returned ${response.status}: ${errorText.slice(0, 180)}`,
    };
  }

  const payload = await response.json();
  const data = (payload as { data?: Record<string, unknown> })?.data ?? {};
  return {
    usageUsd: numberOrNull(data.usage),
    usageMonthlyUsd: numberOrNull(data.usage_monthly),
    usageDailyUsd: numberOrNull(data.usage_daily),
    limitUsd: numberOrNull(data.limit),
    remainingUsd: numberOrNull(data.limit_remaining),
    reset: stringOrNull(data.limit_reset),
    label: stringOrNull(data.label),
    source: 'live',
  };
}

export async function buildUsageSummary({
  provider,
  apiKey,
  providerLabel,
}: UsageSummaryInput): Promise<string> {
  const local = await getLocalUsage(provider);
  const hasKey = Boolean(apiKey?.trim());

  const lines = [
    `Usage for ${providerLabel}`,
    `Period: current calendar month`,
    '',
    `Local recorded calls: ${local.calls}`,
    `Local recorded tokens: ${local.inputTokens.toLocaleString()} input + ${local.outputTokens.toLocaleString()} output`,
    `Local estimated cost: ${usd(local.costUsd)}`,
  ];

  if (!hasKey) {
    lines.push('', 'Live provider usage: no linked API key for this provider.');
    return lines.join('\n');
  }

  if (provider === 'openrouter') {
    const live = await fetchOpenRouterLiveUsage(apiKey!.trim());
    lines.push('');
    if (live.source === 'live') {
      lines.push(
        'Live OpenRouter key usage:',
        `Key: ${live.label ?? 'current key'}`,
        `Current usage: ${live.usageUsd === null ? 'not reported' : usd(live.usageUsd)}`,
        `Monthly usage: ${live.usageMonthlyUsd === null ? 'not reported' : usd(live.usageMonthlyUsd)}`,
        `Daily usage: ${live.usageDailyUsd === null ? 'not reported' : usd(live.usageDailyUsd)}`,
        `Limit remaining: ${live.remainingUsd === null ? 'unlimited or not reported' : usd(live.remainingUsd)}`,
        `Limit: ${live.limitUsd === null ? 'unlimited or not reported' : usd(live.limitUsd)}${live.reset ? ` (${live.reset})` : ''}`,
      );
    } else {
      lines.push(
        'Live OpenRouter key usage: unavailable',
        live.error ?? 'The linked key could not read OpenRouter key usage.',
      );
    }
    return lines.join('\n');
  }

  if (provider !== 'openai') {
    lines.push(
      '',
      `Live provider usage: ${providerLabel} does not expose a compatible account-usage API through this BYOK key in Jarvis yet.`,
      'Jarvis is showing locally recorded provider usage from completed assistant replies.',
    );
    return lines.join('\n');
  }

  const live = await fetchOpenAiLiveUsage(apiKey!.trim());
  lines.push('');

  if (live.source === 'live') {
    lines.push(
      'Live OpenAI organization usage:',
      `Requests: ${live.requests.toLocaleString()}`,
      `Tokens: ${live.inputTokens.toLocaleString()} input + ${live.outputTokens.toLocaleString()} output`,
      `Costs endpoint: ${live.costUsd === null ? 'available but no billable amount returned' : usd(live.costUsd)}`,
    );
  } else {
    lines.push(
      'Live OpenAI organization usage: unavailable',
      live.error ?? 'The linked key could not read organization usage.',
    );
  }

  return lines.join('\n');
}
