import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG, validatePluginCatalog } from './catalog';

describe('plugin catalog', () => {
  it('contains at least 200 schema-valid unique entries', () => {
    expect(PLUGIN_CATALOG.length).toBeGreaterThanOrEqual(200);
    expect(validatePluginCatalog()).toEqual([]);
    expect(new Set(PLUGIN_CATALOG.map((plugin) => plugin.id)).size).toBe(PLUGIN_CATALOG.length);
  });

  it('only labels connectors with declared runtime tools as implemented', () => {
    const implemented = PLUGIN_CATALOG.filter((plugin) => plugin.status === 'implemented');
    expect(implemented.map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(['github', 'figma', 'supabase', 'shopify', 'slack', 'mock-connector']),
    );
    expect(implemented.every((plugin) => plugin.tools.length > 0)).toBe(true);
  });
});
