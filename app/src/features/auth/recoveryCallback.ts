const CALLBACK_KEYS = new Set([
  'access_token',
  'refresh_token',
  'code',
  'type',
  'error',
  'error_code',
  'error_description',
  'expires_in',
  'expires_at',
  'token_type',
]);
const MAX_CALLBACK_VALUE_LENGTH = 8192;
const GENERIC_RECOVERY_ERROR = 'This recovery link is invalid or has expired. Request a new one.';
const ERROR_KEYS = ['error', 'error_code', 'error_description'] as const;

export interface RecoveryCallbackBrowser {
  location: { readonly href: string };
  history: { replaceState(state: unknown, title: string, url?: string | URL | null): void };
}

interface RecoverySession {
  access_token?: string;
  user?: { id?: string; email?: string };
}

export interface RecoverySessionOwnership {
  matchesSession(value: unknown): boolean;
  release(): void;
}

export interface RecoveryCallbackAuth {
  getSession(): Promise<{ data: { session: RecoverySession | null }; error: unknown }>;
  setSession(input: {
    access_token: string;
    refresh_token: string;
  }): Promise<{ data: { session: RecoverySession | null }; error: unknown }>;
  exchangeCodeForSession(
    code: string,
  ): Promise<{ data: { session: RecoverySession | null }; error: unknown }>;
  signOut?(options: { scope: 'local' }): Promise<{ error: unknown }>;
}

export type RecoveryCallbackResult =
  | { status: 'none' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      generation: number;
      userId: string;
      email: string;
      ownership: RecoverySessionOwnership;
    };

let recoveryGeneration = 0;
let startupConsumption: Promise<RecoveryCallbackResult> | undefined;
const activeOwnerships = new Set<RecoverySessionOwnership>();

function sessionIdentity(value: unknown): {
  accessToken: string;
  userId: string;
  email: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const session = (value as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  const record = session as RecoverySession;
  const accessToken = record.access_token?.trim() ?? '';
  const userId = record.user?.id?.trim() ?? '';
  const email = record.user?.email?.trim().toLowerCase() ?? '';
  return accessToken && userId && email ? { accessToken, userId, email } : null;
}

function sessionAccessToken(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const session = (value as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return '';
  const accessToken = (session as RecoverySession).access_token;
  return typeof accessToken === 'string' ? accessToken.trim() : '';
}

export function createRecoverySessionOwnership(
  accessTokenValue: string,
  userIdValue: string,
  emailValue: string,
): RecoverySessionOwnership {
  let accessToken = accessTokenValue.trim();
  let userId = userIdValue.trim();
  let email = emailValue.trim().toLowerCase();
  let ownership: RecoverySessionOwnership;
  ownership = Object.freeze({
    matchesSession(value: unknown): boolean {
      if (!accessToken || !userId || !email) return false;
      const current = sessionIdentity(value);
      return (
        current?.accessToken === accessToken && current.userId === userId && current.email === email
      );
    },
    release(): void {
      accessToken = '';
      userId = '';
      email = '';
      activeOwnerships.delete(ownership);
    },
  });
  activeOwnerships.add(ownership);
  return ownership;
}

export async function abandonRecoverySessionOwnership(
  auth: Pick<RecoveryCallbackAuth, 'getSession' | 'signOut'>,
  ownership: RecoverySessionOwnership,
  currentData?: unknown,
): Promise<void> {
  let current = currentData;
  if (!currentData) {
    try {
      const result = await auth.getSession();
      current = result.error ? null : result.data;
    } catch {
      current = null;
    }
  }
  const matches = ownership.matchesSession(current);
  ownership.release();
  if (!matches || !auth.signOut) return;
  try {
    await auth.signOut({ scope: 'local' });
  } catch {
    // Exact recovery cleanup is best-effort and must never expose provider details.
  }
}

function scrubCallbackMaterial(
  browser: RecoveryCallbackBrowser,
  url: URL,
  fragment: URLSearchParams,
): void {
  for (const key of CALLBACK_KEYS) {
    url.searchParams.delete(key);
    fragment.delete(key);
  }
  const fragmentText = fragment.toString();
  url.hash = fragmentText ? `#${fragmentText}` : '';
  browser.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

async function bestEffortAttributedLocalSignOut(
  auth: RecoveryCallbackAuth,
  attributableAccessToken: string,
): Promise<void> {
  if (!attributableAccessToken) return;
  try {
    const current = await auth.getSession();
    if (
      !current.error &&
      sessionAccessToken(current.data) === attributableAccessToken &&
      auth.signOut
    ) {
      await auth.signOut({ scope: 'local' });
    }
  } catch {
    // Recovery cleanup must not expose provider errors or escape the generic
    // failure boundary, even when an adapter throws synchronously.
  }
}

export async function consumeRecoveryCallback(
  browser: RecoveryCallbackBrowser,
  auth: RecoveryCallbackAuth | null,
): Promise<RecoveryCallbackResult> {
  let url: URL;
  try {
    url = new URL(browser.location.href);
  } catch {
    return { status: 'none' };
  }
  const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
  const hasCallbackMaterial = [...CALLBACK_KEYS].some(
    (key) => url.searchParams.has(key) || fragment.has(key),
  );
  if (!hasCallbackMaterial) return { status: 'none' };

  const occurrences = new Map(
    [...CALLBACK_KEYS].map((key) => [
      key,
      [...url.searchParams.getAll(key), ...fragment.getAll(key)],
    ]),
  );
  try {
    scrubCallbackMaterial(browser, url, fragment);
  } catch {
    return { status: 'error', message: GENERIC_RECOVERY_ERROR };
  }

  const values = [...occurrences.values()].flat();
  const typeValues = occurrences.get('type') ?? [];
  const codeValues = occurrences.get('code') ?? [];
  const accessTokenValues = occurrences.get('access_token') ?? [];
  const refreshTokenValues = occurrences.get('refresh_token') ?? [];
  const hasCallbackError = ERROR_KEYS.some((key) => (occurrences.get(key)?.length ?? 0) > 0);
  const hasDuplicate = [...occurrences.values()].some((entries) => entries.length > 1);
  const hasCodeTransport =
    codeValues.length === 1 &&
    Boolean(codeValues[0]?.trim()) &&
    accessTokenValues.length === 0 &&
    refreshTokenValues.length === 0;
  const hasTokenTransport =
    codeValues.length === 0 &&
    accessTokenValues.length === 1 &&
    Boolean(accessTokenValues[0]?.trim()) &&
    refreshTokenValues.length === 1 &&
    Boolean(refreshTokenValues[0]?.trim());
  if (
    typeValues.length !== 1 ||
    typeValues[0] !== 'recovery' ||
    hasCallbackError ||
    hasDuplicate ||
    values.some((entry) => entry.length > MAX_CALLBACK_VALUE_LENGTH) ||
    (!hasCodeTransport && !hasTokenTransport)
  ) {
    return { status: 'error', message: GENERIC_RECOVERY_ERROR };
  }
  if (!auth) {
    return { status: 'error', message: GENERIC_RECOVERY_ERROR };
  }

  const suppliedAccessToken = hasTokenTransport ? accessTokenValues[0].trim() : '';
  try {
    const current = await auth.getSession();
    if (current.error || current.data.session) {
      return { status: 'error', message: GENERIC_RECOVERY_ERROR };
    }
    const established = hasCodeTransport
      ? await auth.exchangeCodeForSession(codeValues[0])
      : await auth.setSession({
          access_token: accessTokenValues[0],
          refresh_token: refreshTokenValues[0],
        });
    const establishedIdentity = sessionIdentity(established.data);
    if (established.error || !establishedIdentity) {
      await bestEffortAttributedLocalSignOut(
        auth,
        sessionAccessToken(established.data) || suppliedAccessToken,
      );
      return { status: 'error', message: GENERIC_RECOVERY_ERROR };
    }
    return {
      status: 'ready',
      generation: ++recoveryGeneration,
      userId: establishedIdentity.userId,
      email: establishedIdentity.email,
      ownership: createRecoverySessionOwnership(
        establishedIdentity.accessToken,
        establishedIdentity.userId,
        establishedIdentity.email,
      ),
    };
  } catch {
    await bestEffortAttributedLocalSignOut(auth, suppliedAccessToken);
    return { status: 'error', message: GENERIC_RECOVERY_ERROR };
  }
}

export function consumeRecoveryCallbackOnce(
  browser: RecoveryCallbackBrowser,
  auth: RecoveryCallbackAuth | null,
): Promise<RecoveryCallbackResult> {
  startupConsumption ??= consumeRecoveryCallback(browser, auth);
  return startupConsumption;
}

export function resetRecoveryCallbackConsumptionForTests(): void {
  for (const ownership of [...activeOwnerships]) ownership.release();
  recoveryGeneration = 0;
  startupConsumption = undefined;
}
