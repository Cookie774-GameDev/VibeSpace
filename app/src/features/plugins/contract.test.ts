import { describe, expect, it } from 'vitest';
import { getPluginRuntimeContract, validatePluginRuntimeContract } from './contract';
import type { PluginManifest } from './types';
import { usePluginStore } from './store';

const manifest: PluginManifest = {
  id: 'example',
  name: 'Example',
  description: 'Example connector',
  category: 'developer',
  provider: 'Example Inc.',
  authType: 'token',
  fields: [{ id: 'token', label: 'Token', secret: true, required: true }],
  requiredScopes: ['repository:read'],
  status: 'implemented',
  help: 'Create a scoped token.',
  tools: [{ name: 'repo.read', description: 'Read repo', readOnly: true }],
  tags: ['code'],
  setupSteps: ['Create token', 'Test connection'],
  supportedFeatures: ['repositories'],
};

describe('plugin runtime contract', () => {
  it.each([
    ['connecting', 'not-connected'],
    ['awaiting_approval', 'not-connected'],
    ['reauthorize', 'setup-required'],
    ['expired', 'setup-required'],
    ['error', 'unhealthy'],
    ['needs_setup', 'setup-required'],
    ['not_connected', 'not-connected'],
  ] as const)('reports %s without claiming healthy execution', (state, expected) => {
    for (const enabled of [true, false]) {
      usePluginStore.setState({ connectionsByAccount: { 'account-a': { example: {
        accountId: 'account-a', pluginId: 'example', state, enabled,
        enabledProjectIds: ['*'], configuredFields: ['token'], updatedAt: 1,
      } } } });
      expect(getPluginRuntimeContract('account-a', manifest).health.state).toBe(expected);
    }
  });

  it.each(['accountId', 'pluginId'] as const)('ignores mismatched %s metadata in an account bucket', (field) => {
    usePluginStore.setState({ connectionsByAccount: { 'account-a': { example: {
      accountId: 'account-a', pluginId: 'example', state: 'connected', enabled: true,
      enabledProjectIds: ['*'], configuredFields: ['token'], updatedAt: 1, [field]: 'other',
    } } } });
    const contract = getPluginRuntimeContract('account-a', manifest);
    expect(contract.health.state).toBe('not-connected');
    expect(contract.setup.missingFields).toEqual(['token']);
  });

  it('never marks invalid persisted lifecycle or enabled values healthy', () => {
    for (const corrupt of [{ state: 'invented' }, { state: undefined }, { enabled: 'false' }]) {
      usePluginStore.setState({ connectionsByAccount: { 'account-a': { example: {
        accountId: 'account-a', pluginId: 'example', state: 'connected', enabled: true,
        enabledProjectIds: ['*'], configuredFields: ['token'], updatedAt: 1, ...corrupt,
      } as never } } });
      expect(getPluginRuntimeContract('account-a', manifest).health.state).not.toBe('healthy');
    }
  });
  it.each([undefined, null, '', ' ', ' account-a', 'account-a '])(
    'keeps missing or noncanonical account %s disconnected', (accountId) => {
      expect(getPluginRuntimeContract(accountId as never, manifest).health.state).toBe('not-connected');
    },
  );

  it('requires an exact account-owned connection and exposes only human management actions', () => {
    const connection = {
      accountId: 'account-a',
      pluginId: 'example',
      state: 'connected' as const,
      enabled: true,
      enabledProjectIds: ['*'],
      configuredFields: ['token'],
      updatedAt: 1,
    };
    usePluginStore.setState({
      connectionsByAccount: { 'account-a': { example: connection } },
    });
    const contract = getPluginRuntimeContract('account-a', manifest);

    expect(validatePluginRuntimeContract(contract)).toEqual([]);
    expect(contract).toMatchObject({
      health: { state: 'healthy' },
      actions: ['connect', 'test', 'disconnect'],
      auth: { requiredScopes: ['repository:read'] },
      permissions: [{ capability: 'repo.read', access: 'read' }],
    });
    expect(getPluginRuntimeContract('account-b', manifest).health.state).toBe('not-connected');
    expect(getPluginRuntimeContract('', manifest).health.state).toBe('not-connected');
  });
});
