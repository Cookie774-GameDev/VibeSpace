import { describe, expect, it } from 'vitest';
import {
  PLUGIN_CATALOG,
  PLUGIN_CATALOG_TARGET,
  catalogStats,
  validatePluginCatalog,
} from './catalog';

describe('plugin catalog', () => {
  it('contains 112 schema-valid verified connectors', () => {
    expect(PLUGIN_CATALOG.length).toBe(PLUGIN_CATALOG_TARGET);
    expect(PLUGIN_CATALOG.length).toBe(112);
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

  it('excludes needs_credentials placeholders from the curated catalog', () => {
    expect(PLUGIN_CATALOG.every((plugin) => plugin.status !== 'needs_credentials')).toBe(true);
  });

  it('reports catalog coverage stats', () => {
    const stats = catalogStats();
    expect(stats).toEqual({
      total: 112,
      implemented: 6,
      configurable: 106,
      needsCredentials: 0,
      blocked: 0,
      withHttpTest: 87,
    });
  });
});
