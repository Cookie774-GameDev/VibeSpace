import { describe, expect, it } from 'vitest';
import { withSiyuanGraphNavigation } from './siyuanGraphNavigation';
import type { SiyuanSafeIndexEntry } from './siyuanSafeIndex';
const entries: SiyuanSafeIndexEntry[] = ['src', 'src/deep', 'src/deep/file.ts'].map((path, i) => ({
  nodeId: `path:${path}`,
  parentNodeId: i ? `path:${['src', 'src/deep'][i - 1]}` : null,
  title: path.split('/').at(-1)!,
  kind: i === 2 ? 'file' : 'area',
  relativePath: path,
  sourcePointer: `C:/project/${path}`,
  summary: null,
  sizeBytes: null,
  modifiedAt: null,
}));
const bindings = Object.fromEntries(
  entries.map((entry, i) => [entry.nodeId, `20260911181841-aaaaaa${i}`]),
);
describe('managed SiYuan recursive graph navigation', () => {
  it('links every nested source item using its existing native identity', () => {
    const result = withSiyuanGraphNavigation(
      '# Existing map\n\nUser notes stay.\n',
      entries,
      bindings,
    );
    for (const id of Object.values(bindings)) expect(result).toContain(`((${id} `);
    expect(result).toContain('src/deep/file.ts');
    expect(result).toMatch(/^# Existing map\n\nUser notes stay\.\n/);
  });
  it('is idempotent after SiYuan adds block attributes', () => {
    const first = withSiyuanGraphNavigation('# Map\n', entries, bindings);
    const normalized = first.replace(
      '## All source items',
      '## All source items\n{: id="20260911181841-zzzzzzz"}',
    );
    expect(withSiyuanGraphNavigation(normalized, entries, bindings)).toBe(normalized);
  });
  it('refreshes only the owned section when an item is added', () => {
    const first =
      withSiyuanGraphNavigation('# Map\n', entries.slice(0, 2), bindings) + '\nUser tail.\n';
    const refreshed = withSiyuanGraphNavigation(first, entries, bindings);
    expect(refreshed.match(/## All source items/g)).toHaveLength(1);
    expect(refreshed).toContain('src/deep/file.ts');
    expect(refreshed).toContain('User tail.');
  });
  it('rejects incomplete native bindings instead of displaying a partial map', () => {
    expect(() => withSiyuanGraphNavigation('# Map', entries, {})).toThrow(
      'siyuan_graph_navigation_binding_missing',
    );
  });
  it('does not turn labels into extra references or table columns', () => {
    const malicious = [
      {
        ...entries[2]!,
        title: 'file" | ((20260911181841-xxxxxxx "other',
        relativePath: 'src/a|b.ts',
      },
    ];
    const result = withSiyuanGraphNavigation('# Map', malicious, bindings);
    expect(result).not.toContain('((20260911181841-xxxxxxx');
    expect(result).not.toContain('src/a|b.ts');
  });
  it('does not duplicate or consume a damaged managed section', () => {
    expect(() =>
      withSiyuanGraphNavigation(
        '<!-- vibespace-context-navigation:v1 checksum=bad -->',
        entries,
        bindings,
      ),
    ).toThrow('siyuan_graph_navigation_section_invalid');
  });
  it('fails explicitly rather than silently truncating a large map', () => {
    expect(() => withSiyuanGraphNavigation('x'.repeat(900_000), entries, bindings)).toThrow(
      'siyuan_context_map_requires_sharding',
    );
  });
});
