import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  requestBrowserChatRelayTicket,
  resolveBrowserChatCloudUrl,
  resolveBrowserChatMcpUrl,
  resolveBrowserChatRelayUrl,
  useBrowserChatRelay,
} from './useBrowserChatRelay';

const relayMocks = vi.hoisted(() => {
  let authListener:
    | ((event: string, session: { access_token?: string; user?: { id: string } } | null) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const getSession = vi.fn(
    async (): Promise<{
      data: { session: { access_token: string; user: { id: string } } | null };
    }> => ({
      data: { session: { access_token: 'desktop-jwt', user: { id: 'account-a' } } },
    }),
  );
  const onAuthStateChange = vi.fn(
    (
      listener: (
        event: string,
        session: { access_token?: string; user?: { id: string } } | null,
      ) => void,
    ) => {
      authListener = listener;
      return { data: { subscription: { unsubscribe } } };
    },
  );
  const clients: Array<{
    options: {
      resolveUrl?: (jwt: string) => Promise<string>;
      onStatus?: (status: 'connecting' | 'connected' | 'error') => void;
      accountId?: string;
      workspaceId?: string | null;
      projectId?: string | null;
    };
    resolvedUrls: string[];
    start: ReturnType<typeof vi.fn>;
  }> = [];
  const getBrowserChatBridgeClient = vi.fn(
    (options: {
      resolveUrl?: (jwt: string) => Promise<string>;
      onStatus?: (status: 'connecting' | 'connected' | 'error') => void;
      accountId?: string;
      workspaceId?: string | null;
      projectId?: string | null;
    }) => {
      const resolvedUrls: string[] = [];
      const client = {
        setJwt: vi.fn(),
        start: vi.fn(async () => {
          options.onStatus?.('connecting');
          if (options.resolveUrl) {
            resolvedUrls.push(await options.resolveUrl('desktop-jwt'));
          }
          options.onStatus?.('connected');
        }),
      };
      clients.push({ options, resolvedUrls, start: client.start });
      return client;
    },
  );

  return {
    clients,
    emitAuth(event: string, session: { access_token?: string; user?: { id: string } } | null) {
      authListener?.(event, session);
    },
    getBrowserChatBridgeClient,
    getSession,
    onAuthStateChange,
    resetBrowserChatBridgeClient: vi.fn(),
    setBridgeWorkspaceGrant: vi.fn(),
    reset() {
      authListener = undefined;
      clients.length = 0;
      unsubscribe.mockReset();
      getSession.mockClear();
      onAuthStateChange.mockClear();
      getBrowserChatBridgeClient.mockClear();
      this.resetBrowserChatBridgeClient.mockClear();
      this.setBridgeWorkspaceGrant.mockClear();
    },
  };
});

vi.mock('@/lib/supabase/env', () => ({
  isSupabaseConfigured: () => true,
}));

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: relayMocks.getSession,
      onAuthStateChange: relayMocks.onAuthStateChange,
    },
  }),
}));

vi.mock('./BridgeClient', () => ({
  getBrowserChatBridgeClient: relayMocks.getBrowserChatBridgeClient,
  resetBrowserChatBridgeClient: relayMocks.resetBrowserChatBridgeClient,
  setBridgeWorkspaceGrant: relayMocks.setBridgeWorkspaceGrant,
}));

describe('Browser Chat relay lifecycle', () => {
  beforeEach(() => {
    relayMocks.reset();
    vi.stubEnv('VITE_VIBESPACE_MCP_URL', 'https://vibespace-mcp.combatonline02.workers.dev');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('uses a dedicated encrypted endpoint rather than the Phone/Voice bridge', () => {
    expect(resolveBrowserChatRelayUrl('https://cloud.vibespace.test/')).toBe(
      'wss://cloud.vibespace.test/browser-chat/bridge',
    );
    expect(resolveBrowserChatRelayUrl('http://127.0.0.1:8787')).toBe(
      'ws://127.0.0.1:8787/browser-chat/bridge',
    );
  });

  it('fails closed for absent and unsupported cloud URLs', () => {
    expect(resolveBrowserChatRelayUrl(undefined)).toBeNull();
    expect(resolveBrowserChatRelayUrl('ftp://cloud.vibespace.test')).toBeNull();
  });

  it('derives the public VibeSpace MCP endpoint without leaking the relay route', () => {
    expect(resolveBrowserChatMcpUrl('https://cloud.vibespace.test/')).toBe(
      'https://cloud.vibespace.test/mcp',
    );
    expect(resolveBrowserChatMcpUrl('http://127.0.0.1:8787')).toBeNull();
    expect(resolveBrowserChatMcpUrl('javascript:alert(1)')).toBeNull();
  });

  it('prefers the dedicated free VibeSpace MCP gateway over the legacy Phone bridge', () => {
    expect(
      resolveBrowserChatCloudUrl({
        VITE_VIBESPACE_MCP_URL: 'https://mcp.vibespace.test',
        VITE_PHONE_JARVIS_CLOUD_URL: 'https://phone.vibespace.test',
      }),
    ).toBe('https://mcp.vibespace.test');
    expect(resolveBrowserChatCloudUrl({})).toBe('https://vibespace-mcp.combatonline02.workers.dev');
  });

  it('exchanges the signed-in VibeSpace token for a same-origin one-time relay URL', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        url: 'wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque',
      }),
    );
    await expect(
      requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', fetcher),
    ).resolves.toBe('wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque');
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://mcp.vibespace.test/relay/ticket'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer desktop-jwt' }),
      }),
    );
  });

  it('rejects a non-HTTP loopback gateway before exchanging a token', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        url: 'ws://localhost/browser-chat/bridge?ticket=opaque',
      }),
    );
    await expect(
      requestBrowserChatRelayTicket('ftp://localhost', 'desktop-jwt', fetcher),
    ).rejects.toThrow(/invalid/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects cross-origin relay tickets', async () => {
    const crossOrigin = vi.fn(async () =>
      Response.json({ url: 'wss://attacker.test/browser-chat/bridge?ticket=opaque' }),
    );
    await expect(
      requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', crossOrigin),
    ).rejects.toThrow(/invalid ticket/i);
  });

  it('rejects a same-origin plaintext relay downgrade from an HTTPS gateway', async () => {
    const plaintext = vi.fn(async () =>
      Response.json({ url: 'ws://mcp.vibespace.test/browser-chat/bridge?ticket=opaque' }),
    );
    await expect(
      requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', plaintext),
    ).rejects.toThrow(/invalid ticket/i);
  });

  it('rejects a relay URL without exactly one opaque one-time ticket', async () => {
    for (const url of [
      'wss://mcp.vibespace.test/browser-chat/bridge',
      'wss://mcp.vibespace.test/browser-chat/bridge?ticket=first&ticket=second',
      'wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque&extra=value',
      'wss://mcp.vibespace.test/browser-chat/bridge?ticket=opaque#fragment',
      'wss://user:pass@mcp.vibespace.test/browser-chat/bridge?ticket=opaque',
    ]) {
      const malformedTicket = vi.fn(async () => Response.json({ url }));
      await expect(
        requestBrowserChatRelayTicket('https://mcp.vibespace.test', 'desktop-jwt', malformedTicket),
      ).rejects.toThrow(/invalid ticket/i);
    }
  });

  it('bounds a relay ticket request with an aborting timeout', async () => {
    vi.useFakeTimers();
    let ticketSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          ticketSignal = init?.signal ?? undefined;
          ticketSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const request = requestBrowserChatRelayTicket(
      'https://mcp.vibespace.test',
      'desktop-jwt',
      fetcher,
    );
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ticketSignal?.aborted).toBe(true);
    await rejection;
  });

  it('resolves a fresh one-use ticket for every connect and reconnect', async () => {
    let issued = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        issued += 1;
        return Response.json({
          url: `wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque-${issued}`,
        });
      }),
    );

    const { result } = renderHook(() =>
      useBrowserChatRelay(true, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      }),
    );
    await waitFor(() => expect(result.current).toBe('connected'));
    const bridge = relayMocks.clients.at(-1);
    expect(bridge?.resolvedUrls).toEqual([
      'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque-1',
    ]);

    await expect(bridge?.options.resolveUrl?.('desktop-jwt')).resolves.toBe(
      'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque-2',
    );
    expect(issued).toBe(2);
  });

  it('aborts a delayed initial relay ticket and ignores its completion after sign-out', async () => {
    relayMocks.getSession.mockResolvedValueOnce({ data: { session: null } });
    let resolveTicket: ((response: Response) => void) | undefined;
    let ticketSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            ticketSignal = init?.signal ?? undefined;
            resolveTicket = resolve;
          }),
      ),
    );

    const { result } = renderHook(() => useBrowserChatRelay(true));
    await waitFor(() => expect(relayMocks.onAuthStateChange).toHaveBeenCalledOnce());
    act(() =>
      relayMocks.emitAuth('SIGNED_IN', {
        access_token: 'desktop-jwt',
        user: { id: 'account-a' },
      }),
    );
    await waitFor(() => {
      expect(ticketSignal).toBeDefined();
    });
    expect(relayMocks.clients).toHaveLength(1);

    act(() => relayMocks.emitAuth('SIGNED_OUT', null));
    expect(ticketSignal?.aborted).toBe(true);
    expect(result.current).toBe('disabled');

    await act(async () => {
      resolveTicket?.(
        Response.json({
          url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=late',
        }),
      );
      await Promise.resolve();
    });

    expect(result.current).toBe('disabled');
    expect(relayMocks.clients).toHaveLength(1);
  });

  it('clears the grant and refuses a stale account before creating its ticketed client', async () => {
    relayMocks.getSession.mockResolvedValueOnce({ data: { session: null } });
    const { result } = renderHook(() =>
      useBrowserChatRelay(true, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      }),
    );
    await waitFor(() => expect(relayMocks.onAuthStateChange).toHaveBeenCalledOnce());

    act(() =>
      relayMocks.emitAuth('SIGNED_IN', {
        access_token: 'account-b-jwt',
        user: { id: 'account-b' },
      }),
    );

    expect(result.current).toBe('disabled');
    expect(relayMocks.setBridgeWorkspaceGrant).toHaveBeenCalledWith();
    expect(relayMocks.getBrowserChatBridgeClient).not.toHaveBeenCalled();
  });

  it('clears the session grant before replacing the token for the same account', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque',
        }),
      ),
    );
    const { result } = renderHook(() =>
      useBrowserChatRelay(true, {
        accountId: 'account-a',
        workspaceId: 'workspace-a',
        projectId: 'project-a',
      }),
    );
    await waitFor(() => expect(result.current).toBe('connected'));
    relayMocks.setBridgeWorkspaceGrant.mockClear();

    act(() =>
      relayMocks.emitAuth('TOKEN_REFRESHED', {
        access_token: 'replacement-jwt',
        user: { id: 'account-a' },
      }),
    );

    expect(relayMocks.setBridgeWorkspaceGrant).toHaveBeenCalledWith();
    await waitFor(() => expect(relayMocks.clients).toHaveLength(2));
    expect(relayMocks.clients[1]?.options).toMatchObject({
      accountId: 'account-a',
      workspaceId: 'workspace-a',
      projectId: 'project-a',
    });
  });

  it('revokes the session grant before reconnecting after a workspace transition', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque',
        }),
      ),
    );
    const { rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) =>
        useBrowserChatRelay(true, {
          accountId: 'account-a',
          workspaceId,
          projectId: 'project-a',
        }),
      { initialProps: { workspaceId: 'workspace-a' } },
    );
    await waitFor(() => expect(relayMocks.clients).toHaveLength(1));
    relayMocks.setBridgeWorkspaceGrant.mockClear();

    rerender({ workspaceId: 'workspace-b' });

    await waitFor(() => expect(relayMocks.setBridgeWorkspaceGrant).toHaveBeenCalledWith());
    await waitFor(() => expect(relayMocks.clients).toHaveLength(2));
    expect(relayMocks.clients[1]?.options.workspaceId).toBe('workspace-b');
  });

  it('aborts a reconnect ticket and ignores its late socket status after sign-out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=initial',
        }),
      ),
    );
    const { result } = renderHook(() => useBrowserChatRelay(true));
    await waitFor(() => expect(result.current).toBe('connected'));
    const bridge = relayMocks.clients.at(-1);
    const staleStatus = bridge?.options.onStatus;

    let resolveReconnect: ((response: Response) => void) | undefined;
    let reconnectSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            reconnectSignal = init?.signal ?? undefined;
            resolveReconnect = resolve;
          }),
      ),
    );
    const reconnect = bridge?.options.resolveUrl?.('desktop-jwt');
    expect(reconnect).toBeDefined();
    const rejectedReconnect = expect(reconnect).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(reconnectSignal).toBeDefined());

    act(() => relayMocks.emitAuth('SIGNED_OUT', null));
    expect(reconnectSignal?.aborted).toBe(true);
    expect(result.current).toBe('disabled');
    resolveReconnect?.(
      Response.json({
        url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=late',
      }),
    );
    await rejectedReconnect;
    act(() => staleStatus?.('connected'));

    expect(result.current).toBe('disabled');
    expect(bridge?.resolvedUrls).toHaveLength(1);
  });

  it('ignores late bridge status callbacks after cleanup disables the relay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          url: 'wss://vibespace-mcp.combatonline02.workers.dev/browser-chat/bridge?ticket=opaque',
        }),
      ),
    );

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBrowserChatRelay(enabled),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current).toBe('connected'));
    const staleStatus = relayMocks.clients.at(-1)?.options.onStatus;

    rerender({ enabled: false });
    expect(result.current).toBe('disabled');
    act(() => staleStatus?.('connected'));

    expect(result.current).toBe('disabled');
  });
});
