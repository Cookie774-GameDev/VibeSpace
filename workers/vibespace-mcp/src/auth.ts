import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import type { Env, SupabaseIdentity } from './contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_TOKEN_CHARS = 16_384;
const TICKET_LIFETIME_SECONDS = 60;
const textEncoder = new TextEncoder();
const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function cleanBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('A secure Supabase URL is required.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

function scopesFromClaims(payload: JWTPayload): string[] {
  const raw = payload.scope;
  if (typeof raw === 'string') {
    return [...new Set(raw.split(/\s+/u).filter(Boolean))].sort();
  }
  if (Array.isArray(raw)) {
    return [...new Set(raw.filter((item): item is string => typeof item === 'string'))].sort();
  }
  return [];
}

function parseIdentity(payload: JWTPayload): SupabaseIdentity {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !UUID.test(sub)) {
    throw new Error('The VibeSpace account identity is invalid.');
  }
  const clientId = payload.client_id;
  const role = payload.role;
  return {
    sub,
    scopes: scopesFromClaims(payload),
    ...(typeof clientId === 'string' && clientId ? { clientId } : {}),
    ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
    ...(typeof role === 'string' ? { role } : {}),
  };
}

export async function verifySupabaseToken(
  token: string,
  env: Pick<Env, 'SUPABASE_URL'>,
): Promise<SupabaseIdentity> {
  if (!token || token.length > MAX_TOKEN_CHARS) {
    throw new Error('Authentication is required.');
  }
  const baseUrl = cleanBaseUrl(env.SUPABASE_URL);
  const issuer = `${baseUrl}/auth/v1`;
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    algorithms: ['ES256', 'RS256'],
    clockTolerance: 5,
  });
  return parseIdentity(payload);
}

export function bearerToken(request: Request): string | null {
  const value = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/u.exec(value);
  return match?.[1] ?? null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid relay ticket.');
  const base64 = value
    .replace(/-/gu, '+')
    .replace(/_/gu, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (textEncoder.encode(secret).byteLength < 32) {
    throw new Error('Relay ticket signing is not configured.');
  }
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface RelayTicket {
  sub: string;
  exp: number;
  jti: string;
}

export async function issueRelayTicket(
  subject: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!UUID.test(subject)) throw new Error('The VibeSpace account identity is invalid.');
  const payload: RelayTicket = {
    sub: subject,
    exp: nowSeconds + TICKET_LIFETIME_SECONDS,
    jti: crypto.randomUUID(),
  };
  const encoded = encodeBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), textEncoder.encode(encoded)),
  );
  return `${encoded}.${encodeBase64Url(signature)}`;
}

export async function verifyRelayTicket(
  ticket: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<RelayTicket> {
  if (!ticket || ticket.length > 2_048) throw new Error('Invalid relay ticket.');
  const parts = ticket.split('.');
  if (parts.length !== 2) throw new Error('Invalid relay ticket.');
  const [encoded, signatureText] = parts;
  if (!encoded || !signatureText) throw new Error('Invalid relay ticket.');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    Uint8Array.from(decodeBase64Url(signatureText)).buffer,
    textEncoder.encode(encoded),
  );
  if (!valid) throw new Error('Invalid relay ticket.');
  const parsed = JSON.parse(
    new TextDecoder().decode(decodeBase64Url(encoded)),
  ) as Partial<RelayTicket>;
  if (
    typeof parsed.sub !== 'string' ||
    !UUID.test(parsed.sub) ||
    typeof parsed.jti !== 'string' ||
    !UUID.test(parsed.jti) ||
    !Number.isSafeInteger(parsed.exp) ||
    (parsed.exp as number) <= nowSeconds ||
    (parsed.exp as number) > nowSeconds + TICKET_LIFETIME_SECONDS
  ) {
    throw new Error('Invalid relay ticket.');
  }
  return parsed as RelayTicket;
}

export function clearJwksCacheForTests(): void {
  jwksByIssuer.clear();
}
