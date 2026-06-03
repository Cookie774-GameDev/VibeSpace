/**
 * useBridgeLifecycle — owns the long-lived /bridge WebSocket connection.
 *
 * When the user is signed into Supabase AND a phone-jarvis cloud URL is
 * configured, this hook opens a WebSocket from the desktop to the cloud's
 * /bridge endpoint. The connection stays open as long as the app is open
 * (with reconnect-on-drop). When a phone call (Path A or Path C) lands at
 * the cloud and the LLM emits a tool_use, the cloud routes it back here
 * and the local MCP registry executes the tool. Files never leave the
 * user's machine.
 *
 * No-op when:
 *  - VITE_PHONE_JARVIS_CLOUD_URL is not set in the build env
 *  - VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set
 *  - User is not signed into Supabase yet
 *  - Bridge is disabled in phone_settings (TODO: wire from Settings panel)
 *
 * The cloud URL is the same one the call feature uses for /livekit/token,
 * but we swap http(s):// for ws(s):// and append /bridge.
 *
 * Bundle policy:
 *   This hook is mounted from `App.tsx` at boot and would, if it
 *   statically imported `@/lib/supabase/client`, drag the entire
 *   `@supabase/supabase-js` SDK (~210KB) onto the critical path even
 *   for users who never sign in. We dodge that by using the env-only
 *   `isSupabaseConfigured()` short-circuit and dynamically importing
 *   the client only when both env vars are set.
 */

import { useEffect, useRef } from 'react';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import { getBridgeClient, resetBridgeClient, type BridgeStatus } from './BridgeClient';

function resolveBridgeUrl(): string | null {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_PHONE_JARVIS_CLOUD_URL;
  if (!env) return null;
  const trimmed = env.replace(/\/$/, '');
  // http(s):// -> ws(s)://
  return `${trimmed.replace(/^http/, 'ws')}/bridge`;
}

export function useBridgeLifecycle(): { status: BridgeStatus | 'disabled' } {
  const statusRef = useRef<BridgeStatus | 'disabled'>('disabled');
  const startedRef = useRef(false);

  useEffect(() => {
    const url = resolveBridgeUrl();
    if (!url) {
      statusRef.current = 'disabled';
      return;
    }

    // Cheap env-only gate. If supabase isn't configured at build time we
    // skip every cloud-related code path AND the dynamic SDK load below.
    if (!isSupabaseConfigured()) {
      statusRef.current = 'disabled';
      return;
    }

    let cancelled = false;
    let unsub: (() => void) | undefined;

    const startWith = async (jwt: string) => {
      if (cancelled || startedRef.current) return;
      startedRef.current = true;
      try {
        const client = getBridgeClient({
          url,
          jwt,
          onStatus: (s) => {
            statusRef.current = s;
          },
        });
        await client.start();
      } catch (e) {
        // BridgeClient handles reconnect internally; this catch only fires
        // for hard auth failures. Log and let the user retry by signing
        // out and back in.
        console.error('[bridge] start failed:', e);
        startedRef.current = false;
      }
    };

    const restartWith = (jwt: string) => {
      const client = getBridgeClient();
      client.setJwt(jwt);
    };

    // Dynamic import keeps the supabase SDK off the boot graph; it only
    // loads once for users who actually sign in. Wrapped in an IIFE so
    // the useEffect callback can still return a synchronous cleanup.
    void (async () => {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      if (cancelled) return;

      const supa = getSupabaseClient();
      if (!supa) {
        statusRef.current = 'disabled';
        return;
      }

      // Wire up: subscribe to auth changes; if a session is already there, start now.
      void supa.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        const jwt = data.session?.access_token;
        if (jwt) void startWith(jwt);
      });

      const sub = supa.auth.onAuthStateChange((event, session) => {
        const jwt = session?.access_token;
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && jwt) {
          if (startedRef.current) {
            restartWith(jwt);
          } else {
            void startWith(jwt);
          }
        } else if (event === 'TOKEN_REFRESHED' && jwt && startedRef.current) {
          restartWith(jwt);
        } else if (event === 'SIGNED_OUT') {
          if (startedRef.current) {
            resetBridgeClient();
            startedRef.current = false;
            statusRef.current = 'disabled';
          }
        }
      });
      unsub = () => sub.data.subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      unsub?.();
      resetBridgeClient();
      startedRef.current = false;
    };
  }, []);

  return { status: statusRef.current };
}
