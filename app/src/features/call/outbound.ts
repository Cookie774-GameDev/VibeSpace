/**
 * Outbound trigger — wires Jarvis runtime error events to the phone-jarvis
 * cloud's /outbound/call endpoint.
 *
 * Listens for window CustomEvents and posts to the cloud:
 *
 *   window.dispatchEvent(new CustomEvent('jarvis:outbound-call', {
 *     detail: { reason: 'build_failed', context: { ... } }
 *   }));
 *
 * The cloud:
 *  - Verifies the user's Supabase JWT
 *  - Checks phone_settings.outbound_triggers[reason] is enabled
 *  - Looks up phone_settings.user_phone_number
 *  - Initiates a Twilio outbound call (Path A)
 *  - When the user answers, Twilio joins them to the same Pipecat pipeline
 *    and Sage greets with the reason ("Hey, your build just failed; want
 *    me to walk you through it?")
 *
 * If outbound is disabled in settings or no user_phone_number is set, the
 * cloud returns 403 / 400 and we surface a quiet toast — no exception thrown.
 *
 * Reasons that trigger by default (per Settings):
 *   - "manual"       — Sage at user request
 *   - "error"        — runtime error in agent loop / build / shell
 *   - "schedule"     — daily check-in (off by default)
 *   - "todo_due"     — upcoming high-priority todo (off by default)
 *
 * To trigger from anywhere in the app:
 *   import { fireOutboundCall } from '@/features/call/outbound';
 *   fireOutboundCall('error', { title: 'Build failed', details: '...' });
 *
 * Bundle policy:
 *   `startOutboundTrigger` is mounted at boot from `App.tsx`. To keep
 *   first-paint cheap, this module imports nothing from `livekit-client`
 *   or `@supabase/supabase-js` statically. The cloud URL comes from
 *   `./config` (env-only); the Supabase client is dynamically imported
 *   inside the handler, so its ~210KB SDK only loads if and when an
 *   actual outbound event fires.
 */

import { callCloudUrl } from './config';

export type OutboundReason = 'manual' | 'error' | 'schedule' | 'todo_due';

export interface OutboundContext {
  /** Short title, used as the AI's first sentence after greeting. */
  title?: string;
  /** Free-form details — paste tracebacks, logs, etc. The AI summarises. */
  details?: string;
  /** Optional URL the AI can read aloud or include in a follow-up note. */
  url?: string;
  /** Optional: file path the AI may want to read on the user's machine. */
  file?: string;
  [key: string]: unknown;
}

interface OutboundDetail {
  reason: OutboundReason;
  context?: OutboundContext;
}

const EVENT = 'jarvis:outbound-call';

/**
 * Fire-and-forget helper. Use this from anywhere in the app to ask Sage
 * to call the user.
 */
export function fireOutboundCall(reason: OutboundReason, context?: OutboundContext): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<OutboundDetail>(EVENT, { detail: { reason, context } }),
  );
}

/**
 * Sends an SMS to the user's own verified phone number through the metered
 * `sms-send` Supabase edge function (the canonical billed SMS path — the old
 * phone-jarvis cloud `/outbound/message` route bypassed billing).
 *
 * The server resolves the destination from phone_settings server-side; no
 * phone number ever leaves the client. Budget windows (monthly/weekly/5h)
 * are enforced server-side and surface as friendly errors here.
 */
export async function sendOutboundMessage(
  message: string,
  _reason: OutboundReason = 'manual',
  _context?: OutboundContext,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!supabaseUrl) return { ok: false, error: 'VibeSpace Cloud is not configured in this build.' };

  const { getSupabaseClient } = await import('@/lib/supabase/client');
  const supa = getSupabaseClient();
  if (!supa) return { ok: false, error: 'VibeSpace Cloud is not configured in this build.' };

  const { data } = await supa.auth.getSession();
  const jwt = data.session?.access_token;
  if (!jwt) return { ok: false, error: 'Sign in before sending phone messages.' };

  const r = await fetch(`${supabaseUrl}/functions/v1/sms-send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ message }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string; reason?: string } | null;
    const code = body?.reason ?? body?.error ?? '';
    const friendly: Record<string, string> = {
      no_phone_number: 'Add your phone number in Settings → Phone & Voice first.',
      invalid_phone_number: 'Your saved phone number is not a valid international (+) number.',
      sms_not_configured: 'SMS service is not configured yet. Try again later.',
      budget_exceeded: 'You have used all of your SMS texts for this cycle.',
      window_5h_exceeded: 'SMS limit for this 5-hour window reached. Try again later.',
      window_weekly_exceeded: 'SMS limit for this week reached. Try again later.',
      rate_limited: 'Too many texts at once — wait a minute and try again.',
    };
    return { ok: false, error: friendly[code] ?? (body?.error || r.statusText) };
  }
  return { ok: true };
}

interface OutboundOptions {
  cloudUrl?: string;
  /** Called on every dispatch result (toast / log). */
  onResult?: (ok: boolean, info: { reason: OutboundReason; status?: number; error?: string }) => void;
}

/**
 * Mount once at app boot. Returns a teardown function for testing.
 *
 * Implementation notes:
 *  - Throttled per-reason: at most one outbound per (reason, 30s) so a
 *    crash loop can't spam the user's phone.
 *  - Silent on no-config: if VITE_PHONE_JARVIS_CLOUD_URL is unset, the
 *    listener still mounts but every dispatch becomes a no-op. This means
 *    upstream code can fire events freely without checking config.
 *  - Auth: pulls the live Supabase JWT for each call. If user is signed
 *    out, dispatch is silently dropped.
 */
export function startOutboundTrigger(opts?: OutboundOptions): () => void {
  if (typeof window === 'undefined') return () => undefined;

  // Read URL from the cheap env-only helper. The previous code instantiated
  // `CallService` here just to call `.getCloudUrl()`, which dragged the
  // entire LiveKit SDK (~500KB) into the boot chunk. `callCloudUrl()` reads
  // the same env var with zero runtime weight.
  const cloudUrl = opts?.cloudUrl ?? callCloudUrl();
  const lastFiredAt = new Map<OutboundReason, number>();
  const COOLDOWN_MS = 30_000;

  const handler = async (ev: Event) => {
    const detail = (ev as CustomEvent<OutboundDetail>).detail;
    if (!detail || !detail.reason) return;

    if (!cloudUrl) {
      opts?.onResult?.(false, { reason: detail.reason, error: 'cloud_not_configured' });
      return;
    }

    const now = Date.now();
    const last = lastFiredAt.get(detail.reason) ?? 0;
    if (now - last < COOLDOWN_MS) {
      opts?.onResult?.(false, { reason: detail.reason, error: 'cooldown' });
      return;
    }
    // Stamp the cooldown immediately, before any await. The previous
    // implementation only stamped after `getSession()` resolved, which
    // left a race window where two events fired in the same microtask
    // both passed the gate and both placed an outbound call. Tightening
    // the window to a single event-loop tick eliminates the
    // double-fire under crash-storm conditions.
    lastFiredAt.set(detail.reason, now);

    // Dynamic import keeps the Supabase SDK off the boot chunk; it only
    // loads the first time a real outbound event fires.
    const { getSupabaseClient } = await import('@/lib/supabase/client');
    const supa = getSupabaseClient();
    if (!supa) {
      opts?.onResult?.(false, { reason: detail.reason, error: 'no_supabase' });
      return;
    }

    let jwt: string | undefined;
    try {
      const { data } = await supa.auth.getSession();
      jwt = data.session?.access_token;
    } catch {
      // ignore
    }
    if (!jwt) {
      opts?.onResult?.(false, { reason: detail.reason, error: 'not_signed_in' });
      return;
    }

    try {
      const r = await fetch(`${cloudUrl}/outbound/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          reason: detail.reason,
          context: detail.context ?? {},
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        opts?.onResult?.(false, {
          reason: detail.reason,
          status: r.status,
          error: text || r.statusText,
        });
        return;
      }
      opts?.onResult?.(true, { reason: detail.reason, status: r.status });
    } catch (e) {
      opts?.onResult?.(false, {
        reason: detail.reason,
        error: (e as Error).message,
      });
    }
  };

  window.addEventListener(EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(EVENT, handler as EventListener);
  };
}
