import { PLUGIN_CATALOG } from './catalog';
import { usePluginStore } from './store';
import type { PluginManifest } from './types';

export type ActivePluginFilter = {
  category?: string;
  tag?: string;
  feature?: string;
};

/** Connected, enabled plugins available for Jarvis runtime features. */
export function listActivePlugins(filter?: ActivePluginFilter): PluginManifest[] {
  const connections = usePluginStore.getState().connections;
  return PLUGIN_CATALOG.filter((plugin) => {
    const connection = connections[plugin.id];
    if (!connection || connection.state !== 'connected' || !connection.enabled) return false;
    if (filter?.category && plugin.category !== filter.category) return false;
    if (filter?.tag && !plugin.tags.includes(filter.tag)) return false;
    if (filter?.feature && !plugin.supportedFeatures.includes(filter.feature)) return false;
    return true;
  });
}

export function isPluginActive(pluginId: string, projectId?: string | null): boolean {
  const connection = usePluginStore.getState().connections[pluginId];
  if (!connection || connection.state !== 'connected' || !connection.enabled) return false;
  return (
    connection.enabledProjectIds.includes('*') ||
    Boolean(projectId && connection.enabledProjectIds.includes(projectId))
  );
}

/** AI model plugins with live automated connection tests. */
export function listActiveAiModelPlugins(): PluginManifest[] {
  return listActivePlugins({ tag: 'ai' }).filter((plugin) => Boolean(plugin.httpTest));
}

/** Voice / speech plugins currently enabled for the workspace. */
export function listActiveVoicePlugins(): PluginManifest[] {
  return listActivePlugins().filter(
    (plugin) =>
      plugin.tags.some((tag) => ['voice', 'tts', 'stt', 'speech'].includes(tag)) ||
      plugin.supportedFeatures.some((feature) => /voice|tts|stt|speech/i.test(feature)),
  );
}
