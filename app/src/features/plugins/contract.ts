import type { PluginConnection, PluginManifest } from './types';
import { selectPluginConnectionsForAccount, usePluginStore } from './store';

export interface PluginRuntimeContract {
  id: string;
  version: 1;
  name: string;
  description: string;
  auth: {
    type: PluginManifest['authType'];
    secretStorage: 'os-keychain' | 'none';
    requiredFields: string[];
    requiredScopes: string[];
  };
  capabilities: string[];
  permissions: Array<{ capability: string; access: 'read' | 'write' }>;
  actions: Array<'connect' | 'test' | 'disconnect'>;
  health: {
    state: 'not-connected' | 'setup-required' | 'healthy' | 'unhealthy' | 'disabled';
    lastCheckedAt?: number;
  };
  setup: {
    steps: string[];
    docsUrl?: string;
    credentialUrl?: string;
    missingFields: string[];
  };
  test: {
    automated: boolean;
    lastResult?: 'passed' | 'failed';
  };
  error?: {
    code: 'connection-error' | 'setup-required';
    message: string;
    retryable: boolean;
  };
}

function healthState(
  connection: PluginConnection | undefined,
): PluginRuntimeContract['health']['state'] {
  if (!connection || connection.state === 'not_connected') return 'not-connected';
  if (
    connection.state === 'needs_setup' ||
    connection.state === 'reauthorize' ||
    connection.state === 'expired'
  ) return 'setup-required';
  if (connection.state === 'error') return 'unhealthy';
  if (connection.state !== 'connected') return 'not-connected';
  return connection.enabled === true ? 'healthy' : 'disabled';
}

export function getPluginRuntimeContract(
  accountId: string,
  manifest: PluginManifest,
): PluginRuntimeContract {
  const storedConnection = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId)[
    manifest.id
  ];
  const exactConnection =
    storedConnection &&
    storedConnection.accountId === accountId && storedConnection.pluginId === manifest.id
      ? storedConnection
      : undefined;
  const configured = new Set(exactConnection?.configuredFields ?? []);
  const missingFields = manifest.fields
    .filter((field) => field.required && !configured.has(field.id))
    .map((field) => field.id);
  const permissions = manifest.tools.map((tool) => ({
    capability: tool.name,
    access: tool.readOnly ? ('read' as const) : ('write' as const),
  }));
  const state = healthState(exactConnection);
  const error =
    exactConnection?.state === 'error'
      ? {
          code: 'connection-error' as const,
          message: exactConnection.error || 'The plugin connection test failed.',
          retryable: true,
        }
      : missingFields.length > 0
        ? {
            code: 'setup-required' as const,
            message: 'Required setup fields are missing.',
            retryable: false,
          }
        : undefined;

  return {
    id: manifest.id,
    version: 1,
    name: manifest.name,
    description: manifest.description,
    auth: {
      type: manifest.authType,
      secretStorage: manifest.authType === 'none' ? 'none' : 'os-keychain',
      requiredFields: manifest.fields.filter((field) => field.required).map((field) => field.id),
      requiredScopes: [...(manifest.requiredScopes ?? [])],
    },
    capabilities: [
      ...new Set([...manifest.supportedFeatures, ...manifest.tools.map((tool) => tool.name)]),
    ].sort(),
    permissions,
    actions: ['connect', 'test', 'disconnect'],
    health: {
      state,
      lastCheckedAt: exactConnection?.lastTestedAt,
    },
    setup: {
      steps: [...manifest.setupSteps],
      docsUrl: manifest.docsUrl,
      credentialUrl: manifest.credentialUrl,
      missingFields,
    },
    test: {
      automated: Boolean(manifest.httpTest) || manifest.id === 'mock-connector',
      lastResult: exactConnection?.lastTestedAt
        ? exactConnection.state === 'connected'
          ? 'passed'
          : 'failed'
        : undefined,
    },
    error,
  };
}

export function validatePluginRuntimeContract(contract: PluginRuntimeContract): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(contract.id)) errors.push('invalid stable id');
  if (contract.version !== 1) errors.push('unsupported contract version');
  if (!contract.name.trim() || !contract.description.trim())
    errors.push('missing user-facing metadata');
  if (contract.actions.join(',') !== 'connect,test,disconnect')
    errors.push('incomplete lifecycle actions');
  if (new Set(contract.capabilities).size !== contract.capabilities.length)
    errors.push('duplicate capabilities');
  if (
    new Set(contract.permissions.map((permission) => permission.capability)).size !==
    contract.permissions.length
  ) {
    errors.push('duplicate permissions');
  }
  if (contract.auth.secretStorage === 'none' && contract.auth.type !== 'none') {
    errors.push('authenticated plugin must use secure secret storage');
  }
  if (new Set(contract.auth.requiredScopes).size !== contract.auth.requiredScopes.length) {
    errors.push('duplicate required scopes');
  }
  return errors;
}
