import { beforeEach, describe, expect, it } from 'vitest';
import { getPluginContextBlock, getPluginStatusContextBlock } from './context';
import { usePluginStore } from './store';

describe('plugin terminal context', () => {
  beforeEach(() => {
    usePluginStore.setState({ connections: {} });
  });

  it('includes only connected and enabled project plugins without secrets', () => {
    usePluginStore.setState({
      connections: {
        github: {
          pluginId: 'github',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['project-a'],
          accountLabel: 'octocat',
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
        figma: {
          pluginId: 'figma',
          state: 'connected',
          enabled: false,
          enabledProjectIds: ['*'],
          accountLabel: 'designer@example.com',
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
      },
    });
    const block = getPluginContextBlock('project-a');
    expect(block).toContain('GitHub');
    expect(block).toContain('identity');
    expect(block).not.toContain('Figma');
    expect(block).not.toContain('token');
    expect(getPluginContextBlock('project-b')).toBe('');
  });

  it('merges explicit plugin ids with connected plugins', () => {
    usePluginStore.setState({
      connections: {
        github: {
          pluginId: 'github',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['project-a'],
          accountLabel: 'octocat',
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
      },
    });
    const block = getPluginContextBlock('project-a', ['slack']);
    expect(block).toContain('GitHub');
    expect(block).toContain('Slack');
    expect(block).toContain('mentioned, not connected');
  });

  it('summarizes connected plugin status without secrets for plugin questions', () => {
    usePluginStore.setState({
      connections: {
        github: {
          pluginId: 'github',
          state: 'connected',
          enabled: true,
          enabledProjectIds: ['project-a'],
          accountLabel: 'octocat',
          configuredFields: ['token'],
          updatedAt: Date.now(),
        },
        slack: {
          pluginId: 'slack',
          state: 'connected',
          enabled: false,
          enabledProjectIds: ['*'],
          accountLabel: 'workspace',
          configuredFields: ['botToken'],
          updatedAt: Date.now(),
        },
      },
    });

    const block = getPluginStatusContextBlock('project-a');
    expect(block).toContain('GitHub [connected, enabled here]');
    expect(block).toContain('Slack [connected, disabled]');
    expect(block).not.toContain('token');
    expect(block).not.toContain('botToken');
  });
});
