import { beforeEach, describe, expect, it } from 'vitest';
import { getBuiltinAction } from '@/lib/actions/registry';
import { useAuthStore } from '@/stores/auth';
import { usePluginStore } from './store';

describe('plugin.call action', () => {
  beforeEach(() => {
    useAuthStore.setState({ projectId: 'project-a' as never });
    usePluginStore.setState({ connections: {} });
  });

  it('runs an enabled mock plugin tool through the approval action bridge', async () => {
    usePluginStore.setState({
      connections: {
        'mock-connector': {
          pluginId: 'mock-connector',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['project-a'],
          configuredFields: [],
          updatedAt: Date.now(),
        },
      },
    });

    const action = getBuiltinAction('plugin.call');
    expect(action).toBeTruthy();
    await expect(
      action!.run(
        { pluginId: 'mock-connector', toolName: 'ping' },
        { source: 'ai', chatId: 'chat-a' },
      ),
    ).resolves.toEqual({
      ok: true,
      summary: 'VibeSpace Mock Connector.ping completed.',
      data: {
        ok: true,
        pluginId: 'mock-connector',
        tool: 'ping',
        message: 'pong',
      },
    });
  });

  it('rejects tools from disabled plugins', async () => {
    usePluginStore.setState({
      connections: {
        'mock-connector': {
          pluginId: 'mock-connector',
          state: 'connected',
          enabled: false,
          enabledProjectIds: ['*'],
          configuredFields: [],
          updatedAt: Date.now(),
        },
      },
    });

    const result = await getBuiltinAction('plugin.call')!.run(
      { pluginId: 'mock-connector', toolName: 'ping' },
      { source: 'ai' },
    );
    expect(result).toEqual({
      ok: false,
      error: 'VibeSpace Mock Connector terminal access is disabled.',
    });
  });
});
