import { describe, expect, it, vi } from 'vitest';
import { createContextMapRlmRepository } from '@/features/context/contextRlmProduction';

const charter =
  'PROJECT: BLUE KITE\nOwner: Mira Chen\nDepot: Cedar\nCurrent launch date: 2026-10-20\nAuthority: signed release record overrides planning notes.\n';
const log =
  Array.from(
    { length: 2500 },
    (_, i) => `Log ${i + 1}: Routine synthetic inspection, no launch authority.\n`,
  ).join('') + 'Log 2501: BLUE KITE cold-chain maximum is 7 hours.\n';
async function mapped(indexed = false, onlySubject = false) {
  const texts = [
    onlySubject ? 'PROJECT: BLUE KITE\nNo ownership decision is recorded.\n' : charter,
    log,
  ];
  if (indexed) texts.push(...Array.from({ length: 127 }, (_, i) => `Unrelated inspection ${i}.\n`));
  const contents = new Map(
    texts.map((text, i) => [
      `C:/fixture/${i === 0 ? 'charter.txt' : i === 1 ? 'long-log.txt' : `other-${i}.txt`}`,
      text,
    ]),
  );
  const hashes = new Map(
    await Promise.all(
      [...contents].map(
        async ([path, text]) =>
          [
            path,
            `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('')}`,
          ] as const,
      ),
    ),
  );
  const nodes = [...contents].map(([path, text], i) => ({
    id: `node-${i}`,
    kind: 'file' as const,
    title: path.split('/').at(-1)!,
    summary: '',
    path,
    sizeBytes: new TextEncoder().encode(text).length,
    modifiedAt: 20,
  }));
  // Deliberately reproduce OR-shaped index results. The production repository
  // must validate relevance itself rather than relying on an AND-only fixture.
  const lexicalSearch = vi.fn(async ({ query }: { query: string }) =>
    nodes
      .filter((n) =>
        query
          .toLowerCase()
          .split(/\s+/u)
          .some((term) => contents.get(n.path)!.toLowerCase().includes(term)),
      )
      .map((n) => ({ documentId: n.id, score: 1, excerpt: contents.get(n.path)!.slice(0, 100) })),
  );
  const repository = createContextMapRlmRepository({
    loadMaps: async () => [
      {
        id: 'precision-map',
        projectId: 'precision-project',
        rootDir: 'C:/fixture',
        status: 'active',
        updatedAt: 20,
        tree: { nodes },
      },
    ],
    stat: async (path) => ({
      ok: true,
      path,
      kind: 'file',
      size: new TextEncoder().encode(contents.get(path)!).length,
      createdMs: 20,
      modifiedMs: 20,
      sha256: hashes.get(path)!,
    }),
    read: async (path) => ({ ok: true, path, content: contents.get(path)! }),
    lexicalSearch,
  });
  return { repository, lexicalSearch };
}
const scope = { accountId: 'precision-account', projectId: 'precision-project' };
describe('production mapped factual retrieval precision', () => {
  it('retains subject matches for a query with no requested factual attribute', async () => {
    const { repository } = await mapped();
    expect(await repository.search(scope, 'PROJECT: BLUE KITE')).toHaveLength(2);
  });
  for (const indexed of [false, true])
    for (const attribute of ['owner', 'depot'])
      it(`excludes subject-only history for ${attribute}, indexed=${indexed}`, async () => {
        expect(new TextEncoder().encode(charter).length).toBe(140);
        const { repository, lexicalSearch } = await mapped(indexed);
        const hits = await repository.search(scope, `BLUE KITE ${attribute}`);
        expect(lexicalSearch).toHaveBeenCalled();
        expect(hits).toHaveLength(1);
        expect(hits[0]!.preview).toContain('Owner: Mira Chen');
      });
  it('keeps an exact named source even when it lacks the requested attribute', async () => {
    const { repository } = await mapped();
    const hits = await repository.search(scope, 'Owner in C:/fixture/long-log.txt');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.preview).toContain('long-log.txt');
  });
  it('preserves subject-only fallback when no admitted record carries the attribute', async () => {
    const { repository } = await mapped(false, true);
    const hits = await repository.search(scope, 'BLUE KITE owner');
    expect(hits.length).toBeGreaterThan(0);
  });
});
