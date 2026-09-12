import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Plugins } from './Plugins';
import { usePluginStore } from './store';
import { PluginManagementCapabilityProvider } from './managementContext';
import type { PluginManagementCapability } from './runtime';
import { useAuthStore } from '@/stores/auth';

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
        authorizationUrl: 'https://accounts.example.test/authorize',
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

  it('installs first, then opens OAuth immediately while keeping compact recovery controls', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Gmail' } });
    const card = screen.getByTestId('plugin-card-gmail');
    expect(within(card).getByRole('button', { name: /^install$/i })).toBeTruthy();
    expect(within(card).queryByRole('button', { name: /^connect$/i })).toBeNull();

    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect(screen.queryByLabelText(/desktop oauth client id/i)).toBeNull();
    expect(screen.queryByLabelText(/oauth refresh grant/i)).toBeNull();
    await waitFor(() =>
      expect(management.beginAuthorization).toHaveBeenCalledWith({
        accountId: 'account-a',
        pluginId: 'gmail',
      }),
    );
    expect(openExternal).toHaveBeenCalledWith('https://accounts.example.test/authorize');
    expect(screen.getByText(/if authorization did not open automatically/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open google authorization/i })).toBeTruthy();
    expect(screen.queryByText('What this plugin does')).toBeNull();
    expect(management.saveCredential).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  }, 15_000);

  it('routes GitHub through provider authorization instead of PAT setup', async () => {
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
    expect(openExternal).not.toHaveBeenCalled();
  }, 15_000);

  it('shows exact required OAuth scopes in the compact recovery panel', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Gmail' } });
    const card = screen.getByTestId('plugin-card-gmail');
    fireEvent.click(within(card).getByRole('button', { name: /^install$/i }));
    fireEvent.click(within(card).getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText('Permissions requested')).toBeTruthy();
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
