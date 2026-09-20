import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodexLoginCommand,
  mergeConnectionInspectionIfUnchanged,
  SubscriptionCliBridge,
} from './sections/SubscriptionCliBridge';
import { writeConnectionMetadata } from '@/lib/ai/connectionState';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { OpenCodeSubscriptionClient } from '@/lib/harness/subscriptionBridge';
import { CONNECTION_FOCUS_STORAGE_KEY } from '@/features/instant-command/providerConnectionEntrypoint';

const bridgeRefreshMocks = vi.hoisted(() => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
  refreshExternalConnectionAutoDetection: vi.fn(async () => ({})),
  invalidateOpenCodePersistentCaches: vi.fn(),
  requestOpenCodeModelCatalogRefresh: vi.fn(),
}));

const terminalQueueMocks = vi.hoisted(() => ({
  enqueueTerminalCommandBatch: vi.fn(() => ['codex-login-1']),
}));

vi.mock('@/features/terminals/terminalCommandQueue', () => terminalQueueMocks);

vi.mock('@/lib/ai/adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection: bridgeRefreshMocks.ensureExternalConnectionAutoDetection,
  refreshExternalConnectionAutoDetection: bridgeRefreshMocks.refreshExternalConnectionAutoDetection,
}));

vi.mock('@/lib/ai/adapters/opencodePersistent', () => ({
  openCodePersistentAdapter: {
    id: 'opencode-cli',
    detect: vi.fn(async () => ({ status: 'available' })),
    probeAuth: vi.fn(async () => ({ status: 'authenticated' })),
  },
  invalidateOpenCodePersistentCaches: bridgeRefreshMocks.invalidateOpenCodePersistentCaches,
}));

vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  requestOpenCodeModelCatalogRefresh: bridgeRefreshMocks.requestOpenCodeModelCatalogRefresh,
}));

vi.mock('@/lib/tauri', () => ({
  openExternal: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('SubscriptionCliBridge', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAuthStore.setState({ preferredConnectionIdByProviderFamily: {} });
    vi.clearAllMocks();
  });

  it('never starts sign-in or scanning without an explicit click when autoDetect is off', async () => {
    const onScan = vi.fn();
    const onSignIn = vi.fn();
    render(<SubscriptionCliBridge autoDetect={false} onScan={onScan} onSignIn={onSignIn} />);
    expect(onScan).not.toHaveBeenCalled();
    expect(onSignIn).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scan for agents' }));
    });
    expect(onScan).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole('button', { name: /Sign in to/ })[0]!);
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it('titles the surface AI Connectors and includes the shared MCP gateway', () => {
    render(<SubscriptionCliBridge autoDetect={false} records={{}} />);
    expect(screen.getByRole('heading', { name: 'AI Connectors' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'VibeSpace MCP Gateway' })).toBeTruthy();
  });

  it('consumes a CLI connection focus and selects the exact route card', async () => {
    window.sessionStorage.setItem(CONNECTION_FOCUS_STORAGE_KEY, 'openai-codex');
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    render(<SubscriptionCliBridge autoDetect={false} records={{}} />);

    expect(window.sessionStorage.getItem(CONNECTION_FOCUS_STORAGE_KEY)).toBeNull();
    await waitFor(() =>
      expect(document.querySelector('[data-connector-id="openai-codex"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-connection-id="openai-codex"]')).toBeTruthy();
  });

  it('keeps the OpenCode card linked to the matching live provider subscription action', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const subscriptionClient: OpenCodeSubscriptionClient = {
      providerAuthMethods: async () => ({
        openai: [{ type: 'oauth', label: 'ChatGPT Plus/Pro' }],
      }),
      providerStatus: async () => ({ connected: [] }),
      authorizeProvider: async () => ({
        url: 'https://auth.example.test/',
        method: 'auto',
        instructions: 'Approve ChatGPT access in your browser.',
      }),
      callbackProvider: async () => true,
      configProviders: async () => ({}),
    };
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{}}
        subscriptionClient={subscriptionClient}
      />,
    );

    const providerButton = await screen.findByRole('button', {
      name: 'Connect OpenAI with ChatGPT Plus/Pro',
    });
    const card = screen.getByText('OpenCode Bridge').closest('article');
    expect(card).not.toBeNull();
    fireEvent.click(
      within(card!).getByRole('button', { name: 'Connect provider for OpenCode Bridge' }),
    );
    expect(document.activeElement).toBe(providerButton);
  });

  it('starts native Codex login with the discovered executable path', () => {
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{
          'openai-codex': {
            installation: 'installed',
            auth: 'unauthenticated',
            executablePath: String.raw`C:\Managed Runtime\codex.exe`,
            lastCheckedAt: 1,
          },
        }}
      />,
    );
    const card = screen.getByText('Codex').closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Sign in to Codex CLI' }));
    expect(terminalQueueMocks.enqueueTerminalCommandBatch).toHaveBeenCalledWith([
      {
        command: String.raw`& 'C:\Managed Runtime\codex.exe' login`,
        label: 'Codex login',
        target: 'new',
      },
    ]);
    expect(useUIStore.getState().route).toBe('terminal');
  });

  it('quotes the fallback Codex login command without accepting control characters', () => {
    expect(buildCodexLoginCommand()).toBe('codex login');
    expect(buildCodexLoginCommand("C:\\bad\npath.exe")).toBe('codex login');
  });

  it('uses the managed OAuth transport without mislabeling the provider connection', async () => {
    let connected = false;
    const providerStatus = vi.fn(async () => ({ connected: connected ? ['openai'] : [] }));
    const subscriptionClient: OpenCodeSubscriptionClient = {
      providerAuthMethods: async () => ({
        openai: [{ type: 'oauth', label: 'ChatGPT Plus/Pro' }],
      }),
      providerStatus,
      authorizeProvider: async () => ({
        url: 'https://auth.example.test/',
        method: 'auto',
        instructions: 'Approve ChatGPT access in your browser.',
      }),
      callbackProvider: async () => {
        connected = true;
        return true;
      },
      configProviders: async () => ({}),
    };

    const view = render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{}}
        subscriptionClient={subscriptionClient}
      />,
    );
    const connect = await screen.findByRole('button', {
      name: 'Connect OpenAI with ChatGPT Plus/Pro',
    });
    fireEvent.click(connect);
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.queryByText('Connected in OpenCode')).toBeNull();
    expect(screen.getByText('Approve ChatGPT access in your browser.')).toBeTruthy();
    expect(bridgeRefreshMocks.invalidateOpenCodePersistentCaches).toHaveBeenCalledOnce();
    expect(bridgeRefreshMocks.refreshExternalConnectionAutoDetection).toHaveBeenCalledOnce();
    expect(bridgeRefreshMocks.requestOpenCodeModelCatalogRefresh).toHaveBeenCalledOnce();
    expect(
      bridgeRefreshMocks.invalidateOpenCodePersistentCaches.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bridgeRefreshMocks.refreshExternalConnectionAutoDetection.mock.invocationCallOrder[0]!,
    );
    expect(
      bridgeRefreshMocks.refreshExternalConnectionAutoDetection.mock.invocationCallOrder[0],
    ).toBeLessThan(
      bridgeRefreshMocks.requestOpenCodeModelCatalogRefresh.mock.invocationCallOrder[0]!,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh subscriptions' }));
    await waitFor(() => expect(providerStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(bridgeRefreshMocks.invalidateOpenCodePersistentCaches).toHaveBeenCalledTimes(2);
    expect(bridgeRefreshMocks.refreshExternalConnectionAutoDetection).toHaveBeenCalledTimes(2);
    expect(bridgeRefreshMocks.requestOpenCodeModelCatalogRefresh).toHaveBeenCalledTimes(2);

    view.unmount();
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{}}
        subscriptionClient={subscriptionClient}
      />,
    );
    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  it('requires an explicit callback code and labels Anthropic Pro/Max truthfully', async () => {
    const callbackProvider = vi.fn(async () => true);
    const subscriptionClient: OpenCodeSubscriptionClient = {
      providerAuthMethods: async () => ({
        xai: [{ type: 'oauth', label: 'SuperGrok subscription' }],
        anthropic: [{ type: 'oauth', label: 'Claude Pro/Max plugin' }],
      }),
      providerStatus: async () => ({ connected: [] }),
      authorizeProvider: async () => ({
        url: 'https://x.ai/device',
        method: 'code',
        instructions: 'Paste the authorization code from xAI.',
      }),
      callbackProvider,
      configProviders: async () => ({}),
    };

    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{}}
        subscriptionClient={subscriptionClient}
      />,
    );
    expect(
      await screen.findByText(/Claude Pro\/Max subscription bridge is not offered/i),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Claude Pro\/Max plugin/ })).toBeNull();

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Connect xAI with SuperGrok subscription',
      }),
    );
    const code = await screen.findByLabelText('xAI authorization code');
    fireEvent.change(code, { target: { value: 'device-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete xAI sign-in' }));
    expect(callbackProvider).toHaveBeenCalledWith('xai', 0, 'device-code');
  });

  it('shows bold product hierarchy with logos and clear status badges', () => {
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{
          'openai-codex': {
            installation: 'installed',
            auth: 'authenticated',
            executablePath: 'C:\\Tools\\codex.exe',
            version: '1.2.3',
            lastCheckedAt: 1,
          },
        }}
      />,
    );
    const card = screen.getByText('Codex').closest('article');
    expect(card).not.toBeNull();
    expect(within(card!).getByRole('heading', { name: 'OpenAI' })).toBeTruthy();
    expect(within(card!).getByText('Codex session detected')).toBeTruthy();
    expect(
      within(card!).getByRole('tab', { name: 'Codex subscription', selected: true }),
    ).toBeTruthy();
    expect(within(card!).getByText('C:\\Tools\\codex.exe')).toBeTruthy();
    expect(within(card!).getByRole('button', { name: 'Refresh Codex CLI' })).toBeTruthy();
    expect(within(card!).getByRole('button', { name: 'Disable Codex CLI' })).toBeTruthy();
    expect(
      within(card!).getByRole('button', { name: 'Clear scan cache for Codex CLI' }),
    ).toBeTruthy();
    expect(within(card!).getByText(/does not log you out/i)).toBeTruthy();
  });

  it('keeps API-key connectors labeled distinctly from CLI subscriptions', () => {
    render(<SubscriptionCliBridge autoDetect={false} records={{}} />);
    const routes = screen.getByRole('tablist', { name: 'OpenAI connection routes' });
    const apiRoute = within(routes).getByRole('tab', { name: 'API key connection' });
    fireEvent.click(apiRoute);
    const apiCard = screen.getByText('OpenAI API').closest('article');
    expect(apiCard).not.toBeNull();
    expect(
      within(apiCard!).getByRole('tab', { name: 'API key connection', selected: true }),
    ).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'OpenAI' })).toHaveLength(1);

    fireEvent.click(within(apiCard!).getByRole('button', { name: 'Add API key for OpenAI API' }));
    expect(window.sessionStorage.getItem('vibespace.settings.provider-focus.v1')).toBe('openai');
  });

  it('reflects a completed background scan without starting another scan or sign-in', () => {
    const onScan = vi.fn();
    const onSignIn = vi.fn();
    render(<SubscriptionCliBridge autoDetect={false} onScan={onScan} onSignIn={onSignIn} />);

    act(() => {
      writeConnectionMetadata({
        'openai-codex': {
          installation: 'installed',
          auth: 'authenticated',
          executablePath: 'C:\\Tools\\codex.exe',
          version: 'codex-cli 1.2.3',
          lastCheckedAt: 42,
        },
      });
    });

    expect(screen.getByText('C:\\Tools\\codex.exe')).toBeTruthy();
    expect(onScan).not.toHaveBeenCalled();
    expect(onSignIn).not.toHaveBeenCalled();
  });

  it('labels uncertain installation and authentication states without overclaiming', () => {
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{
          'openai-codex': {
            installation: 'installed',
            auth: 'unknown',
            lastCheckedAt: 1,
          },
          'anthropic-claude-code': {
            installation: 'unknown',
            auth: 'unknown',
            lastCheckedAt: 1,
          },
        }}
      />,
    );

    const codexCard = screen.getByText('Codex').closest('article');
    const claudeCard = screen.getByText('Claude Code').closest('article');
    expect(codexCard).not.toBeNull();
    expect(claudeCard).not.toBeNull();
    expect(within(codexCard!).getByText('Detected · sign-in required')).toBeTruthy();
    expect(within(claudeCard!).getByText('Error')).toBeTruthy();
  });

  it('does not let a completed manual scan overwrite Forget or another user update', () => {
    const baseline = {
      installation: 'installed' as const,
      auth: 'authenticated' as const,
      lastCheckedAt: 1,
    };
    const inspected = {
      installation: 'installed' as const,
      auth: 'authenticated' as const,
      lastCheckedAt: 2,
    };

    expect(
      mergeConnectionInspectionIfUnchanged({}, 'openai-codex', baseline, inspected, 1, 1),
    ).toEqual({});
    const userUpdate = {
      'openai-codex': {
        ...baseline,
        auth: 'unauthenticated' as const,
      },
    };
    expect(
      mergeConnectionInspectionIfUnchanged(userUpdate, 'openai-codex', baseline, inspected, 1, 1),
    ).toBe(userUpdate);
  });

  it('does not let a completed manual scan overwrite an ABA user mutation', () => {
    const inspected = {
      installation: 'installed' as const,
      auth: 'authenticated' as const,
      lastCheckedAt: 2,
    };
    const current = {};

    expect(
      mergeConnectionInspectionIfUnchanged(current, 'openai-codex', undefined, inspected, 4, 6),
    ).toBe(current);
  });

  it('never reports contradictory installation metadata as ready', () => {
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{
          'openai-codex': {
            installation: 'not-installed',
            auth: 'authenticated',
            lastCheckedAt: 1,
          },
        }}
      />,
    );

    const codexCard = screen.getByText('Codex').closest('article');
    expect(codexCard).not.toBeNull();
    expect(within(codexCard!).getByText('Unavailable')).toBeTruthy();
    expect(within(codexCard!).queryByText(/Signed in/i)).toBeNull();
  });

  it('offers native Codex login instead of the legacy status-only redirect', () => {
    render(
      <SubscriptionCliBridge
        autoDetect={false}
        records={{
          'openai-codex': {
            installation: 'installed',
            auth: 'unauthenticated',
            lastCheckedAt: 1_700_000_000_000,
          },
        }}
      />,
    );
    const card = screen.getByText('Codex').closest('article')!;
    expect(within(card).getByTestId('last-check-openai-codex').textContent).not.toBe('Never');
    expect(within(card).getByRole('button', { name: 'Refresh Codex CLI' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Sign in to Codex CLI' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Configure Codex CLI' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Disable Codex CLI' })).toBeTruthy();
  });
});
