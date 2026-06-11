// @ts-nocheck
//
// jarvis-proxy: hosted DeepSeek proxy for the $5/mo Jarvis tier.
//
// Pipeline:
//   1. Verify the caller's JWT and resolve their auth user.
//   2. Look up tier + monthly_quota from public.profiles.
//   3. Count this calendar month's `ok` requests; reject with 429 once
//      the quota is exhausted (skipped for byok-only tier).
//   4. Forward the body to api.deepseek.com/chat/completions using the
//      platform key from the DEEPSEEK_API_KEY secret.
//   5. Tee the upstream stream: one branch streams to the client, the
//      other parses usage and inserts a usage_log row.
//
// This file runs in Supabase's Deno runtime, not Node. The `@ts-nocheck`
// pragma keeps Vite's tsc from choking on the URL imports if the parent
// tsconfig ever picks the file up.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY')!;

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

// Approximate DeepSeek pricing per million tokens (as of late 2025).
// Refresh from https://api-docs.deepseek.com/quick_start/pricing if it drifts.
const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
};

// Restrictive CORS, matching _shared/voice.ts: only the desktop app's
// origins are allowed (never `*` — this endpoint spends platform budget).
const ALLOWED_ORIGINS = new Set<string>([
  'tauri://localhost',
  'http://localhost:1420',
  'http://localhost:5173',
  'https://tauri.localhost',
]);

function corsHeadersFor(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'tauri://localhost';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'vary': 'Origin',
  };
}

// Refreshed per-request. Concurrent interleaving can only ever swap one
// allow-listed origin for another, so this stays safe under load.
let corsHeaders: Record<string, string> = corsHeadersFor(null);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  corsHeaders = corsHeadersFor(req.headers.get('origin'));
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  // ---- 1. Authenticate ------------------------------------------------------
  const authHeader = req.headers.get('Authorization') || req.headers.get('authorization');
  const jwt = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) {
    return jsonResponse(
      { error: 'unauthorized', message: 'Missing Authorization: Bearer <jwt>.' },
      401,
    );
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user) {
    return jsonResponse(
      { error: 'unauthorized', message: 'Invalid or expired session.' },
      401,
    );
  }
  const userId = userData.user.id;

  // Service-role client bypasses RLS for trusted operations
  // (profile lookup, usage_log inserts).
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- 2. Profile lookup ----------------------------------------------------
  const { data: profile } = await adminClient
    .from('profiles')
    .select('tier, monthly_quota')
    .eq('id', userId)
    .maybeSingle();

  const tier: string = profile?.tier ?? 'free';
  const monthlyQuota: number = profile?.monthly_quota ?? 50;

  // ---- 3. Quota check (skipped for byok-only) -------------------------------
  let usedThisMonth = 0;
  if (tier !== 'byok-only') {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const { count } = await adminClient
      .from('usage_log')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'ok')
      .gte('ts', monthStart.toISOString());

    usedThisMonth = count ?? 0;
    if (usedThisMonth >= monthlyQuota) {
      // Record the rejection so the client's progress bar reflects reality.
      await adminClient.from('usage_log').insert({
        user_id: userId,
        provider: 'deepseek',
        model: 'deepseek-chat',
        status: 'rate_limit',
      });
      return jsonResponse(
        {
          error: 'rate_limit',
          message:
            `You've used ${usedThisMonth} of ${monthlyQuota} hosted requests this month. ` +
            `Upgrade to Plus or switch to BYOK in settings.`,
          used: usedThisMonth,
          quota: monthlyQuota,
        },
        429,
      );
    }
  }

  // ---- 4. Parse + forward the request --------------------------------------
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
  }

  const model = String(body.model ?? 'deepseek-chat');
  body.model = model;

  // Ask DeepSeek to include usage in the final SSE chunk for streamed runs.
  const isStreaming = body.stream === true;
  if (isStreaming) {
    const existing = (body.stream_options as Record<string, unknown> | undefined) ?? {};
    body.stream_options = { ...existing, include_usage: true };
  }

  const startMs = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    await adminClient.from('usage_log').insert({
      user_id: userId,
      provider: 'deepseek',
      model,
      status: 'error',
      latency_ms: Date.now() - startMs,
    });
    return jsonResponse(
      { error: 'upstream_unavailable', message: String(e) },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const errText = upstream.body ? await upstream.text() : '';
    await adminClient.from('usage_log').insert({
      user_id: userId,
      provider: 'deepseek',
      model,
      status: 'error',
      latency_ms: Date.now() - startMs,
    });
    return new Response(errText || JSON.stringify({ error: 'upstream_error' }), {
      status: upstream.status || 502,
      headers: {
        ...corsHeaders,
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      },
    });
  }

  // ---- 5. Tee the stream: one to client, one for usage parsing -------------
  const [clientStream, logStream] = upstream.body.tee();

  const logTask = (async () => {
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let raw = '';

    try {
      const reader = logStream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }

      if (isStreaming) {
        // SSE: scan for the chunk that carries usage.
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.usage) {
              promptTokens = j.usage.prompt_tokens ?? promptTokens;
              completionTokens = j.usage.completion_tokens ?? completionTokens;
            }
          } catch {
            // Ignore malformed chunk - DeepSeek occasionally sends keepalives.
          }
        }
      } else {
        try {
          const j = JSON.parse(raw);
          if (j.usage) {
            promptTokens = j.usage.prompt_tokens ?? null;
            completionTokens = j.usage.completion_tokens ?? null;
          }
        } catch {
          // Non-JSON body (rare) - leave token counts null.
        }
      }
    } catch {
      // Stream parsing failed; still log the request as ok since the user
      // received the response.
    }

    const pricing = PRICING[model] ?? PRICING['deepseek-chat'];
    let costUsd: number | null = null;
    if (promptTokens != null && completionTokens != null) {
      costUsd =
        (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
    }

    await adminClient.from('usage_log').insert({
      user_id: userId,
      provider: 'deepseek',
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      cost_usd: costUsd,
      status: 'ok',
      latency_ms: Date.now() - startMs,
    });
  })();

  // Keep the worker alive until logging finishes without blocking the
  // streamed response. Fall back to fire-and-forget on runtimes without
  // EdgeRuntime (e.g. local `supabase functions serve` may differ).
  // @ts-ignore - EdgeRuntime is only present on Supabase / Deno Deploy.
  const er = typeof EdgeRuntime !== 'undefined' ? EdgeRuntime : null;
  if (er && typeof er.waitUntil === 'function') {
    er.waitUntil(logTask);
  } else {
    void logTask;
  }

  const respHeaders = new Headers(corsHeaders);
  const upstreamCT = upstream.headers.get('content-type');
  if (upstreamCT) respHeaders.set('content-type', upstreamCT);
  // Hint to the client that this is a streaming response (so fetch readers
  // process chunks as they arrive).
  if (isStreaming) respHeaders.set('cache-control', 'no-cache, no-transform');

  return new Response(clientStream, {
    status: upstream.status,
    headers: respHeaders,
  });
});
