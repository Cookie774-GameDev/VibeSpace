import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserChatRelay } from './useBrowserChatRelay';

const relayMocks = vi.hoisted(() => {
  let authListener:
    | ((event: string, session: { access_token?: string; user?: { id: string } } | null) => void)
    | undefined;
  const unsubscribe = vi.fn();
  const getSession = vi.fn(async () => ({
    data: { session: { access_token: 'desktop-jwt', user: { id: 'account-a' } } },
  }));
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
  const resetBrowserChatBridgeClient = vi.fn();
  const setBridgeWorkspaceGrant = vi.fn();
  const getBrowserChatBridgeClient = vi.fn(
    (options: { onStatus?: (status: 'connecting' | 'connected') => void }) => ({
      setJwt: vi.fn(),
      start: vi.fn(async () => {
        options.onStatus?.('connecting');
        options.onStatus?.('connected');
      }),
    }),
  );

  return {
    authListener,
    getSession,
    onAuthStateChange,
    getBrowserChatBridgeClient,
    resetBrowserChatBridgeClient,
    setBridgeWorkspaceGrant,
    reset() {
      authListener = undefined;
      unsubscribe.mockReset();
      getSession.mockClear();
      onAuthStateChange.mockClear();
      getBrowserChatBridgeClient.mockClear();
      resetBrowserChatBridgeClient.mockClear();
      setBridgeWorkspaceGrant.mockClear();
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

vi.mock('@/features/browser-chat/workspaceGrant', () => ({
  revokeBrowserChatWorkspace: vi.fn(),
}));

const scope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
} as const;

function RouteObserver() {
  const status = useBrowserChatRelay(true, scope);
  return <output data-testid="route-relay-status">{status}</output>;
}

function GlobalRelayHost({ routeMounted }: { readonly routeMounted: boolean }) {
  const status = useBrowserChatRelay(true, scope);
  return (
    <>
      <output data-testid="global-relay-status">{status}</output>
      {routeMounted ? <RouteObserver /> : null}
    </>
  );
}

describe('global Browser Chat relay supervisor', () => {
  beforeEach(() => {
    relayMocks.reset();
    vi.stubEnv('VITE_VIBESPACE_MCP_URL', 'https://vibespace-mcp.test');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          url: 'wss://vibespace-mcp.test/browser-chat/bridge?ticket=opaque',
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('keeps one relay alive when the route-level observer unmounts', async () => {
    const rendered = render(<GlobalRelayHost routeMounted />);

    await waitFor(() =>
      expect(screen.getByTestId('global-relay-status').textContent).toBe('connected'),
    );
    expect(screen.getByTestId('route-relay-status').textContent).toBe('connected');
    expect(relayMocks.getBrowserChatBridgeClient).toHaveBeenCalledTimes(1);
    expect(relayMocks.onAuthStateChange).toHaveBeenCalledTimes(1);

    const resetCount = relayMocks.resetBrowserChatBridgeClient.mock.calls.length;
    rendered.rerender(<GlobalRelayHost routeMounted={false} />);

    await waitFor(() =>
      expect(screen.getByTestId('global-relay-status').textContent).toBe('connected'),
    );
    expect(relayMocks.getBrowserChatBridgeClient).toHaveBeenCalledTimes(1);
    expect(relayMocks.resetBrowserChatBridgeClient).toHaveBeenCalledTimes(resetCount);

    rendered.unmount();
    await waitFor(() =>
      expect(relayMocks.resetBrowserChatBridgeClient.mock.calls.length).toBeGreaterThan(resetCount),
    );
  });
});
