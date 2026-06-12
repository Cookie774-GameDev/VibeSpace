// @ts-nocheck
// message-complete: metered company-paid AI message completion (DeepSeek V4 Flash).
//
// Free users + BYOK/local routes do NOT come here (the client uses its own
// key/local model). This endpoint is only for company-paid hosted inference:
//   auth -> validate -> provider configured? -> rate-limit (fail closed)
//   -> admin? skip budget : reserve budget atomically (monthly + weekly + 5h
//   windows enforced in the RPC) -> call DeepSeek -> settle actual cost
//   -> record event.
// On any failure returns a safe coded error so the client can fall back to a
// cheaper/local/BYOK route.
//
// App admins (app_admins table) bypass quota reservation but the response is
// otherwise identical. Admin chat normally uses BYOK keys client-side and
// never reaches this endpoint.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import {
  deepseekActualCostUsd,
  estimateMessageCostUsd,
  MAX_PROMPT_CHARS,
} from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
// `deepseek-chat` aliases V4-Flash. Server-side allowlist: the client cannot
// pick an arbitrary (more expensive) model.
const ALLOWED_MODELS = new Set(['deepseek-chat']);
const DEFAULT_MODEL = 'deepseek-chat';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const PROVIDER_TIMEOUT_MS = 60_000;
const EST_COMPLETION_TOKENS = 800;

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
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
  const messages = Array.isArray(body.messages) ? body.messages : null;
  const requestedModel = String(body.model ?? DEFAULT_MODEL);
  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;
  if (!messages || messages.length === 0) return json({ error: 'empty_messages' }, 400, origin);
  const promptChars = JSON.stringify(messages).length;
  if (promptChars > MAX_PROMPT_CHARS) return json({ error: 'prompt_too_long' }, 413, origin);

  // Provider key is provisioned separately; fail fast with a clear code so the
  // client falls back to BYOK/local. Checked before reserving any budget.
  if (!DEEPSEEK_API_KEY) {
    return json({ error: 'provider_not_configured', fallback: 'byok_or_local' }, 503, origin);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: appAdminFlag } = await admin.rpc('is_app_admin', { p_user_id: userId });
  const appAdmin = Boolean(appAdminFlag);

  // Rate limit (fail closed: a broken limiter cannot be bypassed).
  const windowStart = new Date(Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString();
  const { data: rl, error: rlErr } = await admin.rpc('message_rate_limit_hit', {
    p_user_id: userId, p_window_start: windowStart, p_chars: promptChars, p_max_requests: RATE_MAX,
  });
  if (rlErr) return json({ error: 'usage_unavailable' }, 503, origin);
  if ((rl as { limited?: boolean } | null)?.limited) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  // Reserve budget from an estimate (~prompt tokens + assumed completion).
  // The RPC enforces monthly + weekly (25%) + 5-hour (8%) windows atomically.
  const estPromptTokens = Math.ceil(promptChars / 4);
  const estCost = estimateMessageCostUsd(estPromptTokens, EST_COMPLETION_TOKENS);
  if (!appAdmin) {
    const { data: reservation, error: reserveErr } = await admin
      .rpc('reserve_message_budget', { p_user_id: userId, p_estimate_usd: estCost });
    if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
    const reserved = reservation as { ok: boolean; reason?: string; remaining_usd?: number; retry_after?: string } | null;
    if (!reserved?.ok) {
      await admin.rpc('record_usage_event', {
        p_kind: 'message', p_user_id: userId,
        p_payload: { provider: 'deepseek', model, status: 'blocked', error_code: reserved?.reason ?? 'budget' },
      });
      const reason = reserved?.reason ?? 'budget';
      const isWindow = reason === 'window_5h_exceeded' || reason === 'window_weekly_exceeded';
      return json(
        {
          error: isWindow ? 'rate_window_exceeded' : 'budget_exceeded',
          reason,
          retry_after: reserved?.retry_after ?? null,
          fallback: 'byok_or_local',
        },
        isWindow ? 429 : 402,
        origin,
      );
    }
  }

  // Streaming-safe: we always request a non-streamed completion so `usage`
  // is present for exact settlement (client streaming is handled locally).
  let upstream: Response;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${DEEPSEEK_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    if (!appAdmin) {
      await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    }
    return json({ error: 'provider_unavailable', fallback: 'byok_or_local' }, 502, origin);
  }

  if (!upstream.ok) {
    if (!appAdmin) {
      await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    }
    await admin.rpc('record_usage_event', {
      p_kind: 'message', p_user_id: userId,
      p_payload: { provider: 'deepseek', model, status: 'error', error_code: `provider_${upstream.status}` },
    });
    return json({ error: 'provider_error', fallback: 'byok_or_local' }, 502, origin);
  }

  let result: Record<string, unknown>;
  try {
    result = await upstream.json();
  } catch {
    if (!appAdmin) {
      await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    }
    return json({ error: 'provider_error', fallback: 'byok_or_local' }, 502, origin);
  }

  const usage = (result.usage ?? {}) as Record<string, number>;
  const actualCost = deepseekActualCostUsd({
    prompt_tokens: usage.prompt_tokens ?? estPromptTokens,
    completion_tokens: usage.completion_tokens ?? EST_COMPLETION_TOKENS,
    prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens,
    prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens,
  });
  if (!appAdmin) {
    await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: actualCost });
  }
  await admin.rpc('record_usage_event', {
    p_kind: 'message', p_user_id: userId,
    p_payload: {
      provider: 'deepseek', model,
      prompt_tokens: usage.prompt_tokens ?? estPromptTokens,
      completion_tokens: usage.completion_tokens ?? 0,
      estimated_cost_usd: appAdmin ? 0 : estCost,
      actual_cost_usd: appAdmin ? 0 : actualCost,
      status: 'ok',
    },
  });

  return json({ message: result.choices?.[0]?.message ?? null, usage }, 200, origin);
});
