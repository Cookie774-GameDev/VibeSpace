import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG, catalogStats, validatePluginCatalog } from './catalog';

describe('plugin catalog', () => {
  it('contains 353 schema-valid unique entries', () => {
    expect(PLUGIN_CATALOG.length).toBe(353);
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

  it('reports catalog coverage stats', () => {
    const stats = catalogStats();
    expect(stats).toEqual({
      total: 353,
      implemented: 6,
      configurable: 37,
      needsCredentials: 310,
      blocked: 0,
      withHttpTest: 42,
    });
  });
});
