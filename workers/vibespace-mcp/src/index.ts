import type { AuthInfo } from '@modelcontextprotocol/server';

import { bearerToken, issueRelayTicket, verifyRelayTicket, verifySupabaseToken } from './auth';
import type { Env, SupabaseIdentity } from './contracts';
import { createMcpRequestHandler } from './mcp';
import { UserRelay } from './relay';

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
} as const;

function cleanPublicMcpUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname.replace(/\/+$/u, '') !== '/mcp' ||
    url.search ||
    url.hash
  ) {
    throw new Error('MCP_PUBLIC_URL must be a secure canonical /mcp URL.');
  }
  url.pathname = '/mcp';
  return url;
}

function cleanSupabaseIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('SUPABASE_URL must be secure.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}/auth/v1`;
}

function protectedResourceMetadata(env: Env) {
  return {
    resource: cleanPublicMcpUrl(env.MCP_PUBLIC_URL).toString(),
    authorization_servers: [cleanSupabaseIssuer(env.SUPABASE_URL)],
    scopes_supported: ['email', 'profile'],
    bearer_methods_supported: ['header'],
    resource_name: 'VibeSpace MCP',
  };
}

function metadataUrl(env: Env): string {
  const url = cleanPublicMcpUrl(env.MCP_PUBLIC_URL);
  url.pathname = '/.well-known/oauth-protected-resource/mcp';
  return url.toString();
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

function challenge(env: Env): Response {
  return json({ error: 'Authentication is required.' }, 401, {
    'www-authenticate': `Bearer realm="VibeSpace MCP", resource_metadata="${metadataUrl(env)}"`,
  });
}

function allowedOrigins(env: Env): Set<string> {
  return new Set(
    env.ALLOWED_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => {
        try {
          return new URL(origin).origin === origin;
        } catch {
          return false;
        }
      }),
  );
}

function validateRequestOrigin(request: Request, env: Env): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return allowedOrigins(env).has(origin) ? null : json({ error: 'Origin denied.' }, 403);
}

function validateRequestHost(request: Request, env: Env): Response | null {
  const expected = cleanPublicMcpUrl(env.MCP_PUBLIC_URL).host;
  return new URL(request.url).host === expected ? null : json({ error: 'Host denied.' }, 403);
}

function withCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-expose-headers', 'mcp-session-id,www-authenticate');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}

function handlePublicConfig(request: Request, env: Env): Response {
  const originFailure = validateRequestOrigin(request, env);
  if (originFailure) return originFailure;
  if (request.method === 'OPTIONS') {
    return withCors(
      new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '600',
        },
      }),
      request,
      env,
    );
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed.' }, 405);
  }
  if (!env.SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) {
    return json({ error: 'OAuth consent is not configured.' }, 503);
  }
  return withCors(
    json({
      supabase_url: new URL(env.SUPABASE_URL).origin,
      supabase_publishable_key: env.SUPABASE_PUBLISHABLE_KEY,
      provider_name: 'VibeSpace MCP',
    }),
    request,
    env,
  );
}

function authInfo(identity: SupabaseIdentity, token: string, env: Env): AuthInfo {
  return {
    token,
    clientId: identity.clientId ?? 'vibespace-desktop',
    scopes: identity.scopes,
    ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
    resource: cleanPublicMcpUrl(env.MCP_PUBLIC_URL),
    extra: { sub: identity.sub, role: identity.role ?? null },
  };
}

async function authenticate(request: Request, env: Env, requireOAuthClient: boolean) {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const identity = await verifySupabaseToken(token, env);
    if (requireOAuthClient && !identity.clientId) return null;
    return { token, identity };
  } catch {
    return null;
  }
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  const hostFailure = validateRequestHost(request, env);
  if (hostFailure) return hostFailure;
  const originFailure = validateRequestOrigin(request, env);
  if (originFailure) return originFailure;
  if (request.method === 'OPTIONS') {
    return withCors(
      new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers':
            'authorization,content-type,mcp-protocol-version,mcp-session-id',
          'access-control-max-age': '600',
        },
      }),
      request,
      env,
    );
  }
  if (request.method !== 'POST') return challenge(env);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MCP_REQUEST_BYTES) {
    return json({ error: 'MCP request body is too large.' }, 413);
  }
  const authenticated = await authenticate(request, env, true);
  if (!authenticated) return challenge(env);
  const handler = createMcpRequestHandler(env);
  const response = await handler.fetch(request, {
    authInfo: authInfo(authenticated.identity, authenticated.token, env),
  });
  return withCors(response, request, env);
}

async function handleRelayTicket(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const authenticated = await authenticate(request, env, false);
  if (!authenticated || authenticated.identity.role !== 'authenticated') {
    return json({ error: 'Authentication is required.' }, 401);
  }
  try {
    const ticket = await issueRelayTicket(authenticated.identity.sub, env.RELAY_TICKET_KEY);
    const url = new URL(request.url);
    url.protocol = 'wss:';
    url.pathname = '/browser-chat/bridge';
    url.search = '';
    url.searchParams.set('ticket', ticket);
    return json({ url: url.toString(), expires_in_seconds: 60 });
  } catch {
    return json({ error: 'The VibeSpace relay is not configured.' }, 503);
  }
}

async function handleBridge(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return json({ error: 'WebSocket upgrade required.' }, 426);
  }
  const ticketText = new URL(request.url).searchParams.get('ticket') ?? '';
  try {
    const ticket = await verifyRelayTicket(ticketText, env.RELAY_TICKET_KEY);
    const stub = env.USER_RELAY.getByName(ticket.sub);
    const headers = new Headers(request.headers);
    headers.set('x-vibespace-user', ticket.sub);
    headers.set('x-vibespace-ticket-id', ticket.jti);
    headers.set('x-vibespace-ticket-expiry', String(ticket.exp));
    const internal = new Request('https://relay.internal/bridge', {
      method: request.method,
      headers,
    });
    return stub.fetch(internal);
  } catch {
    return json({ error: 'Invalid relay ticket.' }, 401);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (
        url.pathname === '/.well-known/oauth-protected-resource' ||
        url.pathname === '/.well-known/oauth-protected-resource/mcp'
      ) {
        return json(protectedResourceMetadata(env));
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({
          ok: true,
          name: 'VibeSpace MCP',
          transport: 'streamable-http',
          relay: 'durable-object-websocket',
          auth: cleanSupabaseIssuer(env.SUPABASE_URL),
        });
      }
      if (url.pathname === '/public-config') return handlePublicConfig(request, env);
      if (url.pathname === '/relay/ticket') return handleRelayTicket(request, env);
      if (url.pathname === '/browser-chat/bridge') return handleBridge(request, env);
      if (url.pathname === '/mcp') return handleMcp(request, env);
      return json({ error: 'Not found.' }, 404);
    } catch {
      return json({ error: 'VibeSpace MCP is temporarily unavailable.' }, 500);
    }
  },
};

export { UserRelay };
export default worker;
