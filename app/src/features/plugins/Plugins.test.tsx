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
    usePluginStore.setState({ connectionsByAccount: {} });
    vi.mocked(management.saveCredential).mockClear();
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

  it('opens the official provider connect page through the safe external bridge', async () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'GitHub' } });
    fireEvent.click(
      within(screen.getByTestId('plugin-card-github')).getByRole('button', { name: /^connect$/i }),
    );
    fireEvent.click(screen.getByRole('button', { name: /open github connect page/i }));
    await waitFor(() =>
      expect(openExternal).toHaveBeenCalledWith(
        'https://github.com/settings/personal-access-tokens',
      ),
    );
    expect(window.open).not.toHaveBeenCalled();
  }, 15_000);

  it('shows exact required OAuth scopes before provider authorization', () => {
    renderPlugins();
    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'Gmail' } });
    fireEvent.click(
      within(screen.getByTestId('plugin-card-gmail')).getByRole('button', { name: /^connect$/i }),
    );

    expect(screen.getByText('Required provider scopes')).toBeTruthy();
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
    fireEvent.click(
      within(screen.getByTestId('plugin-card-mock-connector')).getByRole('button', {
        name: /^connect$/i,
      }),
    );

    expect((screen.getByRole('button', { name: /^connect$/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(management.saveCredential).not.toHaveBeenCalled();
    expect(management.testConnection).not.toHaveBeenCalled();
    expect(management.disconnect).not.toHaveBeenCalled();
  });
});
