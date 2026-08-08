import { beforeEach, describe, expect, it } from 'vitest';
import { selectPinnedPluginIdsForAccount, usePluginStore } from './store';

describe('Workbench plugin pins', () => {
  beforeEach(() => {
    window.localStorage.clear();
    usePluginStore.setState({
      connectionsByAccount: {},
      pinnedPluginIdsByAccount: {},
    });
  });

  it('keeps at most ten unique ordered pins per exact account', () => {
    const store = usePluginStore.getState();
    for (let index = 0; index < 12; index += 1) {
      store.pinPlugin('account-a', `plugin-${index}`);
    }
    store.pinPlugin('account-a', 'plugin-4');
    store.pinPlugin('account-b', 'github');

    expect(selectPinnedPluginIdsForAccount(usePluginStore.getState(), 'account-a')).toEqual(
      Array.from({ length: 10 }, (_, index) => `plugin-${index}`),
    );
    expect(selectPinnedPluginIdsForAccount(usePluginStore.getState(), 'account-b')).toEqual([
      'github',
    ]);
  });

  it('supports stable keyboard-friendly reorder and unpin operations', () => {
    const store = usePluginStore.getState();
    store.pinPlugin('account-a', 'github');
    store.pinPlugin('account-a', 'supabase');
    store.pinPlugin('account-a', 'notion');
    store.movePinnedPlugin('account-a', 'notion', -1);
    store.unpinPlugin('account-a', 'github');

    expect(selectPinnedPluginIdsForAccount(usePluginStore.getState(), 'account-a')).toEqual([
      'notion',
      'supabase',
    ]);
  });
});
