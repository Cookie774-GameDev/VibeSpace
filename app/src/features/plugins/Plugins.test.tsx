import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plugins } from './Plugins';
import { usePluginStore } from './store';
import { PluginManagementCapabilityProvider } from './managementContext';
import type { PluginManagementCapability } from './runtime';
import { useAuthStore } from '@/stores/auth';
import { OPEN_MCP_MANAGER_EVENT, requestOpenMcpManager } from './openMcpManager';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('@/lib/sync', () => ({
  enqueueMutation: vi.fn(async () => 'syq_plugin_test'),
}));

vi.mock('@/lib/tauri', () => ({ openExternal }));

describe('Plugins settings page', () => {
  const originalOpen = window.open;
  const management: PluginManagementCapability = {
    beginAuthorization: vi.fn(async ({ accountId, pluginId }) => {
      usePluginStore.getState().upsertConnection({
        accountId,
        pluginId,
        state: 'awaiting_approval',
        enabled: false,
        enabledProjectIds: [],
        configuredFields: [],
        updatedAt: 1,
      });
      return {
        ok: true as const,
        state: 'awaiting_approval' as const,
        authorizationUrl: 'https://github.com/login/device',
      };
    }),
    cancelAuthorization: vi.fn(async () => undefined),
    saveCredential: vi.fn(async () => undefined),
    testConnection: vi.fn(async ({ accountId, pluginId }) => {
      usePluginStore.getState().upsertConnection({
        accountId,
        pluginId,
        state: 'connected',
        enabled: true,
        enabledProjectIds: ['*'],
        accountLabel: 'Local test connector',
        configuredFields: [],
        updatedAt: 1,
      });
      return { ok: true, accountLabel: 'Local test connector' };
    }),
    disconnect: vi.fn(async ({ accountId, pluginId }) => {
      usePluginStore.getState().removeConnection(accountId, pluginId);
    }),
  };

  function renderPlugins() {
    return render(
      <PluginManagementCapabilityProvider value={management}>
        <Plugins />
      </PluginManagementCapabilityProvider>,
    );
  }

  beforeEach(() => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    usePluginStore.setState({
      connectionsByAccount: {},
      installedPluginIdsByAccount: {},
      pinnedPluginIdsByAccount: {},
    });
    vi.mocked(management.saveCredential).mockClear();
    vi.mocked(management.beginAuthorization).mockClear();
    vi.mocked(management.cancelAuthorization).mockClear();
    vi.mocked(management.testConnection).mockClear();
    vi.mocked(management.disconnect).mockClear();
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    window.open = vi.fn();
  });

  afterEach(() => {
    window.open = originalOpen;
  });

  it('loads the catalog and filters by search', () => {
    renderPlugins();
    expect(screen.getAllByTestId(/^plugin-card-/)).toHaveLength(112);
    expect(screen.getByText('GitHub')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Linear' } });
    expect(screen.getByText('Linear')).toBeTruthy();
    expect(screen.queryByText('GitHub')).toBeNull();
  }, 15_000);

  it('shows missing terminal scope as off and enables it through the actual switch', () => {
    usePluginStore.setState({
      connectionsByAccount: {
        'account-a': {
          github: {
            accountId: 'account-a',
            pluginId: 'github',
            state: 'connected',
            enabled: true,
            enabledProjectIds: [],
            configuredFields: [],
            updatedAt: 1,
          },
        },
      },
    });
    renderPlugins();
    const toggle = screen.getByRole('switch', { name: 'Enable GitHub for terminal agents' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(
      usePluginStore.getState().connectionsByAccount['account-a'].github.enabledProjectIds,
    ).toEqual(['*']);
  });

  it('exposes the active catalog filter as a pressed button', () => {
    renderPlugins();
    const all = screen.getByRole('button', { name: 'All' });
    const available = screen.getByRole('button', { name: 'Available' });
    const connected = screen.getByRole('button', { name: 'Connected' });
    const planned = screen.getByRole('button', { name: 'Planned' });

    expect(all.getAttribute('aria-pressed')).toBe('true');
    expect(available.getAttribute('aria-pressed')).toBe('false');
    expect(connected.getAttribute('aria-pressed')).toBe('false');
    expect(planned.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(connected);

    expect(all.getAttribute('aria-pressed')).toBe('false');
    expect(connected.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(planned);

    expect(connected.getAttribute('aria-pressed')).toBe('false');
    expect(planned.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens the existing MCP manager when Chat requests /mcp', async () => {
    renderPlugins();
    const disclosure = screen.getByRole('button', { name: 'Add MCP connection' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(disclosure.getAttribute('aria-controls')).toBe('plugins-mcp-connections');
    expect(document.getElementById('plugins-mcp-connections')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'OpenCode MCP servers' })).toBeNull();

    act(() => window.dispatchEvent(new CustomEvent(OPEN_MCP_MANAGER_EVENT)));

    const heading = await screen.findByRole('heading', { name: 'OpenCode MCP servers' });
    const close = screen.getByRole('button', { name: 'Close MCP connections' });
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('plugins-mcp-connections')?.contains(heading)).toBe(true);

    fireEvent.click(close);
    expect(screen.getByRole('button', { name: 'Add MCP connection' })).toBeTruthy();
    expect(document.getElementById('plugins-mcp-connections')).toBeNull();
  }, 15_000);

  it('preserves an MCP-open request while the lazy Plugins page mounts', async () => {
    requestOpenMcpManager();
    renderPlugins();

    expect(await screen.findByRole('heading', { name: 'OpenCode MCP servers' })).toBeTruthy();
  });

  it('connects and disconnects the local mock connector', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'Mock Connector' },
    });
    const card = screen.getByTestId('plugin-card-mock-connector');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(await screen.findByText(/connected as local test connector/i)).toBeTruthy();
    fireEvent.click(screen.getAllByText('Close').find((node) => node.tagName === 'BUTTON')!);
    fireEvent.click(
      within(screen.getByTestId('plugin-card-mock-connector')).getByRole('button', {
        name: /manage/i,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() =>
      expect(
        within(screen.getByTestId('plugin-card-mock-connector')).getByText('Not connected'),
      ).toBeTruthy(),
    );
    expect(management.testConnection).toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'mock-connector',
    });
    expect(management.disconnect).toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'mock-connector',
    });
  }, 15_000);

  it('confirms uninstall and updates a disconnected connector card without a reload', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'Mock Connector' },
    });
    const card = screen.getByTestId('plugin-card-mock-connector');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    expect(within(card).getByRole('button', { name: /^connect$/i })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /^uninstall$/i }));
    expect(
      screen.getByRole('dialog', { name: /uninstall vibeSpace mock connector/i }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(within(card).getByRole('button', { name: /^connect$/i })).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /^uninstall$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^uninstall$/i }));
    expect(within(card).getByRole('button', { name: /^install$/i })).toBeTruthy();
    expect(usePluginStore.getState().installedPluginIdsByAccount['account-a']).toBeUndefined();
    expect(management.disconnect).not.toHaveBeenCalled();
  });

  it('offers uninstall only after disconnect completes', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'Mock Connector' },
    });
    const card = screen.getByTestId('plugin-card-mock-connector');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await screen.findByText(/connected as local test connector/i);
    expect(within(card).queryByRole('button', { name: /^uninstall$/i })).toBeNull();
    fireEvent.click(screen.getAllByText('Close').find((node) => node.tagName === 'BUTTON')!);
    fireEvent.click(within(card).getByRole('button', { name: /^manage$/i }));
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    await waitFor(() =>
      expect(within(card).getByRole('button', { name: /^uninstall$/i })).toBeTruthy(),
    );
  }, 15_000);

  it('keeps bring-your-own Gmail OAuth on the supported manual configuration path', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Gmail' } });
    const card = screen.getByTestId('plugin-card-gmail');
    expect(within(card).getByRole('button', { name: /^install$/i })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^connect$/i })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        'https://console.cloud.google.com/apis/credentials',
      ),
    );
    expect(screen.getByLabelText(/desktop oauth client id/i)).toBeTruthy();
    expect(screen.getByLabelText(/oauth refresh grant/i)).toBeTruthy();
    expect(screen.getByText(/bring a refresh grant from your own registered google/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open gmail account page/i })).toBeTruthy();
    expect(management.beginAuthorization).not.toHaveBeenCalled();
    expect(management.saveCredential).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  }, 15_000);

  it('routes GitHub through provider authorization with an explicit in-app PAT fallback', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    const card = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));
    expect(screen.queryByLabelText(/personal access token/i)).toBeNull();
    await waitFor(() =>
      expect(management.beginAuthorization).toHaveBeenCalledWith({
        accountId: 'account-a',
        pluginId: 'github',
      }),
    );
    expect(openExternal).not.toHaveBeenCalledWith(
      'https://github.com/settings/personal-access-tokens',
    );
    fireEvent.click(screen.getByText(/use a key instead/i));
    fireEvent.change(screen.getByLabelText(/personal access token/i), {
      target: { value: 'github_pat_private_test_value' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save and verify key/i }));
    await waitFor(() =>
      expect(management.saveCredential).toHaveBeenCalledWith({
        accountId: 'account-a',
        pluginId: 'github',
        fieldId: 'token',
        value: 'github_pat_private_test_value',
      }),
    );
    expect(management.testConnection).toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'github',
    });
  }, 15_000);

  it('keeps the GitHub device code in Manage until authorization is verified', async () => {
    const connected = {
      accountId: 'account-a',
      pluginId: 'github',
      state: 'connected' as const,
      enabled: true,
      enabledProjectIds: ['*'],
      configuredFields: ['token'],
      updatedAt: 1,
    };
    usePluginStore.getState().upsertConnection(connected);
    vi.mocked(management.beginAuthorization).mockResolvedValueOnce({
      ok: true,
      state: 'awaiting_approval',
      userCode: 'TEST-CODE',
      authorizationUrl: 'https://github.com/login/device',
    });
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    fireEvent.click(
      within(screen.getByTestId('plugin-card-github')).getByRole('button', { name: /^manage$/i }),
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /continue with github/i }));
    expect(await within(dialog).findByText('TEST-CODE')).toBeTruthy();
    expect(within(dialog).getByRole('status').textContent).toContain('Provider code:');
    expect(openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    act(() => usePluginStore.getState().upsertConnection({ ...connected, updatedAt: 2 }));
    await waitFor(() => expect(within(dialog).queryByText('TEST-CODE')).toBeNull());
  }, 15_000);

  it.each([
    ['Stripe', 'stripe', 'https://dashboard.stripe.com/apikeys'],
    ['Cloudflare', 'cloudflare', 'https://dash.cloudflare.com/profile/api-tokens'],
  ])(
    'opens the official %s account page with the in-app manual fallback',
    async (name, pluginId, expectedUrl) => {
      renderPlugins();
      fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: name } });
      const card = screen.getByTestId(`plugin-card-${pluginId}`);
      fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
      fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

      await waitFor(() => expect(openExternal).toHaveBeenCalledWith(expectedUrl));
      expect(screen.getByText(/official provider account page/i)).toBeTruthy();
      expect(
        screen.getByRole('button', { name: new RegExp(`open ${name} account page`, 'i') }),
      ).toBeTruthy();
      expect(management.beginAuthorization).not.toHaveBeenCalledWith({
        accountId: 'account-a',
        pluginId,
      });
    },
    15_000,
  );

  it('shows Supabase as an explicit hosted-MCP OAuth integration blocker', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Supabase' } });
    const card = screen.getByTestId('plugin-card-supabase');

    expect(within(card).getByText(/external blocker/i)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: /view requirements/i }));

    expect(await screen.findByText(/external authorization prerequisite/i)).toBeTruthy();
    expect(screen.getAllByText(/provider-hosted browser sign-in.*remote MCP/i)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /open supabase configuration/i }));
    expect(openExternal).toHaveBeenCalledWith('https://supabase.com/docs/guides/ai-tools/mcp');
    expect(screen.queryByRole('button', { name: /save and verify key/i })).toBeNull();
    expect(management.beginAuthorization).not.toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'supabase',
    });
  }, 15_000);

  it('keeps a compact recovery panel when provider registration is unavailable', async () => {
    vi.mocked(management.beginAuthorization).mockResolvedValueOnce({
      ok: false,
      error:
        'Provider authorization is not configured in this VibeSpace build. A registered provider application and callback are required.',
      setupUrl: 'https://docs.github.com/en/apps/creating-github-apps',
    });
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    const card = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /registered provider application and callback are required/i,
    );
    expect(screen.getByRole('button', { name: /view provider requirements/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /continue with github/i })).toBeNull();
    expect(openExternal).not.toHaveBeenCalledWith('https://github.com/login/device');
    expect(screen.queryByRole('button', { name: /open github authorization/i })).toBeNull();
    expect(screen.getByText(/use a key instead/i)).toBeTruthy();
  }, 15_000);

  it('rejects an unverified provider authorization endpoint and cancels its local session', async () => {
    vi.mocked(management.beginAuthorization).mockResolvedValueOnce({
      ok: true,
      state: 'awaiting_approval',
      authorizationUrl: 'https://accounts.example.test/authorize',
    });
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    const card = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /unverified authorization endpoint/i,
    );
    expect(openExternal).not.toHaveBeenCalledWith('https://accounts.example.test/authorize');
    expect(management.cancelAuthorization).toHaveBeenCalledWith({
      accountId: 'account-a',
      pluginId: 'github',
    });
  }, 15_000);

  it('cancels an awaiting provider authorization without reporting success', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    const card = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    fireEvent.click(await screen.findByRole('button', { name: /cancel authorization/i }));
    await waitFor(() =>
      expect(management.cancelAuthorization).toHaveBeenCalledWith({
        accountId: 'account-a',
        pluginId: 'github',
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  }, 15_000);

  it('reflects verified provider completion and supports a later reconnect state', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    const card = screen.getByTestId('plugin-card-github');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));
    await screen.findByRole('button', { name: /cancel authorization/i });

    act(() =>
      usePluginStore.getState().upsertConnection({
        accountId: 'account-a',
        pluginId: 'github',
        state: 'connected',
        enabled: true,
        enabledProjectIds: [],
        configuredFields: ['token'],
        updatedAt: 2,
      }),
    );
    expect(
      await screen.findAllByText(/provider authorization completed and verified/i),
    ).toHaveLength(2);
    expect(
      usePluginStore.getState().connectionsByAccount['account-a'].github.enabledProjectIds,
    ).toEqual(['*']);

    fireEvent.click(
      screen
        .getAllByRole('button', { name: /^close$/i })
        .find((button) => button.textContent === 'Close')!,
    );
    act(() =>
      usePluginStore.getState().upsertConnection({
        accountId: 'account-a',
        pluginId: 'github',
        state: 'reauthorize',
        enabled: false,
        enabledProjectIds: [],
        configuredFields: ['token'],
        updatedAt: 3,
      }),
    );
    fireEvent.click(within(card).getByRole('button', { name: /^reconnect$/i }));
    await waitFor(() => expect(management.beginAuthorization).toHaveBeenCalledTimes(2));
  }, 15_000);

  it('shows an exact external blocker without installing or starting OAuth', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'Google Calendar' },
    });
    const card = screen.getByTestId('plugin-card-google-calendar');
    fireEvent.click(within(card).getByRole('button', { name: /view requirements/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /no registered google calendar application, exact redirect\/callback handler, or trusted token exchange/i,
    );
    expect(
      screen.getByText(/register a provider application for the exact google calendar/i),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/client secret/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^connect$/i })).toBeNull();
    expect(management.beginAuthorization).not.toHaveBeenCalled();
    expect(usePluginStore.getState().installedPluginIdsByAccount['account-a']).toBeUndefined();
  }, 15_000);

  it('shows exact required OAuth scopes in the compact recovery panel', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Gmail' } });
    const card = screen.getByTestId('plugin-card-gmail');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText('Required provider scopes')).toBeTruthy();
    expect(screen.getByText('https://www.googleapis.com/auth/gmail.readonly')).toBeTruthy();
    expect(screen.getByText('https://www.googleapis.com/auth/gmail.compose')).toBeTruthy();
  }, 15_000);

  it('shows and mutates only the canonical account connection map', () => {
    usePluginStore.setState({
      connectionsByAccount: {
        'account-a': {
          github: {
            accountId: 'account-a',
            pluginId: 'github',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['*'],
            configuredFields: ['token'],
            updatedAt: 1,
          },
        },
        'account-b': {
          linear: {
            accountId: 'account-b',
            pluginId: 'linear',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['*'],
            configuredFields: ['api_key'],
            updatedAt: 1,
          },
        },
      },
    });

    renderPlugins();
    expect(screen.getByText('1 connected')).toBeTruthy();
    expect(within(screen.getByTestId('plugin-card-github')).getByText('Connected')).toBeTruthy();
    expect(
      within(screen.getByTestId('plugin-card-linear')).getByText('Not connected'),
    ).toBeTruthy();
  });

  it('performs no management mutation while canonical identity is unavailable', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: '' });
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'Mock Connector' },
    });
    const install = within(screen.getByTestId('plugin-card-mock-connector')).getByRole('button', {
      name: /^install$/i,
    }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    expect(
      within(screen.getByTestId('plugin-card-mock-connector')).queryByRole('button', {
        name: /^connect$/i,
      }),
    ).toBeNull();
    expect(management.saveCredential).not.toHaveBeenCalled();
    expect(management.testConnection).not.toHaveBeenCalled();
    expect(management.disconnect).not.toHaveBeenCalled();
  });
});
