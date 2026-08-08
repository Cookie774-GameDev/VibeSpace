import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginConnection } from './types';

const syncMock = vi.hoisted(() => ({
  enqueueMutation: vi.fn(async () => 'syq_plugin_test'),
}));

vi.mock('@/lib/sync', () => syncMock);

import {
  applyCloudPluginConnectionForAccount,
  pluginConnectionSyncRowId,
  selectPluginConnectionsForAccount,
  usePluginStore,
} from './store';

function connection(accountId: string, pluginId: string, enabled = true): PluginConnection {
  return {
    accountId,
    pluginId,
    state: 'connected',
    enabled,
    enabledProjectIds: ['*'],
    configuredFields: [],
    updatedAt: 1,
  };
}

describe('plugin connection account scopes', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMock.enqueueMutation.mockClear();
    usePluginStore.setState({ connectionsByAccount: {} });
  });

  it('uses a reversible, collision-safe v2 sync row id', () => {
    expect(pluginConnectionSyncRowId('acct/a b', 'github/issues')).toBe(
      'v2:acct%2Fa%20b:github%2Fissues',
    );
  });

  it('returns one stable empty snapshot for a missing account', () => {
    const state = usePluginStore.getState();
    expect(selectPluginConnectionsForAccount(state, 'missing')).toBe(
      selectPluginConnectionsForAccount(state, 'missing'),
    );
  });

  it('keeps mutations in the explicitly named account and repeats both ids in sync payloads', async () => {
    applyCloudPluginConnectionForAccount(
      'user-a',
      'v2:user-a:github',
      connection('user-a', 'github'),
    );
    usePluginStore.getState().upsertConnection(connection('user-b', 'linear'));

    expect(
      Object.keys(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a')),
    ).toEqual(['github']);
    expect(
      Object.keys(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-b')),
    ).toEqual(['linear']);

    await vi.waitFor(() =>
      expect(syncMock.enqueueMutation).toHaveBeenCalledWith(
        'insert',
        'plugin_connections',
        'v2:user-b:linear',
        expect.objectContaining({ accountId: 'user-b', pluginId: 'linear' }),
        expect.any(Object),
      ),
    );

    usePluginStore.getState().setEnabled('user-b', 'linear', false);
    usePluginStore.getState().removeConnection('user-b', 'linear');

    expect(
      selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a').github,
    ).toBeDefined();
    expect(
      selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-b').linear,
    ).toBeUndefined();
  });

  it('does not claim legacy unscoped persisted connections for any account', async () => {
    const legacy = { ...connection('foreign', 'legacy-local') } as Record<string, unknown>;
    delete legacy.accountId;
    localStorage.setItem(
      'jarvis-plugin-connections',
      JSON.stringify({ state: { connections: { 'legacy-local': legacy } }, version: 1 }),
    );

    await usePluginStore.persist.rehydrate();

    expect(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a')).toEqual({});
    expect(localStorage.getItem('jarvis-plugin-connections')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('jarvis-plugin-connections-v2') ?? '{}')).toEqual({
      state: { connectionsByAccount: {}, pinnedPluginIdsByAccount: {} },
      version: 3,
    });
  });

  it('rehydrates only already-accounted v2 rows with matching nested identities', async () => {
    localStorage.setItem(
      'jarvis-plugin-connections-v2',
      JSON.stringify({
        state: {
          connectionsByAccount: {
            'user-a': {
              github: connection('user-a', 'github'),
              linear: connection('user-b', 'linear'),
            },
          },
        },
        version: 2,
      }),
    );

    await usePluginStore.persist.rehydrate();

    expect(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a')).toEqual({
      github: connection('user-a', 'github'),
    });
    expect(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-b')).toEqual({});
  });

  it('accepts cloud updates only when account, decoded row id, payload and connection agree', () => {
    const value = connection('user-a', 'github');

    expect(applyCloudPluginConnectionForAccount('user-a', 'v2:user-a:github', value)).toBe(true);
    expect(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a').github).toEqual(
      value,
    );

    expect(applyCloudPluginConnectionForAccount('user-a', 'v2:user-b:github', value)).toBe(false);
    expect(applyCloudPluginConnectionForAccount('user-a', 'github', value)).toBe(false);
    expect(
      applyCloudPluginConnectionForAccount('user-a', 'v2:user-a:github', {
        ...value,
        accountId: 'user-b',
      }),
    ).toBe(false);

    expect(applyCloudPluginConnectionForAccount('user-a', 'v2:user-a:github', null)).toBe(true);
    expect(selectPluginConnectionsForAccount(usePluginStore.getState(), 'user-a')).toEqual({});
  });
});
