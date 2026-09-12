import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mergeConnectionInspectionIfUnchanged,
  SubscriptionCliBridge,
} from './sections/SubscriptionCliBridge';
import { writeConnectionMetadata } from '@/lib/ai/connectionState';
import { useAuthStore } from '@/stores/auth';
import type { OpenCodeSubscriptionClient } from '@/lib/harness/subscriptionBridge';

vi.mock('@/lib/ai/adapters/autoDetectConnections', () => ({
  ensureExternalConnectionAutoDetection: vi.fn(async () => ({})),
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

  it('uses OpenCode-owned OAuth for supported subscriptions and refreshes connected state', async () => {
    let connected = false;
    const subscriptionClient: OpenCodeSubscriptionClient = {
      providerAuthMethods: async () => ({
        openai: [{ type: 'oauth', label: 'ChatGPT Plus/Pro' }],
      }),
      providerStatus: async () => ({ connected: connected ? ['openai'] : [] }),
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

    render(
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
    expect(await screen.findByText('Subscription connected this session')).toBeTruthy();
    expect(screen.getByText('Approve ChatGPT access in your browser.')).toBeTruthy();
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
    expect(within(card!).getByText('Legacy session detected')).toBeTruthy();
    expect(
      within(card!).getByRole('tab', { name: 'Legacy CLI status', selected: true }),
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

  it('retains read-only legacy CLI status without offering it as a sign-in route', () => {
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
    expect(within(card).queryByRole('button', { name: 'Sign in to Codex CLI' })).toBeNull();
    expect(within(card).getByRole('button', { name: 'Configure Codex CLI' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Disable Codex CLI' })).toBeTruthy();
  });
});
