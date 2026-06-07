import { PLUGIN_CATALOG } from './catalog';
import { usePluginStore } from './store';

const MAX_CONTEXT_PLUGINS = 12;

export function getPluginContextBlock(projectId: string | null): string {
  const connections = usePluginStore.getState().connections;
  const enabled = PLUGIN_CATALOG.filter((plugin) => {
    const connection = connections[plugin.id];
    if (!connection || connection.state !== 'connected' || !connection.enabled) return false;
    return (
      connection.enabledProjectIds.includes('*') ||
      Boolean(projectId && connection.enabledProjectIds.includes(projectId))
    );
  }).slice(0, MAX_CONTEXT_PLUGINS);
  if (enabled.length === 0) return '';

  const lines = enabled.map((plugin) => {
    const connection = connections[plugin.id];
    const tools = plugin.tools
      .map((tool) => `${tool.name}${tool.readOnly ? ' (read-only)' : ' (approval required)'}`)
      .join(', ');
    return `- ${plugin.name} [${connection.accountLabel ?? 'connected'}]: ${tools || 'no runtime tools'}`;
  });

  return [
    'Connected plugin capabilities for this project are listed below.',
    'These are capability descriptors only. Credentials are held in the OS keychain and are never included in prompts or terminal environment variables.',
    'To use a listed tool, propose the approval-gated action plugin.call with params {"pluginId":"<id>","toolName":"<tool>"}.',
    'Do not claim a plugin action ran unless the approved plugin.call action returned a result.',
    ...lines,
  ].join('\n');
}
