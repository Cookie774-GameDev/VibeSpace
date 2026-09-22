// @ts-nocheck
// Authenticated, server-owned telemetry ingest. The client sends only the
// allowlisted schema; account identity and consent come from this function.

import {
  MAX_TELEMETRY_BATCH_BYTES,
  parseTelemetryJson,
  TelemetrySchemaError,
  type TelemetryBatch,
} from '../_shared/telemetrySchema.ts';

const REQUIRED_CLASSES = Object.freeze(['product_usage', 'diagnostics', 'tool_outcomes']);
const ALLOWED_ORIGINS = new Set([
  'https://vibespaceos.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
]);
export const TELEMETRY_RATE_LIMIT_EVENTS_PER_MINUTE = 256;

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://vibespaceos.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'apikey, x-client-info, authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
    'Content-Type': 'application/json',
  };
}

function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), ...extra },
  });
}

function bearer(req: Request): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function exactRequiredClasses(value: unknown): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
  const normalized = [...new Set(value)];
  return (
    value.length === REQUIRED_CLASSES.length &&
    normalized.length === REQUIRED_CLASSES.length &&
    REQUIRED_CLASSES.every((item) => normalized.includes(item))
  );
}

async function readBodyBounded(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TelemetrySchemaError(
          'payload_too_large',
          'Telemetry body exceeds the byte limit.',
        );
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function consentAllowsUpload(consent: any, policyVersion: string): boolean {
  return (
    consent?.enabled === true &&
    consent?.eligible === true &&
    consent?.policyVersion === policyVersion &&
    exactRequiredClasses(consent?.dataClasses)
  );
}

function acceptedEventIds(batch: TelemetryBatch, value: unknown): string[] {
  const allowed = new Set(batch.events.map((event) => event.eventId));
  if (!Array.isArray(value)) throw new Error('Invalid ingest receipt.');
  const ids = [...new Set(value)].filter((id) => typeof id === 'string' && allowed.has(id));
  if (ids.length !== value.length) throw new Error('Invalid ingest receipt.');
  return ids;
}

export async function handleTelemetryIngest(req: Request, deps: any): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401, origin);

  const contentLength = req.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_TELEMETRY_BATCH_BYTES)
  ) {
    return json({ error: 'payload_too_large' }, 413, origin);
  }

  let batch: TelemetryBatch;
  try {
    const raw = await readBodyBounded(req, MAX_TELEMETRY_BATCH_BYTES);
    batch = parseTelemetryJson(raw, { nowMs: deps.nowMs?.() ?? Date.now() });
  } catch (error) {
    if (error instanceof TelemetrySchemaError && error.code === 'payload_too_large') {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
    return json({ error: 'invalid_telemetry_payload' }, 400, origin);
  }

  const consent = await deps.getConsent(user.id).catch(() => null);
  if (!consentAllowsUpload(consent, deps.config.policyVersion)) {
    return json({ error: 'telemetry_consent_required' }, 403, origin);
  }

  let rate: any;
  try {
    rate = await deps.checkRateLimit(user.id, batch.events.length);
  } catch {
    return json({ error: 'telemetry_rate_limit_unavailable' }, 503, origin);
  }
  if (!rate?.allowed) {
    return json(
      {
        error: 'rate_limited',
        retryAfterSeconds: Math.max(1, Number(rate?.retryAfterSeconds) || 60),
      },
      429,
      origin,
      { 'Retry-After': String(Math.max(1, Number(rate?.retryAfterSeconds) || 60)) },
    );
  }

  let stored: any;
  try {
    stored = await deps.storeBatch(user.id, batch);
    if (stored?.status === 'consent_required')
      return json({ error: 'telemetry_consent_required' }, 403, origin);
    if (stored?.status === 'rate_limited')
      return json({ error: 'rate_limited', retryAfterSeconds: 60 }, 429, origin, {
        'Retry-After': '60',
      });
    const ids = acceptedEventIds(batch, stored?.acceptedEventIds);
    return json(
      {
        batchId: batch.batchId,
        acceptedEventIds: ids,
        acceptedCount: ids.length,
        duplicate: stored?.status === 'duplicate',
        rateLimitRemaining: Math.max(0, Number(stored?.rateLimitRemaining ?? rate.remaining) || 0),
      },
      200,
      origin,
    );
  } catch {
    return json({ error: 'telemetry_store_failed' }, 500, origin);
  }
}

if (import.meta.main) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.46.2');
  const env = Deno.env;
  const SUPABASE_URL = env.get('SUPABASE_URL') ?? '';
  const SUPABASE_ANON_KEY = env.get('SUPABASE_ANON_KEY') ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = {
    config: {
      policyVersion: env.get('TELEMETRY_REWARD_POLICY_VERSION') ?? '',
    },
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.getUser(jwt);
      if (error) throw error;
      return data.user;
    },
    getConsent: async (userId: string) => {
      const { data, error } = await admin
        .from('profiles')
        .select('telemetry_opt_in, telemetry_policy_version, telemetry_data_classes')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      const enabled = data?.telemetry_opt_in === true;
      return {
        enabled,
        policyVersion: data?.telemetry_policy_version ?? null,
        dataClasses: data?.telemetry_data_classes ?? [],
        eligible:
          enabled &&
          data?.telemetry_policy_version === deps.config.policyVersion &&
          exactRequiredClasses(data?.telemetry_data_classes),
      };
    },
    // The storage RPC enforces admission under the consent/profile row lock.
    checkRateLimit: async () => ({ allowed: true, remaining: 0 }),
    storeBatch: async (userId: string, batch: TelemetryBatch) => {
      const { data, error } = await admin.rpc('ingest_telemetry_batch', {
        p_user_id: userId,
        p_batch_id: batch.batchId,
        p_events: batch.events,
        p_policy_version: deps.config.policyVersion,
      });
      if (error) throw error;
      return data;
    },
  };
  Deno.serve((req: Request) =>
    handleTelemetryIngest(req, deps).catch(() =>
      json({ error: 'internal_error' }, 500, req.headers.get('origin')),
    ),
  );
}
