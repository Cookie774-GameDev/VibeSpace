import { beforeEach, describe, expect, it } from 'vitest';
import { isPluginActive, listActiveAiModelPlugins, listActivePlugins } from './activation';
import { usePluginStore } from './store';

describe('plugin activation', () => {
  beforeEach(() => usePluginStore.setState({ connectionsByAccount: {} }));

  it('lists only connected and enabled plugins for the exact account', () => {
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
            updatedAt: Date.now(),
          },
        },
        'account-b': {
          slack: {
            accountId: 'account-b',
            pluginId: 'slack',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['*'],
            configuredFields: ['token'],
            updatedAt: Date.now(),
          },
        },
      },
    });

    expect(listActivePlugins('account-a').map((plugin) => plugin.id)).toEqual(['github']);
    expect(listActivePlugins('account-b').map((plugin) => plugin.id)).toEqual(['slack']);
    expect(listActivePlugins('')).toEqual([]);
  });

  it.each([
    { label: 'missing', enabledProjectIds: undefined },
    { label: 'null', enabledProjectIds: null },
    { label: 'string', enabledProjectIds: 'project-alpha' },
    { label: 'wildcard string', enabledProjectIds: '*invalid' },
    { label: 'number', enabledProjectIds: 42 },
    { label: 'object', enabledProjectIds: {} },
    { label: 'invalid member', enabledProjectIds: ['project-alpha', null] },
    { label: 'padded member', enabledProjectIds: ['project-alpha', ' padded '] },
  ])('fails closed on malformed plugin project scopes: $label', ({ enabledProjectIds }) => {
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { github: {
      accountId: 'account-a', pluginId: 'github', state: 'connected', enabled: true,
      enabledProjectIds, configuredFields: [], updatedAt: 1,
    } as never } } });
    expect(isPluginActive('account-a', 'github', 'project')).toBe(false);
    expect(isPluginActive('account-a', 'github', 'project-alpha')).toBe(false);
    expect(listActivePlugins('account-a')).toEqual([]);
  });

  it.each(['accountId', 'pluginId'] as const)('requires matching connection %s metadata', (field) => {
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { github: {
      accountId: 'account-a', pluginId: 'github', state: 'connected', enabled: true,
      enabledProjectIds: ['project-alpha'], configuredFields: [], updatedAt: 1,
      [field]: 'other-identity',
    } } } });
    expect(isPluginActive('account-a', 'github', 'project-alpha')).toBe(false);
    expect(listActivePlugins('account-a')).toEqual([]);
  });

  it('preserves exact, empty and explicit wildcard project grants', () => {
    const connection = {
      accountId: 'account-a', pluginId: 'github', state: 'connected' as const, enabled: true,
      enabledProjectIds: ['project-alpha'], configuredFields: [], updatedAt: 1,
    };
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { github: connection } } });
    expect(isPluginActive('account-a', 'github', 'project-alpha')).toBe(true);
    expect(isPluginActive('account-a', 'github', 'project')).toBe(false);
    expect(isPluginActive('account-b', 'github', 'project-alpha')).toBe(false);
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { github: { ...connection, enabledProjectIds: [] } } } });
    expect(isPluginActive('account-a', 'github', 'project-alpha')).toBe(false);
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { github: { ...connection, enabledProjectIds: ['*'] } } } });
    expect(isPluginActive('account-a', 'github', 'project-other')).toBe(true);
  });

  it('filters active AI plugins with automated tests', () => {
    usePluginStore.setState({
      connectionsByAccount: {
        'account-a': {
          openai: {
            accountId: 'account-a',
            pluginId: 'openai',
            state: 'connected',
            enabled: true,
            enabledProjectIds: ['*'],
            configuredFields: ['api_key'],
            updatedAt: Date.now(),
          },
        },
      },
    });

    expect(listActiveAiModelPlugins('account-a').map((plugin) => plugin.id)).toEqual(['openai']);
    expect(listActiveAiModelPlugins('account-b')).toEqual([]);
  });
});
