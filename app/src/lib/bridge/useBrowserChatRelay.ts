import { useEffect, useState } from 'react';

import { isSupabaseConfigured } from '@/lib/supabase/env';
import {
  getBrowserChatBridgeClient,
  resetBrowserChatBridgeClient,
  type BridgeStatus,
} from './BridgeClient';

export const DEFAULT_VIBESPACE_MCP_URL = 'https://vibespace-mcp.combatonline02.workers.dev';

export function resolveBrowserChatRelayUrl(cloudUrl: string | undefined): string | null {
  const value = cloudUrl?.trim().replace(/\/+$/u, '');
  if (!value || !/^https?:\/\//u.test(value)) return null;
  return `${value.replace(/^http/u, 'ws')}/browser-chat/bridge`;
}

export function resolveBrowserChatMcpUrl(cloudUrl: string | undefined): string | null {
  const value = cloudUrl?.trim().replace(/\/+$/u, '');
  if (!value || !/^https:\/\//u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.pathname !== '' && url.pathname !== '/')) return null;
    url.pathname = '/mcp';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

export function resolveBrowserChatCloudUrl(
  environment: Record<string, string | undefined>,
): string | undefined {
  return (
    environment.VITE_VIBESPACE_MCP_URL ??
    environment.VITE_PHONE_JARVIS_CLOUD_URL ??
    DEFAULT_VIBESPACE_MCP_URL
  );
}

export async function requestBrowserChatRelayTicket(
  cloudUrl: string,
  jwt: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const value = cloudUrl.trim().replace(/\/+$/u, '');
  const base = new URL(value);
  if (
    (base.protocol !== 'https:' &&
      base.hostname !== '127.0.0.1' &&
      base.hostname !== 'localhost') ||
    base.username ||
    base.password ||
    (base.pathname !== '' && base.pathname !== '/')
  ) {
    throw new Error('The VibeSpace MCP relay URL is invalid.');
  }
  base.pathname = '/relay/ticket';
  base.search = '';
  base.hash = '';
  const response = await fetcher(base, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
  });
  if (!response.ok) throw new Error('The VibeSpace MCP relay is unavailable.');
  const payload = (await response.json()) as { url?: unknown };
  if (typeof payload.url !== 'string' || !/^wss?:\/\//u.test(payload.url)) {
    throw new Error('The VibeSpace MCP relay returned an invalid ticket.');
  }
  const relay = new URL(payload.url);
  if (relay.host !== base.host || relay.pathname !== '/browser-chat/bridge') {
    throw new Error('The VibeSpace MCP relay returned an invalid ticket.');
  }
  return relay.toString();
}

export function useBrowserChatRelay(enabled: boolean): BridgeStatus | 'disabled' {
  const [status, setStatus] = useState<BridgeStatus | 'disabled'>('disabled');

  useEffect(() => {
    const environment = import.meta.env as Record<string, string | undefined>;
    const cloudUrl = resolveBrowserChatCloudUrl(environment);
    const url = resolveBrowserChatRelayUrl(cloudUrl);
    const usesTicketGateway =
      Boolean(environment.VITE_VIBESPACE_MCP_URL) ||
      (!environment.VITE_PHONE_JARVIS_CLOUD_URL && cloudUrl === DEFAULT_VIBESPACE_MCP_URL);
    if (!enabled || !url || !isSupabaseConfigured()) {
      resetBrowserChatBridgeClient();
      setStatus('disabled');
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const start = async (jwt: string) => {
      if (cancelled) return;
      try {
        const client = getBrowserChatBridgeClient({
          url,
          jwt,
          ...(usesTicketGateway
            ? { resolveUrl: (token) => requestBrowserChatRelayTicket(cloudUrl!, token) }
            : {}),
          onStatus: setStatus,
        });
        client.setJwt(jwt);
        await client.start();
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    void (async () => {
      try {
        const { getSupabaseClient } = await import('@/lib/supabase/client');
        if (cancelled) return;
        const client = getSupabaseClient();
        if (!client) return;
        const { data } = await client.auth.getSession();
        const jwt = data.session?.access_token;
        if (jwt) await start(jwt);
        const subscription = client.auth.onAuthStateChange((event, session) => {
          const nextJwt = session?.access_token;
          if (nextJwt && event !== 'SIGNED_OUT') void start(nextJwt);
          if (event === 'SIGNED_OUT') {
            resetBrowserChatBridgeClient();
            setStatus('disabled');
          }
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      resetBrowserChatBridgeClient();
    };
  }, [enabled]);

  return status;
}
