const DEFAULT_AUTHORIZATION_TTL_MS = 5 * 60 * 1000;
const RANDOM_BYTE_LENGTH = 32;

export interface ContinuityClientConfig {
  supabaseUrl: string;
  clientId: string;
  redirectUri: string;
}

export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
  expiresAt: number;
}

interface AuthorizationRequestOptions {
  now?: number;
  ttlMs?: number;
  randomBytes?: (length: number) => Uint8Array;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
}

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function parseSupabaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('Supabase URL must use HTTPS.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function redirectIdentity(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export async function createAuthorizationRequest(
  config: ContinuityClientConfig,
  options: AuthorizationRequestOptions = {},
): Promise<{
  authorizationUrl: string;
  pending: PendingAuthorization;
}> {
  const supabaseUrl = parseSupabaseUrl(config.supabaseUrl);
  const clientId = requireNonEmpty(config.clientId, 'OAuth client ID');
  const redirectUri = requireNonEmpty(config.redirectUri, 'Redirect URI');
  const parsedRedirect = new URL(redirectUri);
  if (parsedRedirect.search || parsedRedirect.hash) {
    throw new Error('Redirect URI must omit query and fragment data.');
  }

  const randomBytes = options.randomBytes ?? secureRandomBytes;
  const state = encodeBase64Url(randomBytes(RANDOM_BYTE_LENGTH));
  const codeVerifier = encodeBase64Url(randomBytes(RANDOM_BYTE_LENGTH));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const codeChallenge = encodeBase64Url(new Uint8Array(digest));
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_AUTHORIZATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > DEFAULT_AUTHORIZATION_TTL_MS) {
    throw new Error('Authorization lifetime must be between 1 ms and 5 minutes.');
  }

  const authorizationUrl = new URL('/auth/v1/oauth/authorize', supabaseUrl);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('code_challenge', codeChallenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);

  return {
    authorizationUrl: authorizationUrl.toString(),
    pending: {
      clientId,
      redirectUri,
      state,
      codeVerifier,
      expiresAt: now + ttlMs,
    },
  };
}

export function consumeAuthorizationCallback(
  callbackUrl: string,
  pending: PendingAuthorization,
  consumedStates: Set<string>,
  now = Date.now(),
): { code: string } {
  if (now > pending.expiresAt) {
    throw new Error('Authorization request expired.');
  }
  if (consumedStates.has(pending.state)) {
    throw new Error('Authorization request has already been used.');
  }

  const callback = new URL(callbackUrl);
  if (redirectIdentity(callbackUrl) !== redirectIdentity(pending.redirectUri)) {
    throw new Error('Authorization callback redirect does not match.');
  }
  const state = callback.searchParams.get('state');
  if (!state || state !== pending.state) {
    throw new Error('Authorization callback state does not match.');
  }
  const providerError = callback.searchParams.get('error');
  if (providerError) {
    throw new Error('Authorization provider declined the request.');
  }
  const code = callback.searchParams.get('code');
  if (!code) {
    throw new Error('Authorization callback did not include a code.');
  }

  consumedStates.add(pending.state);
  return { code };
}

export async function exchangeAuthorizationCode(
  supabaseUrl: string,
  code: string,
  pending: PendingAuthorization,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const endpoint = new URL('/auth/v1/oauth/token', parseSupabaseUrl(supabaseUrl));
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: requireNonEmpty(code, 'Authorization code'),
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
  });
  const response = await fetcher(endpoint.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Authorization code exchange failed (${response.status}).`);
  }
  if (response.status === 204) return null;
  return response.json();
}
