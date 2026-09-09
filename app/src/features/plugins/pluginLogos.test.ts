import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG } from './catalog';
import { getPluginLogoSources } from './pluginLogos';

describe('plugin logos', () => {
  it('uses bundled logo assets for known catalog mappings', () => {
    expect(
      getPluginLogoSources({
        id: 'github',
        credentialUrl: 'https://github.com/settings/tokens',
        docsUrl: 'https://docs.github.com/',
      }),
    ).toEqual(['/plugin-logos/github.svg']);

    const sources = PLUGIN_CATALOG.flatMap((plugin) => getPluginLogoSources(plugin));
    expect(sources.every((source) => source.startsWith('/plugin-logos/'))).toBe(true);
    expect(
      sources.some((source) =>
        /(^|\.)(google|gstatic)\./i.test(new URL(source, 'http://localhost').hostname),
      ),
    ).toBe(false);
  });

  it('uses the component fallback instead of a favicon proxy for unmapped plugins', () => {
    expect(
      getPluginLogoSources({
        id: 'unmapped-provider',
        credentialUrl: 'https://accounts.example.test/credentials',
        docsUrl: 'https://docs.example.test/',
      }),
    ).toEqual([]);
  });
});
