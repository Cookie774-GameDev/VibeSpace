import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG } from './catalog';
import { getPluginLogoSources } from './pluginLogos';

describe('plugin logos', () => {
  it('provides at least one logo source for every catalog plugin', () => {
    const missing = PLUGIN_CATALOG.filter((plugin) => getPluginLogoSources(plugin).length === 0).map(
      (plugin) => plugin.id,
    );
    expect(missing).toEqual([]);
  });
});
