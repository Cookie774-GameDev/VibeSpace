import { PLUGIN_CATALOG } from './catalog';
import { selectPluginConnectionsForAccount, usePluginStore } from './store';
import type { PluginConnection, PluginManifest } from './types';

export type ActivePluginFilter = {
  category?: string;
  tag?: string;
  feature?: string;
};

function isConnectedForAccount(
  connection: PluginConnection | undefined,
  accountId: string,
  pluginId: string,
): connection is PluginConnection {
  return Boolean(
    connection &&
    connection.accountId === accountId &&
    connection.pluginId === pluginId &&
    connection.state === 'connected' &&
    connection.enabled === true &&
    Array.isArray(connection.enabledProjectIds) &&
    connection.enabledProjectIds.every(
      (projectId) => typeof projectId === 'string' && projectId.length > 0 && projectId.trim() === projectId,
    ),
  );
}

export function listActivePlugins(
  accountId: string,
  filter?: ActivePluginFilter,
): PluginManifest[] {
  if (!accountId || accountId.trim() !== accountId) return [];
  const connections = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId);
  return PLUGIN_CATALOG.filter((plugin) => {
    const connection = connections[plugin.id];
    if (!isConnectedForAccount(connection, accountId, plugin.id)) return false;
    if (filter?.category && plugin.category !== filter.category) return false;
    if (filter?.tag && !plugin.tags.includes(filter.tag)) return false;
    if (filter?.feature && !plugin.supportedFeatures.includes(filter.feature)) return false;
    return true;
  });
}

export function isPluginActive(
  accountId: string,
  pluginId: string,
  projectId?: string | null,
): boolean {
  if (!accountId || accountId.trim() !== accountId) return false;
  const connection = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId)[
    pluginId
  ];
  if (!isConnectedForAccount(connection, accountId, pluginId)) return false;
  return (
    connection.enabledProjectIds.includes('*') ||
    Boolean(projectId && connection.enabledProjectIds.includes(projectId))
  );
}

export function listActiveAiModelPlugins(accountId: string): PluginManifest[] {
  return listActivePlugins(accountId, { tag: 'ai' }).filter((plugin) => Boolean(plugin.httpTest));
}

export function listActiveVoicePlugins(accountId: string): PluginManifest[] {
  return listActivePlugins(accountId).filter(
    (plugin) =>
      plugin.tags.some((tag) => ['voice', 'tts', 'stt', 'speech'].includes(tag)) ||
      plugin.supportedFeatures.some((feature) => /voice|tts|stt|speech/i.test(feature)),
  );
}
