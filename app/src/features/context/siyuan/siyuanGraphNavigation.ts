import type { SiyuanSafeIndexEntry } from './siyuanSafeIndex';
const PREFIX = '<!-- vibespace-context-navigation:v1 checksum=';
const END = '<!-- /vibespace-context-navigation:v1 -->';
const NATIVE_ID = /^\d{14}-[a-z0-9]{7}$/u;
const MAX_BYTES = 900_000;
function cell(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/[<>|"`\\()\r\n]/gu, (c) => `&#${c.charCodeAt(0)};`);
}
/** Actual block references keep the official local graph connected to every source depth. */
export function withSiyuanGraphNavigation(
  markdown: string,
  entries: readonly SiyuanSafeIndexEntry[],
  bindings: Readonly<Record<string, string>>,
): string {
  const rows = entries.map((entry) => {
    const id = bindings[entry.nodeId];
    if (!id || !NATIVE_ID.test(id)) throw new Error('siyuan_graph_navigation_binding_missing');
    return `| ((${id} "${cell(entry.title)}")) | ${cell(entry.relativePath ?? entry.title)} |`;
  });
  if (new Set(entries.map((entry) => bindings[entry.nodeId])).size !== entries.length) {
    throw new Error('siyuan_graph_navigation_binding_ambiguous');
  }
  let hash = 0x811c9dc5;
  for (const char of rows.join('\n')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  const start = `${PREFIX}${(hash >>> 0).toString(16)} -->`;
  const first = markdown.indexOf(PREFIX);
  const end = markdown.indexOf(END);
  if (
    first < 0 !== end < 0 ||
    (first >= 0 &&
      (end < first ||
        markdown.indexOf(PREFIX, first + PREFIX.length) >= 0 ||
        markdown.indexOf(END, end + END.length) >= 0))
  )
    throw new Error('siyuan_graph_navigation_section_invalid');
  if (new TextEncoder().encode(markdown).byteLength >= MAX_BYTES) {
    throw new Error('siyuan_context_map_requires_sharding');
  }
  if (first >= 0 && markdown.startsWith(start, first)) return markdown;
  const section = [
    start,
    '',
    '## All source items',
    '',
    'Source files stay read-only. Expand folders in VibeSpace for the exact hierarchy.',
    '',
    '| Source item | Source path |',
    '| --- | --- |',
    ...rows,
    '',
    END,
  ].join('\n');
  const result =
    first < 0
      ? `${markdown}\n\n${section}\n`
      : markdown.slice(0, first) + section + markdown.slice(end + END.length);
  if (new TextEncoder().encode(result).byteLength >= MAX_BYTES) {
    throw new Error('siyuan_context_map_requires_sharding');
  }
  return result;
}
