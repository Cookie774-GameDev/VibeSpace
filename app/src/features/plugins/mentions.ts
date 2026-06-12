import type { PluginManifest } from './types';

/** Resolve a slug or display name to a catalog plugin id. */
export function resolvePluginSlug(
  slug: string,
  catalog: readonly PluginManifest[],
): string | undefined {
  const normalized = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalized) return undefined;

  const byId = catalog.find((plugin) => plugin.id === normalized);
  if (byId) return byId.id;

  const compact = slug.trim().toLowerCase().replace(/\s+/g, '');
  const byName = catalog.find((plugin) => {
    const nameCompact = plugin.name.toLowerCase().replace(/\s+/g, '');
    return nameCompact === compact || plugin.name.toLowerCase() === slug.trim().toLowerCase();
  });
  return byName?.id;
}

/**
 * Extract plugin ids referenced in chat text.
 * Matches @plugin-id, /plugin-id plugin, and "use the GitHub plugin" phrasing.
 */
export function extractPluginMentions(
  text: string,
  catalog: readonly PluginManifest[],
): string[] {
  const ids = new Set<string>();

  for (const plugin of catalog) {
    const slug = plugin.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = plugin.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (new RegExp(`@${slug}(?=\\s|$|[.,!?;:])`, 'i').test(text)) {
      ids.add(plugin.id);
    }
    if (new RegExp(`/${slug}\\s+plugin`, 'i').test(text)) {
      ids.add(plugin.id);
    }
    if (new RegExp(`use\\s+the\\s+${name}\\s+plugin`, 'i').test(text)) {
      ids.add(plugin.id);
    }
  }

  return Array.from(ids);
}
