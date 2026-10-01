/**
 * useBridgeLifecycle — owns the long-lived desktop bridge connections.
 *
 * Phone/Voice keeps its existing `/bridge` singleton. Browser Chat owns a
 * separate account-scoped relay singleton, but both are mounted from the
 * global app lifecycle so leaving Browser Chat never tears either transport
 * down. Supabase remains dynamically loaded off the unsigned-in boot path.
 */

import { useEffect, useRef } from 'react';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import { useAuthStore } from '@/stores/auth';
import { getBridgeClient, resetBridgeClient, type BridgeStatus } from './BridgeClient';
import { useBrowserChatRelay } from './useBrowserChatRelay';

function resolveBridgeUrl(): string | null {
  const env = (import.meta.env as Record<string, string | undefined>).VITE_PHONE_JARVIS_CLOUD_URL;
  if (!env) return null;
  const trimmed = env.replace(/\/$/, '');
  return `${trimmed.replace(/^http/, 'ws')}/bridge`;
}

export function useBridgeLifecycle(): { status: BridgeStatus | 'disabled' } {
  const statusRef = useRef<BridgeStatus | 'disabled'>('disabled');
  const startedRef = useRef(false);
  const cloudAccountId = useAuthStore((state) => state.cloudSession?.user_id ?? '');
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const projectId = useAuthStore((state) => state.projectId);

  // Browser Chat relay ownership belongs to the global app lifecycle. The
  // BrowserChatHub may observe the same supervisor, but it cannot create a
  // duplicate connection or stop it merely by unmounting on a route change.
  // A signed-in account without an authoritative workspace is not enough to
  // start the relay: workspace scope is a fail-closed security boundary.
  useBrowserChatRelay(Boolean(cloudAccountId && workspaceId), {
    accountId: cloudAccountId,
    workspaceId: workspaceId ? String(workspaceId) : null,
    projectId: projectId ? String(projectId) : null,
  });

  useEffect(() => {
    const url = resolveBridgeUrl();
    if (!url) {
      statusRef.current = 'disabled';
      return;
    }

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
          onStatus: (status) => {
            statusRef.current = status;
          },
        });
        await client.start();
      } catch (error) {
        console.error('[bridge] start failed:', error);
        startedRef.current = false;
      }
    };

    const restartWith = (jwt: string) => {
      const client = getBridgeClient();
      client.setJwt(jwt);
    };

    void (async () => {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      if (cancelled) return;

      const supabase = getSupabaseClient();
      if (!supabase) {
        statusRef.current = 'disabled';
        return;
      }

      void supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return;
        const jwt = data.session?.access_token;
        if (jwt) void startWith(jwt);
      });

      const subscription = supabase.auth.onAuthStateChange((event, session) => {
        const jwt = session?.access_token;
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && jwt) {
          if (startedRef.current) restartWith(jwt);
          else void startWith(jwt);
        } else if (event === 'TOKEN_REFRESHED' && jwt && startedRef.current) {
          restartWith(jwt);
        } else if (event === 'SIGNED_OUT' && startedRef.current) {
          resetBridgeClient();
          startedRef.current = false;
          statusRef.current = 'disabled';
        }
      });
      unsub = () => subscription.data.subscription.unsubscribe();
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
