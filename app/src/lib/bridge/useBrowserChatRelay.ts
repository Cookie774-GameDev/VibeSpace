import { useEffect, useRef, useSyncExternalStore } from 'react';

import { revokeBrowserChatWorkspace } from '@/features/browser-chat/workspaceGrant';
import { isSupabaseConfigured } from '@/lib/supabase/env';
import {
  getBrowserChatBridgeClient,
  resetBrowserChatBridgeClient,
  setBridgeWorkspaceGrant,
  type BridgeStatus,
} from './BridgeClient';

export const DEFAULT_VIBESPACE_MCP_URL = 'https://vibespace-mcp.combatonline02.workers.dev';
const RELAY_TICKET_TIMEOUT_MS = 10_000;

interface RelayTicketRequestOptions {
  signal?: AbortSignal;
}

export interface BrowserChatRelayScope {
  readonly accountId: string;
  readonly workspaceId: string | null;
  readonly projectId: string | null;
}

export type BrowserChatRelayStatus = BridgeStatus | 'disabled';

interface RelaySubscription {
  enabled: boolean;
  scope?: BrowserChatRelayScope;
}

const relaySubscriptions = new Map<symbol, RelaySubscription>();
const relayStatusListeners = new Set<() => void>();
let relayStatusSnapshot: BrowserChatRelayStatus = 'disabled';
let relayLifecycleKey = '';
let relayLifecycleStop: (() => void) | undefined;
let relayReconcileQueued = false;

function publishRelayStatus(nextStatus: BrowserChatRelayStatus): void {
  if (relayStatusSnapshot === nextStatus) return;
  relayStatusSnapshot = nextStatus;
  for (const listener of relayStatusListeners) listener();
}

function subscribeRelayStatus(listener: () => void): () => void {
  relayStatusListeners.add(listener);
  return () => relayStatusListeners.delete(listener);
}

function clearSessionGrant(): void {
  setBridgeWorkspaceGrant();
  revokeBrowserChatWorkspace();
}

function relaySubscriptionKey(subscription: RelaySubscription): string {
  return JSON.stringify({
    enabled: subscription.enabled,
    accountId: subscription.scope?.accountId ?? '',
    workspaceId: subscription.scope?.workspaceId ?? null,
    projectId: subscription.scope?.projectId ?? null,
  });
}

function selectRelaySubscription(): RelaySubscription | undefined {
  const enabled = [...relaySubscriptions.values()].filter(
    (subscription) => subscription.enabled,
  );
  return enabled.find((subscription) => Boolean(subscription.scope?.accountId)) ?? enabled[0];
}

function stopActiveRelay(clearGrant: boolean): void {
  relayLifecycleStop?.();
  relayLifecycleStop = undefined;
  relayLifecycleKey = '';
  if (clearGrant) clearSessionGrant();
  publishRelayStatus('disabled');
}

function startBrowserChatRelayLifecycle(
  scope: BrowserChatRelayScope | undefined,
): () => void {
  const environment = import.meta.env as Record<string, string | undefined>;
  const cloudUrl = resolveBrowserChatCloudUrl(environment);
  const url = resolveBrowserChatRelayUrl(cloudUrl);
  const usesTicketGateway =
    Boolean(environment.VITE_VIBESPACE_MCP_URL) ||
    (!environment.VITE_PHONE_JARVIS_CLOUD_URL && cloudUrl === DEFAULT_VIBESPACE_MCP_URL);
  let cancelled = false;
  let authGeneration = 0;
  let activeRequest: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  let activeIdentity: { accountId: string; jwt: string } | undefined;

  const lifecycleIsCurrent = () => !cancelled;
  const invalidateAuthWork = () => {
    authGeneration += 1;
    activeRequest?.abort();
    activeRequest = undefined;
  };
  const disableRelay = (clearGrant = false) => {
    invalidateAuthWork();
    activeIdentity = undefined;
    resetBrowserChatBridgeClient();
    if (clearGrant) clearSessionGrant();
    if (lifecycleIsCurrent()) publishRelayStatus('disabled');
  };

  publishRelayStatus('disabled');
  if (!url || !isSupabaseConfigured()) {
    disableRelay(false);
    return () => {
      cancelled = true;
      invalidateAuthWork();
      resetBrowserChatBridgeClient();
    };
  }

  const start = async (jwt: string, accountId: string) => {
    if (!lifecycleIsCurrent()) return;
    if (!accountId || (scope?.accountId && accountId !== scope.accountId)) {
      disableRelay(true);
      return;
    }
    if (
      activeIdentity &&
      (activeIdentity.accountId !== accountId || activeIdentity.jwt !== jwt)
    ) {
      clearSessionGrant();
    }
    activeIdentity = { accountId, jwt };
    invalidateAuthWork();
    const currentAuthGeneration = authGeneration;
    const requestController = new AbortController();
    activeRequest = requestController;
    resetBrowserChatBridgeClient();
    const generationIsCurrent = () =>
      lifecycleIsCurrent() &&
      !requestController.signal.aborted &&
      authGeneration === currentAuthGeneration;

    try {
      const client = getBrowserChatBridgeClient({
        url,
        jwt,
        accountId,
        workspaceId: scope?.workspaceId,
        projectId: scope?.projectId,
        ...(usesTicketGateway
          ? {
              resolveUrl: (token) =>
                requestBrowserChatRelayTicket(cloudUrl!, token, fetch, {
                  signal: requestController.signal,
                }),
            }
          : {}),
        onStatus: (nextStatus) => {
          if (generationIsCurrent()) publishRelayStatus(nextStatus);
        },
      });
      client.setJwt(jwt);
      if (!generationIsCurrent()) return;
      await client.start();
    } catch {
      if (generationIsCurrent()) publishRelayStatus('error');
    }
  };

  void (async () => {
    try {
      const { getSupabaseClient } = await import('@/lib/supabase/client');
      if (!lifecycleIsCurrent()) return;
      const client = getSupabaseClient();
      if (!client) {
        publishRelayStatus('disabled');
        return;
      }
      const initialAuthGeneration = authGeneration;
      const subscription = client.auth.onAuthStateChange((event, session) => {
        if (!lifecycleIsCurrent()) return;
        const nextJwt = session?.access_token;
        const nextAccountId = session?.user?.id ?? '';
        if (event === 'SIGNED_OUT' || !nextJwt || !nextAccountId) {
          disableRelay(true);
          return;
        }
        void start(nextJwt, nextAccountId);
      });
      unsubscribe = () => subscription.data.subscription.unsubscribe();
      const { data } = await client.auth.getSession();
      if (!lifecycleIsCurrent() || authGeneration !== initialAuthGeneration) return;
      const jwt = data.session?.access_token;
      const accountId = data.session?.user?.id ?? '';
      if (jwt && accountId) await start(jwt, accountId);
      else disableRelay(true);
    } catch {
      if (lifecycleIsCurrent()) publishRelayStatus('error');
    }
  })();

  return () => {
    cancelled = true;
    invalidateAuthWork();
    unsubscribe?.();
    resetBrowserChatBridgeClient();
  };
}

function reconcileRelaySupervisor(): void {
  relayReconcileQueued = false;
  const selected = selectRelaySubscription();
  if (!selected) {
    stopActiveRelay(true);
    return;
  }

  const nextKey = relaySubscriptionKey(selected);
  if (relayLifecycleStop && relayLifecycleKey === nextKey) return;

  if (relayLifecycleStop) stopActiveRelay(true);
  relayLifecycleKey = nextKey;
  relayLifecycleStop = startBrowserChatRelayLifecycle(selected.scope);
}

function scheduleRelayReconcile(): void {
  if (relayReconcileQueued) return;
  relayReconcileQueued = true;
  void Promise.resolve().then(reconcileRelaySupervisor);
}

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
  options: RelayTicketRequestOptions = {},
): Promise<string> {
  const value = cloudUrl.trim().replace(/\/+$/u, '');
  const base = new URL(value);
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost';
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    (base.pathname !== '' && base.pathname !== '/')
  ) {
    throw new Error('The VibeSpace MCP relay URL is invalid.');
  }
  base.pathname = '/relay/ticket';
  base.search = '';
  base.hash = '';
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = globalThis.setTimeout(abort, RELAY_TICKET_TIMEOUT_MS);
  try {
    if (controller.signal.aborted)
      throw new DOMException('Relay ticket request aborted.', 'AbortError');
    const response = await fetcher(base, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
    });
    if (controller.signal.aborted) {
      throw new DOMException('Relay ticket request aborted.', 'AbortError');
    }
    if (!response.ok) throw new Error('The VibeSpace MCP relay is unavailable.');
    const payload = (await response.json()) as { url?: unknown };
    if (controller.signal.aborted) {
      throw new DOMException('Relay ticket request aborted.', 'AbortError');
    }
    if (typeof payload.url !== 'string' || !/^wss?:\/\//u.test(payload.url)) {
      throw new Error('The VibeSpace MCP relay returned an invalid ticket.');
    }
    const relay = new URL(payload.url);
    const expectedProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const queryEntries = [...relay.searchParams.entries()];
    const ticket = queryEntries[0]?.[1] ?? '';
    if (
      relay.protocol !== expectedProtocol ||
      relay.host !== base.host ||
      relay.username ||
      relay.password ||
      relay.pathname !== '/browser-chat/bridge' ||
      relay.hash ||
      queryEntries.length !== 1 ||
      queryEntries[0]?.[0] !== 'ticket' ||
      !ticket ||
      ticket.length > 2_048 ||
      /[\s\u0000-\u001f\u007f]/u.test(ticket)
    ) {
      throw new Error('The VibeSpace MCP relay returned an invalid ticket.');
    }
    return relay.toString();
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export function useBrowserChatRelay(
  enabled: boolean,
  scope?: BrowserChatRelayScope,
): BrowserChatRelayStatus {
  const subscriptionIdRef = useRef<symbol | null>(null);
  subscriptionIdRef.current ??= Symbol('browser-chat-relay-subscriber');

  useEffect(() => {
    const subscriptionId = subscriptionIdRef.current!;
    relaySubscriptions.set(subscriptionId, { enabled, scope });
    scheduleRelayReconcile();
    return () => {
      relaySubscriptions.delete(subscriptionId);
      scheduleRelayReconcile();
    };
  }, [enabled, scope?.accountId, scope?.workspaceId, scope?.projectId]);

  const sharedStatus = useSyncExternalStore<BrowserChatRelayStatus>(
    subscribeRelayStatus,
    () => relayStatusSnapshot,
    () => 'disabled',
  );
  return enabled ? sharedStatus : 'disabled';
}
