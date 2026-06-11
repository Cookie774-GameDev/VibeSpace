import { beforeEach, describe, expect, it } from 'vitest';
import { listActiveAiModelPlugins, listActivePlugins } from './activation';
import { usePluginStore } from './store';

describe('plugin activation', () => {
  beforeEach(() => {
    usePluginStore.setState({ connections: {} });
  });

  it('lists only connected and enabled plugins', () => {
    usePluginStore.setState({
      connections: {
        github: {
          pluginId: 'github',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['*'],
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
        slack: {
          pluginId: 'slack',
          state: 'connected',
          enabled: false,
          enabledProjectIds: ['*'],
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
      },
    });

    const active = listActivePlugins();
    expect(active.map((plugin) => plugin.id)).toEqual(['github']);
  });

  it('filters active AI plugins with automated tests', () => {
    usePluginStore.setState({
      connections: {
        openai: {
          pluginId: 'openai',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['*'],
          configuredFields: ['api_key'],
          updatedAt: Date.now(),
        },
      },
    });

    expect(listActiveAiModelPlugins().map((plugin) => plugin.id)).toEqual(['openai']);
  });
});
