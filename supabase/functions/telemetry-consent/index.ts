// @ts-nocheck
// Account-bound optional telemetry consent. Billing eligibility is derived
// server-side from this state; the renderer cannot award a discount.

const MAX_BODY_BYTES = 8 * 1024;
const REQUIRED_CLASSES = Object.freeze(['product_usage', 'diagnostics', 'tool_outcomes']);
const ALLOWED_ORIGINS = new Set([
  'https://vibespaceos.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://vibespaceos.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    Vary: 'Origin',
    'Content-Type': 'application/json',
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

function bearer(req: Request): string | null {
  return req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}

function validConfig(config: any): boolean {
  if (typeof config?.policyVersion !== 'string' || !config.policyVersion.trim()) return false;
  try {
    const notice = new URL(config.noticeUrl);
    return notice.protocol === 'https:' && !notice.username && !notice.password;
  } catch {
    return false;
  }
}

function exactClasses(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return false;
  const normalized = [...new Set(value)];
  return (
    normalized.length === REQUIRED_CLASSES.length &&
    REQUIRED_CLASSES.every((item) => normalized.includes(item))
  );
}

export async function handleTelemetryConsent(req: Request, deps: any): Promise<Response> {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'GET' && req.method !== 'PUT') {
    return json({ error: 'method_not_allowed' }, 405, origin);
  }
  const jwt = bearer(req);
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const user = await deps.authenticate(jwt).catch(() => null);
  if (!user?.id) return json({ error: 'unauthorized' }, 401, origin);
  if (!validConfig(deps.config))
    return json({ error: 'telemetry_reward_unconfigured' }, 503, origin);

  if (req.method === 'GET') {
    const state = await deps.getConsent(user.id);
    return json(
      {
        ...state,
        policyVersion: deps.config.policyVersion,
        noticeUrl: deps.config.noticeUrl,
        discountPercent: 10,
        requiredDataClasses: REQUIRED_CLASSES,
      },
      200,
      origin,
    );
  }

  const contentLength = req.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    return json({ error: 'payload_too_large' }, 413, origin);
  }
  let body: any;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: 'payload_too_large' }, 413, origin);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'bad_request' }, 400, origin);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.enabled !== 'boolean' ||
    body.policyVersion !== deps.config.policyVersion ||
    !Array.isArray(body.dataClasses) ||
    (body.enabled ? !exactClasses(body.dataClasses) : body.dataClasses.length !== 0)
  ) {
    return json({ error: 'invalid_consent' }, 400, origin);
  }
  const state = await deps.setConsent(
    user.id,
    body.enabled,
    deps.config.policyVersion,
    body.enabled ? [...REQUIRED_CLASSES] : [],
  );
  return json(
    {
      ...state,
      policyVersion: deps.config.policyVersion,
      noticeUrl: deps.config.noticeUrl,
      discountPercent: 10,
      requiredDataClasses: REQUIRED_CLASSES,
    },
    200,
    origin,
  );
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
      noticeUrl: env.get('TELEMETRY_FINANCIAL_INCENTIVE_NOTICE_URL') ?? '',
    },
    authenticate: async (jwt: string) => {
      const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
        eligible: enabled && data?.telemetry_policy_version === deps.config.policyVersion,
      };
    },
    setConsent: async (
      userId: string,
      enabled: boolean,
      policyVersion: string,
      dataClasses: string[],
    ) => {
      const { data, error } = await admin.rpc('set_telemetry_reward_consent', {
        p_user_id: userId,
        p_enabled: enabled,
        p_policy_version: policyVersion,
        p_data_classes: dataClasses,
      });
      if (error) throw error;
      return data;
    },
  };
  Deno.serve((req: Request) =>
    handleTelemetryConsent(req, deps).catch(() =>
      json({ error: 'internal_error' }, 500, req.headers.get('origin')),
    ),
  );
}
