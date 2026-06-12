import { PLUGIN_CATALOG } from './catalog';
import { usePluginStore } from './store';
import type { PluginManifest } from './types';

const MAX_CONTEXT_PLUGINS = 12;

function isEnabledForProject(
  pluginId: string,
  projectId: string | null,
  connections: ReturnType<typeof usePluginStore.getState>['connections'],
): boolean {
  const connection = connections[pluginId];
  if (!connection || connection.state !== 'connected' || !connection.enabled) return false;
  return (
    connection.enabledProjectIds.includes('*') ||
    Boolean(projectId && connection.enabledProjectIds.includes(projectId))
  );
}

function formatPluginLine(plugin: PluginManifest, accountLabel?: string): string {
  const tools = plugin.tools
    .map((tool) => `${tool.name}${tool.readOnly ? ' (read-only)' : ' (approval required)'}`)
    .join(', ');
  const label = accountLabel ?? 'catalog entry';
  return `- ${plugin.name} [${label}]: ${tools || 'no runtime tools'}`;
}

export function getPluginContextBlock(
  projectId: string | null,
  explicitPluginIds?: string[],
): string {
  const connections = usePluginStore.getState().connections;
  const explicit = new Set(
    (explicitPluginIds ?? []).filter((id) => PLUGIN_CATALOG.some((plugin) => plugin.id === id)),
  );

  const connectedIds = PLUGIN_CATALOG.filter((plugin) =>
    isEnabledForProject(plugin.id, projectId, connections),
  ).map((plugin) => plugin.id);

  const mergedIds = Array.from(new Set([...connectedIds, ...explicit])).slice(
    0,
    MAX_CONTEXT_PLUGINS,
  );
  if (mergedIds.length === 0) return '';

  const lines = mergedIds
    .map((id) => PLUGIN_CATALOG.find((plugin) => plugin.id === id))
    .filter((plugin): plugin is PluginManifest => Boolean(plugin))
    .map((plugin) => {
      const connection = connections[plugin.id];
      const connected = isEnabledForProject(plugin.id, projectId, connections);
      if (connected && connection) {
        return formatPluginLine(plugin, connection.accountLabel ?? 'connected');
      }
      return `${formatPluginLine(plugin, 'mentioned, not connected')} — attach via /plug or connect in Plugins.`;
    });

  return [
    'Connected plugin capabilities for this project are listed below.',
    'These are capability descriptors only. Credentials are held in the OS keychain and are never included in prompts or terminal environment variables.',
    'To use a listed tool, propose the approval-gated action plugin.call with params {"pluginId":"<id>","toolName":"<tool>"}.',
    'Do not claim a plugin action ran unless the approved plugin.call action returned a result.',
    ...lines,
  ].join('\n');
}
