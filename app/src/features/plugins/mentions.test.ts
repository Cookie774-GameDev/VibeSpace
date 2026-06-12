import { describe, expect, it } from 'vitest';
import { PLUGIN_CATALOG } from './catalog';
import { extractPluginMentions, resolvePluginSlug } from './mentions';

describe('plugin mentions', () => {
  it('resolves catalog slugs and display names', () => {
    expect(resolvePluginSlug('github', PLUGIN_CATALOG)).toBe('github');
    expect(resolvePluginSlug('GitHub', PLUGIN_CATALOG)).toBe('github');
    expect(resolvePluginSlug('unknown', PLUGIN_CATALOG)).toBeUndefined();
  });

  it('extracts @slug, slash, and natural-language plugin references', () => {
    const ids = extractPluginMentions(
      'Please @github review this and /slack plugin notify the team. use the GitHub plugin for context.',
      PLUGIN_CATALOG,
    );
    expect(ids).toContain('github');
    expect(ids).toContain('slack');
    expect(ids.length).toBe(2);
  });
});
