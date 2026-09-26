import { PLUGIN_CATALOG } from './catalog';
import { isPluginActive } from './activation';
import { selectPluginConnectionsForAccount, usePluginStore } from './store';
import type { PluginConnection, PluginManifest } from './types';

const MAX_CONTEXT_PLUGINS = 12;

function formatPluginLine(plugin: PluginManifest, accountLabel: string): string {
  return `- ${plugin.name} [${accountLabel}]: connected capability descriptor`;
}

export function getPluginContextBlock(
  accountId: string,
  projectId: string | null,
  explicitPluginIds?: string[],
): string;
/** @deprecated Missing canonical account compatibility path; always returns empty. */
export function getPluginContextBlock(
  projectId: string | null,
  explicitPluginIds?: string[],
): string;
export function getPluginContextBlock(
  accountIdOrProjectId: string | null,
  projectIdOrExplicitPluginIds?: string | null | string[],
  explicitPluginIds?: string[],
): string {
  if (
    arguments.length < 2 ||
    projectIdOrExplicitPluginIds === undefined ||
    Array.isArray(projectIdOrExplicitPluginIds)
  ) {
    return '';
  }
  const accountId = accountIdOrProjectId ?? '';
  const projectId = projectIdOrExplicitPluginIds;
  if (!accountId || accountId.trim() !== accountId) return '';
  const connections = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId);
  const explicit = new Set(
    (explicitPluginIds ?? []).filter((id) => PLUGIN_CATALOG.some((plugin) => plugin.id === id)),
  );
  const connectedIds = PLUGIN_CATALOG.filter((plugin) =>
    isPluginActive(accountId, plugin.id, projectId),
  ).map((plugin) => plugin.id);
  const mergedIds = [...new Set([...connectedIds, ...explicit])].slice(0, MAX_CONTEXT_PLUGINS);
  if (mergedIds.length === 0) return '';

  const lines = mergedIds.flatMap((id) => {
    const plugin = PLUGIN_CATALOG.find((candidate) => candidate.id === id);
    if (!plugin) return [];
    const connection = connections[id];
    return isPluginActive(accountId, id, projectId)
      ? [formatPluginLine(plugin, connection?.accountLabel ?? 'connected')]
      : [
          `${formatPluginLine(plugin, 'mentioned, not connected')} — attach via /plug or connect in Plugins.`,
        ];
  });
  return [
    'Connected plugins for this project are descriptors only.',
    'Credentials remain in the OS keychain and are never included in prompts.',
    ...lines,
  ].join('\n');
}

function pluginQuestionMentions(text: string): boolean {
  return /\b(plugin|plugins|connector|connectors|integration|integrations)\b/i.test(text);
}

function connectionAvailability(
  connection: PluginConnection,
  accountId: string,
  pluginId: string,
  projectId: string | null,
): string {
  if (connection.state !== 'connected') return 'not connected';
  if (!connection.enabled) return 'connected, disabled';
  if (isPluginActive(accountId, pluginId, projectId)) {
    return 'connected, enabled here';
  }
  return 'connected, not enabled for this project';
}

export function getPluginStatusContextBlock(
  accountId: string,
  projectId: string | null,
  userText?: string,
): string;
/** @deprecated Missing canonical account compatibility path; always returns empty. */
export function getPluginStatusContextBlock(projectId: string | null, userText?: string): string;
export function getPluginStatusContextBlock(
  accountIdOrProjectId: string | null,
  projectIdOrUserText?: string | null,
  userText?: string,
): string {
  if (arguments.length < 3) return '';
  const accountId = accountIdOrProjectId ?? '';
  const projectId = projectIdOrUserText ?? null;
  if (!accountId || accountId.trim() !== accountId) return '';
  if (userText && !pluginQuestionMentions(userText)) return '';
  const connections = selectPluginConnectionsForAccount(usePluginStore.getState(), accountId);
  const connectedIds = new Set(
    Object.entries(connections)
      .filter(([pluginId, connection]) =>
        connection?.accountId === accountId && connection.pluginId === pluginId,
      )
      .map(([pluginId]) => pluginId),
  );
  if (connectedIds.size === 0) {
    return [
      'Plugin status for this workspace:',
      '- No plugins are connected yet.',
      'Use `settings.plugins` to connect or review plugins.',
    ].join('\n');
  }
  const lines = PLUGIN_CATALOG.filter((plugin) => connectedIds.has(plugin.id))
    .slice(0, MAX_CONTEXT_PLUGINS)
    .map((plugin) => {
      const connection = connections[plugin.id]!;
      const account = connection.accountLabel ? ` as ${connection.accountLabel}` : '';
      return `- ${plugin.name} [${connectionAvailability(connection, accountId, plugin.id, projectId)}]${account}`;
    });
  return [
    'Plugin status for this workspace:',
    'Credentials remain in the OS keychain and are unavailable to the model.',
    'Use `settings.plugins` to connect, enable, or review plugins.',
    ...lines,
  ].join('\n');
}
