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
 */

import { getSupabaseClient } from '@/lib/supabase/client';
import { getCallService } from './CallService';

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

  const service = getCallService();
  const cloudUrl = opts?.cloudUrl ?? service.getCloudUrl();
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
      lastFiredAt.set(detail.reason, now);
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
