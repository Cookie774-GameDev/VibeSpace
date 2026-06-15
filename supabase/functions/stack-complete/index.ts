// @ts-nocheck
// stack-complete: subscription-hosted frontier models for Vibe Hive steps.
// Auth → plan budget reserve → provider allowlist → stream SSE to client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import {
  estimateMessageCostUsd,
  MAX_PROMPT_CHARS,
} from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const PROVIDER_KEYS: Record<string, string | undefined> = {
  openai: Deno.env.get('OPENAI_API_KEY'),
  anthropic: Deno.env.get('ANTHROPIC_API_KEY'),
  google: Deno.env.get('GOOGLE_API_KEY') ?? Deno.env.get('GEMINI_API_KEY'),
  deepseek: Deno.env.get('DEEPSEEK_API_KEY'),
  groq: Deno.env.get('GROQ_API_KEY'),
  mistral: Deno.env.get('MISTRAL_API_KEY'),
  xai: Deno.env.get('XAI_API_KEY'),
  openrouter: Deno.env.get('OPENROUTER_API_KEY'),
};

const ALLOWED: Record<string, Set<string>> = {
  openai: new Set([
    'gpt-5.5',
    'gpt-5.5-pro',
    'gpt-5.5-codex',
    'gpt-4o',
    'gpt-4o-mini',
    'o4-mini',
  ]),
  anthropic: new Set([
    'claude-opus-4-8',
    'claude-fable-5',
    'claude-sonnet-4-20250514',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-latest',
  ]),
  google: new Set([
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
  ]),
  deepseek: new Set([
    'deepseek-v4-pro',
    'deepseek-v4-flash',
    'deepseek-chat',
    'deepseek-reasoner',
  ]),
  groq: new Set(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']),
  mistral: new Set(['mistral-large-latest']),
  xai: new Set(['grok-4.3', 'grok-4.20-multi-agent-0309', 'grok-2-1212', 'grok-3']),
  openrouter: new Set([
    'anthropic/claude-3.5-sonnet',
    'perplexity/sonar',
    'moonshotai/kimi-k2.6',
    'moonshotai/kimi-k2',
    'qwen/qwen-3.7-max',
  ]),
};

const OPENAI_COMPAT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 40;
const PROVIDER_TIMEOUT_MS = 90_000;
const EST_COMPLETION_TOKENS = 1200;

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function sseLine(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

async function streamOpenAICompatible(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<ReadableStream<Uint8Array>> {
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
    signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
  });
  if (!upstream.ok || !upstream.body) {
    const err = upstream.body ? await upstream.text() : 'upstream_error';
    throw new Error(err.slice(0, 200));
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(new TextEncoder().encode(
            sseLine({
              done: true,
              usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
            }),
          ));
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const j = JSON.parse(raw);
            const delta = j.choices?.[0]?.delta?.content ?? '';
            if (delta) controller.enqueue(new TextEncoder().encode(sseLine({ delta })));
            if (j.usage) {
              promptTokens = j.usage.prompt_tokens ?? promptTokens;
              completionTokens = j.usage.completion_tokens ?? completionTokens;
            }
          } catch {
            // skip
          }
        }
      }
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }

  const provider = String(body.provider ?? 'deepseek');
  const requestedModel = String(body.model ?? '');
  const allow = ALLOWED[provider];
  if (!allow) return json({ error: 'provider_not_allowed' }, 400, origin);
  const model = [...allow].find((m) => m === requestedModel) ?? [...allow][0];
  const apiKey = PROVIDER_KEYS[provider];
  if (!apiKey) return json({ error: 'provider_not_configured', fallback: 'byok_or_local' }, 503, origin);

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = String(body.system ?? '');
  const chatMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;
  const promptChars = JSON.stringify(chatMessages).length;
  if (promptChars > MAX_PROMPT_CHARS) return json({ error: 'prompt_too_long' }, 413, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: appAdminFlag } = await admin.rpc('is_app_admin', { p_user_id: userId });
  const appAdmin = Boolean(appAdminFlag);

  const windowStart = new Date(Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString();
  const { data: rl, error: rlErr } = await admin.rpc('message_rate_limit_hit', {
    p_user_id: userId, p_window_start: windowStart, p_chars: promptChars, p_max_requests: RATE_MAX,
  });
  if (rlErr) return json({ error: 'usage_unavailable' }, 503, origin);
  if ((rl as { limited?: boolean } | null)?.limited) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  const estPromptTokens = Math.ceil(promptChars / 4);
  const estCost = estimateMessageCostUsd(estPromptTokens, EST_COMPLETION_TOKENS);
  if (!appAdmin) {
    const { data: reservation, error: reserveErr } = await admin
      .rpc('reserve_message_budget', { p_user_id: userId, p_estimate_usd: estCost });
    if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
    const reserved = reservation as { ok: boolean; reason?: string } | null;
    if (!reserved?.ok) {
      return json({ error: 'budget_exceeded', reason: reserved?.reason ?? 'budget', fallback: 'byok_or_local' }, 402, origin);
    }
  }

  const url = OPENAI_COMPAT_URLS[provider];
  if (!url) return json({ error: 'provider_not_implemented' }, 501, origin);

  try {
    const stream = await streamOpenAICompatible(url, apiKey, {
      model,
      messages: chatMessages,
      temperature: body.temperature ?? 0.5,
      max_tokens: body.max_tokens ?? 4096,
    });
    if (!appAdmin) {
      await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: estCost });
    }
    await admin.rpc('record_usage_event', {
      p_kind: 'stack',
      p_user_id: userId,
      p_payload: { provider, model, status: 'ok', estimated_cost_usd: estCost },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...json({}, 200, origin).headers,
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  } catch (e) {
    if (!appAdmin) {
      await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    }
    return json({ error: 'provider_unavailable', message: String(e) }, 502, origin);
  }
});
