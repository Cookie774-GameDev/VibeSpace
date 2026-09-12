/**
 * Cloud-URL-only config for the call feature.
 *
 * The `CallService` class statically imports `livekit-client` (~500KB).
 * We avoid pulling that into the boot chunk by gating the heavy import
 * behind a lazy dynamic `import()` (see `index.ts` async helpers).
 *
 * This file holds the cheap checks any boot-time UI needs — "does the
 * Call button light up, or does it stay grey with a config tooltip?" —
 * without touching LiveKit at all.
 */

/**
 * Read the phone-jarvis cloud URL from the build env. Trailing slash
 * stripped so callers can append `/livekit/token`, `/outbound/call`,
 * etc. without thinking about it.
 */
export function callCloudUrl(): string {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_PHONE_JARVIS_CLOUD_URL;
  return (env ?? '').replace(/\/$/, '');
}

export type CallCloudReadiness =
  | { state: 'missing' | 'invalid' | 'insecure'; message: string }
  | { state: 'checking'; url: string }
  | { state: 'unreachable'; url: string; message: string }
  | {
      state: 'partial' | 'ready';
      url: string;
      transports: {
        livekit: boolean;
        telnyx: boolean;
        callAnyone: boolean;
        supabase: boolean;
      };
    };

export function normalizeCallCloudUrl(
  value: string | null | undefined,
): { ok: true; url: string } | { ok: false; reason: 'missing' | 'invalid' | 'insecure' } {
  const raw = value?.trim();
  if (!raw) return { ok: false, reason: 'missing' };
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { ok: false, reason: 'invalid' };
    }
    const local =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]';
    if (parsed.protocol !== 'https:' && !local) {
      return { ok: false, reason: 'insecure' };
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, url: parsed.href.replace(/\/$/, '') };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export async function checkCallCloudReadiness(
  value: string | null | undefined,
  options: {
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<Exclude<CallCloudReadiness, { state: 'checking' }>> {
  const normalized = normalizeCallCloudUrl(value);
  if (!normalized.ok) {
    const messages = {
      missing: 'This build does not include a phone backend URL.',
      invalid: 'The configured phone backend URL is invalid.',
      insecure: 'Remote phone backends must use HTTPS.',
    };
    return { state: normalized.reason, message: messages[normalized.reason] };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await (options.fetcher ?? fetch)(`${normalized.url}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        state: 'unreachable',
        url: normalized.url,
        message: `Health check returned HTTP ${response.status}.`,
      };
    }
    const body = (await response.json()) as {
      ok?: boolean;
      transports?: Record<string, unknown>;
    };
    if (body.ok !== true || !body.transports) {
      return {
        state: 'unreachable',
        url: normalized.url,
        message: 'The backend returned an invalid health response.',
      };
    }
    const transports = {
      livekit: body.transports.livekit === true,
      telnyx: body.transports.telnyx === true,
      callAnyone: body.transports.call_anyone === true,
      supabase: body.transports.supabase === true,
    };
    return {
      state:
        transports.livekit && transports.telnyx && transports.callAnyone && transports.supabase
          ? 'ready'
          : 'partial',
      url: normalized.url,
      transports,
    };
  } catch (error) {
    return {
      state: 'unreachable',
      url: normalized.url,
      message:
        error instanceof DOMException && error.name === 'AbortError'
          ? 'Health check timed out.'
          : error instanceof Error
            ? error.message
            : 'Health check failed.',
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * True iff the operator wired up the cloud URL at build time. The Call
 * button reads this synchronously to decide whether to render an active
 * green icon or a muted "not configured" tooltip — without paying the
 * cost of loading LiveKit just to look at a string.
 */
export function isCallConfigured(): boolean {
  return normalizeCallCloudUrl(callCloudUrl()).ok;
}
