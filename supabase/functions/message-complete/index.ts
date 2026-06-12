// @ts-nocheck
// message-complete: metered company-paid AI message completion.
//
// Free users + BYOK/local routes do NOT come here (the client uses its own
// key/local model). This endpoint is only for company-paid hosted inference:
//   auth -> validate -> rate-limit -> check plan -> reserve budget atomically
//   -> call provider -> settle actual cost -> record event.
// On any failure returns a safe coded error so the client can fall back to a
// cheaper/local/BYOK route.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import { estimateMessageCostUsd, MAX_PROMPT_CHARS } from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const PROVIDER_TIMEOUT_MS = 60_000;

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
  const model = String(body.model ?? 'gpt-4o-mini');
  if (!messages || messages.length === 0) return json({ error: 'empty_messages' }, 400, origin);
  const promptChars = JSON.stringify(messages).length;
  if (promptChars > MAX_PROMPT_CHARS) return json({ error: 'prompt_too_long' }, 413, origin);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Rate limit
  const windowStart = new Date(Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS).toISOString();
  const { data: rl, error: rlErr } = await admin.rpc('message_rate_limit_hit', {
    p_user_id: userId, p_window_start: windowStart, p_chars: promptChars, p_max_requests: RATE_MAX,
  });
  // Dedicated message-window RPC (0015) so message traffic no longer consumes the voice window.
  // Fail closed on RPC errors so a broken limiter cannot be bypassed.
  if (rlErr) return json({ error: 'usage_unavailable' }, 503, origin);
  if ((rl as { limited?: boolean } | null)?.limited) {
    return json({ error: 'rate_limited' }, 429, origin);
  }

  // Reserve budget from an estimate (~prompt tokens + assumed completion).
  const estPromptTokens = Math.ceil(promptChars / 4);
  const estCost = estimateMessageCostUsd(estPromptTokens, 800);
  const { data: reservation, error: reserveErr } = await admin
    .rpc('reserve_message_budget', { p_user_id: userId, p_estimate_usd: estCost });
  if (reserveErr) return json({ error: 'usage_unavailable' }, 500, origin);
  const reserved = reservation as { ok: boolean; reason?: string } | null;
  if (!reserved?.ok) {
    await admin.rpc('record_usage_event', {
      p_kind: 'message', p_user_id: userId,
      p_payload: { provider: 'openai', model, status: 'blocked', error_code: reserved?.reason ?? 'budget' },
    });
    return json({ error: 'budget_exceeded', reason: reserved?.reason ?? 'budget', fallback: 'byok_or_local' }, 402, origin);
  }

  if (!OPENAI_API_KEY) {
    await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    return json({ error: 'provider_unconfigured', fallback: 'byok_or_local' }, 503, origin);
  }

  let upstream: Response;
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages }),
      signal: timeoutSignal(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    return json({ error: 'provider_unavailable', fallback: 'byok_or_local' }, 502, origin);
  }

  if (!upstream.ok) {
    await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: 0 });
    await admin.rpc('record_usage_event', {
      p_kind: 'message', p_user_id: userId,
      p_payload: { provider: 'openai', model, status: 'error', error_code: `provider_${upstream.status}` },
    });
    return json({ error: 'provider_error', fallback: 'byok_or_local' }, 502, origin);
  }

  const result = await upstream.json();
  const usage = result.usage ?? {};
  const actualCost = estimateMessageCostUsd(usage.prompt_tokens ?? estPromptTokens, usage.completion_tokens ?? 800);
  await admin.rpc('settle_message_budget', { p_user_id: userId, p_reserved: estCost, p_actual: actualCost });
  await admin.rpc('record_usage_event', {
    p_kind: 'message', p_user_id: userId,
    p_payload: {
      provider: 'openai', model,
      prompt_tokens: usage.prompt_tokens ?? estPromptTokens,
      completion_tokens: usage.completion_tokens ?? 0,
      estimated_cost_usd: estCost, actual_cost_usd: actualCost, status: 'ok',
    },
  });

  return json({ message: result.choices?.[0]?.message ?? null, usage }, 200, origin);
});
