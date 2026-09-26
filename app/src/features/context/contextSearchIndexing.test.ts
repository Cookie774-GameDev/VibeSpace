import { describe, expect, it, vi } from 'vitest';
import type { FsPathStatResult, FsReadResult } from '@/lib/fs';
import {
  createContextSearchIndexPopulationPort,
  type ContextSearchIndexMap,
} from './contextSearchIndexing';
import type { ContextSearchIndexPort } from './contextSearchPipeline';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function map(
  nodes = [
    { id: 'node-b', kind: 'file', title: 'b.txt', path: 'b.txt', modifiedAt: 20 },
    { id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt', modifiedAt: 10 },
  ] as ContextSearchIndexMap['tree']['nodes'],
): ContextSearchIndexMap {
  return {
    id: 'map-1',
    projectId: 'project-1',
    rootDir: 'C:\\repo',
    status: 'active',
    updatedAt: 30,
    sourceType: 'local_folder',
    tree: { nodes },
  };
}

function nativePort() {
  let count = 0;
  const port: ContextSearchIndexPort = {
    status: vi.fn(async () => ({
      documentCount: count,
      indexId: 'index-1',
      engine: 'tantivy-0.22.1',
      schemaVersion: 1,
      recoveredCorruption: false,
      needsRebuild: false,
    })),
    replaceDocuments: vi.fn(async (_accountId, _mapId, documents) => {
      count += documents.length;
      return { affectedDocuments: documents.length, documentCount: count };
    }),
    deleteDocuments: vi.fn(async (_accountId, _mapId, documentIds) => {
      count = Math.max(0, count - documentIds.length);
      return { affectedDocuments: documentIds.length, documentCount: count };
    }),
  };
  return port;
}

function dependencies(contents: Record<string, string>, port = nativePort()) {
  const encoder = new TextEncoder();
  const stat = vi.fn(async (path: string): Promise<FsPathStatResult> => {
    const content = contents[path];
    if (content === undefined) return { ok: false, path, error: { code: 'not_found' } };
    return {
      ok: true,
      path,
      kind: 'file',
      size: encoder.encode(content).byteLength,
      modifiedMs: path.endsWith('a.txt') ? 10 : 20,
      sha256: `sha256:${path.endsWith('a.txt') ? HASH_A : HASH_B}`,
    };
  });
  const read = vi.fn(
    async (path: string): Promise<FsReadResult> => ({
      ok: true,
      path,
      content: contents[path]!,
    }),
  );
  const hash = vi.fn(async (content: string) =>
    content === contents['C:\\repo\\a.txt']
      ? (`sha256:${HASH_A}` as const)
      : (`sha256:${HASH_B}` as const),
  );
  return { port, stat, read, hash };
}

describe('bounded Context search index population', () => {
  it('indexes a NuttX-scale 5,734-file map through bounded native batches', async () => {
    const nodes = Array.from({ length: 5_734 }, (_, index) => ({
      id: `node-${index}`, kind: 'file', title: `${index}.c`, path: `${index}.c`,
    }));
    const deps = dependencies({});
    const nativeDelete = vi.mocked(deps.port.deleteDocuments).getMockImplementation()!;
    vi.mocked(deps.port.deleteDocuments).mockImplementation(async (accountId, mapId, documentIds) => {
      if (documentIds.length > 1_000) throw new Error('native_delete_limit_exceeded');
      return nativeDelete(accountId, mapId, documentIds);
    });
    deps.stat.mockImplementation(async (path) => ({
      ok: true, path, kind: 'file', size: 1, modifiedMs: 1,
      sha256: `sha256:${HASH_A}`,
    }));
    deps.read.mockImplementation(async (path) => ({ ok: true, path, content: 'x' }));
    deps.hash.mockResolvedValue(`sha256:${HASH_A}`);

    const result = await createContextSearchIndexPopulationPort(deps)
      .populateCreatedMap('account-1', map(nodes));

    expect(result).toMatchObject({ documentCount: 5_734, status: 'ready' });
    const batches = vi.mocked(deps.port.replaceDocuments).mock.calls.map((call) => call[2]);
    expect(batches).toHaveLength(Math.ceil(5_734 / 64));
    expect(batches.every((batch) => batch.length > 0 && batch.length <= 64)).toBe(true);
    expect(vi.mocked(deps.port.deleteDocuments).mock.calls.every((call) => call[2].length <= 1_000)).toBe(true);
  });

  it('accepts a native Windows verbatim drive root without weakening the snapshot gate', async () => {
    const deps = dependencies({});
    const target = {
      ...map([]),
      rootDir: '\\\\?\\C:\\Users\\viper\\Documents\\AccessRevamp Campaigns\\AR-OUTREACH',
    };

    await expect(
      createContextSearchIndexPopulationPort(deps).populateCreatedMap('account-1', target),
    ).resolves.toEqual({
      mapId: 'map-1',
      documentCount: 0,
      bodyBytes: 0,
      status: 'ready',
    });
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.read).not.toHaveBeenCalled();
  });

  it('retries a transient Windows Tantivy commit denial for the same document batch', async () => {
    const deps = dependencies({ 'C:\\repo\\a.txt': 'alpha' });
    const normalReplace = vi.mocked(deps.port.replaceDocuments).getMockImplementation()!;
    vi.mocked(deps.port.replaceDocuments).mockImplementationOnce(async () => {
      throw new Error('context_search_commit: IoError PermissionDenied: Access is denied.');
    });
    vi.mocked(deps.port.replaceDocuments).mockImplementationOnce(normalReplace);

    await expect(createContextSearchIndexPopulationPort(deps).populateCreatedMap(
      'account-1', map([{ id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt' }]),
    )).resolves.toMatchObject({ status: 'ready', documentCount: 1 });
    expect(deps.port.replaceDocuments).toHaveBeenCalledTimes(2);
  });

  it('indexes admitted files deterministically with stable physical hashes', async () => {
    const deps = dependencies({
      'C:\\repo\\a.txt': 'alpha',
      'C:\\repo\\b.txt': 'bravo',
    });
    const population = createContextSearchIndexPopulationPort(deps);

    const receipt = await population.populateCreatedMap('account-1', map());

    expect(receipt).toEqual({
      mapId: 'map-1',
      documentCount: 2,
      bodyBytes: 10,
      status: 'ready',
    });
    expect(deps.port.replaceDocuments).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(deps.port.replaceDocuments).mock.calls[0]?.[2].map((item) => item.documentId),
    ).toEqual(['node-a', 'node-b']);
    expect(deps.stat).toHaveBeenCalledTimes(4);
    expect(deps.stat).toHaveBeenCalledWith('C:\\repo\\a.txt', true, {
      root: 'C:\\repo',
      strictProjectBoundary: true,
    });
    expect(deps.read).toHaveBeenCalledWith('C:\\repo\\a.txt', 1024 * 1024 + 1, {
      root: 'C:\\repo',
      strictProjectBoundary: true,
    });
  });

  it('keeps every native batch at 64 documents and four MiB', async () => {
    const nodes = Array.from({ length: 17 }, (_, index) => ({
      id: `node-${String(index).padStart(2, '0')}`,
      kind: 'file',
      title: `${index}.txt`,
      path: `${index}.txt`,
      modifiedAt: index,
    }));
    const contents = Object.fromEntries(
      nodes.map((node) => [`C:\\repo\\${node.path}`, 'x'.repeat(600 * 1024)]),
    );
    const deps = dependencies(contents);
    deps.hash.mockResolvedValue(`sha256:${HASH_A}`);
    deps.stat.mockImplementation(async (path) => ({
      ok: true,
      path,
      kind: 'file',
      size: 600 * 1024,
      modifiedMs: 1,
      sha256: `sha256:${HASH_A}`,
    }));

    await createContextSearchIndexPopulationPort(deps).populateCreatedMap('account-1', map(nodes));

    const batches = vi.mocked(deps.port.replaceDocuments).mock.calls.map((call) => call[2]);
    expect(batches.map((batch) => batch.length)).toEqual([6, 6, 5]);
    expect(
      batches.every(
        (batch) =>
        batch.length <= 64 &&
          batch.reduce(
            (sum, document) => sum + new TextEncoder().encode(document.body).length,
            0,
          ) <=
            4 * 1024 * 1024,
      ),
    ).toBe(true);
  });

  it('keeps metadata-only graph nodes out of full-text mutation without weakening admitted files', async () => {
    const deps = dependencies({ 'C:\\repo\\small.txt': 'small' });
    const population = createContextSearchIndexPopulationPort(deps);
    const receipt = await population.populateCreatedMap(
      'account-1',
      map([
        {
          id: 'small',
          kind: 'file',
          title: 'small.txt',
          path: 'small.txt',
          contentIndexEligible: true,
        },
        {
          id: 'large',
          kind: 'file',
          title: 'large.pile',
          path: 'large.pile',
          contentIndexEligible: false,
        },
      ]),
    );
    expect(receipt.documentCount).toBe(1);
    expect(deps.stat).not.toHaveBeenCalledWith(
      'C:\\repo\\large.pile',
      expect.anything(),
      expect.anything(),
    );
    expect(vi.mocked(deps.port.replaceDocuments).mock.calls[0]?.[2]).toHaveLength(1);
  });

  it('keeps oversized discovered bodies as metadata while indexing readable files', async () => {
    const deps = dependencies({
      'C:\\repo\\a.txt': 'alpha',
      'C:\\repo\\b.txt': 'x'.repeat(1024 * 1024 + 1),
    });
    const receipt = await createContextSearchIndexPopulationPort(deps).populateCreatedMap(
      'account-1',
      map(),
    );
    expect(receipt.documentCount).toBe(1);
    expect(receipt.bodyBytes).toBe(5);
    expect(deps.read.mock.calls.map(([path]) => path)).toEqual(['C:\\repo\\a.txt']);
    expect(vi.mocked(deps.port.replaceDocuments).mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ documentId: 'node-a', body: 'alpha' }),
    ]);
  });

  it('keeps an undecodable discovered file as graph metadata without aborting text indexing', async () => {
    const deps = dependencies({
      'C:\\repo\\a.txt': 'alpha',
      'C:\\repo\\after-built-open-1440x900.png': 'binary\uFFFDbytes',
    });

    const receipt = await createContextSearchIndexPopulationPort(deps).populateCreatedMap(
      'account-1',
      map([
        { id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt', modifiedAt: 10 },
        {
          id: 'node-image',
          kind: 'file',
          title: 'after-built-open-1440x900.png',
          path: 'after-built-open-1440x900.png',
          modifiedAt: 20,
        },
      ]),
    );

    expect(receipt).toEqual({
      mapId: 'map-1',
      documentCount: 1,
      bodyBytes: 5,
      status: 'ready',
    });
    expect(vi.mocked(deps.port.replaceDocuments).mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({ documentId: 'node-a', path: 'a.txt', body: 'alpha' }),
    ]);
  });

  it.each(['\u0000', '\u0001', '\u000b', '\u001f', '\u007f', '\u2028', '\u2029'])(
    'keeps valid UTF-8 containing unsafe control %j as graph metadata only',
    async (unsafeControl) => {
      const safeText = '你好\tline one\nline two\r\n';
      const deps = dependencies({
        'C:\\repo\\a.txt': safeText,
        'C:\\repo\\binary.dat': `valid UTF-8${unsafeControl}binary`,
      });

      const receipt = await createContextSearchIndexPopulationPort(deps).populateCreatedMap(
        'account-1',
        map([
          { id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt', modifiedAt: 10 },
          {
            id: 'node-binary',
            kind: 'file',
            title: 'binary.dat',
            path: 'binary.dat',
            modifiedAt: 20,
          },
        ]),
      );

      expect(receipt).toEqual({
        mapId: 'map-1',
        documentCount: 1,
        bodyBytes: new TextEncoder().encode(safeText).byteLength,
        status: 'ready',
      });
      expect(vi.mocked(deps.port.replaceDocuments).mock.calls[0]?.[2]).toEqual([
        expect.objectContaining({ documentId: 'node-a', path: 'a.txt', body: safeText }),
      ]);
      expect(deps.hash).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['traversal', '../escape.txt'],
    ['ADS', 'safe.txt:secret'],
    ['absolute', 'C:\\outside.txt'],
  ])('rejects %s paths before filesystem or native access', async (_label, path) => {
    const deps = dependencies({});
    await expect(
      createContextSearchIndexPopulationPort(deps).populateCreatedMap(
        'account-1',
        map([{ id: 'node-1', kind: 'file', title: 'unsafe', path }]),
      ),
    ).rejects.toThrow('context_search_index_snapshot_invalid');
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.port.replaceDocuments).not.toHaveBeenCalled();
  });

  it('rejects duplicate node IDs and normalized paths deterministically', async () => {
    const deps = dependencies({});
    for (const nodes of [
      [
        { id: 'same', kind: 'file', title: 'a', path: 'a.txt' },
        { id: 'same', kind: 'file', title: 'b', path: 'b.txt' },
      ],
      [
        { id: 'a', kind: 'file', title: 'a', path: 'Folder/A.txt' },
        { id: 'b', kind: 'file', title: 'b', path: 'folder/a.txt' },
      ],
    ]) {
      await expect(
        createContextSearchIndexPopulationPort(deps).populateCreatedMap('account-1', map(nodes)),
      ).rejects.toThrow('context_search_index_snapshot_invalid');
    }
  });

  it('keeps discovered secret nodes out of the derivative index and bounds map size', async () => {
    const denied = dependencies({ 'C:\\repo\\.env': 'API_KEY=not-indexable' });
    await expect(
      createContextSearchIndexPopulationPort(denied).populateCreatedMap(
        'account-1',
        map([{ id: 'node-env', kind: 'file', title: '.env', path: '.env' }]),
      ),
    ).resolves.toMatchObject({ status: 'ready', documentCount: 0 });
    expect(denied.port.replaceDocuments).not.toHaveBeenCalled();

    const mixed = dependencies({
      'C:\\repo\\a.txt': 'ordinary source',
      'C:\\repo\\b.sh': 'PASSWORD=example',
    });
    await expect(createContextSearchIndexPopulationPort(mixed).populateCreatedMap(
      'account-1', map([
        { id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt' },
        { id: 'node-b', kind: 'file', title: 'b.sh', path: 'b.sh' },
      ]),
    )).resolves.toMatchObject({ status: 'ready', documentCount: 1 });
    expect(vi.mocked(mixed.port.replaceDocuments).mock.calls[0]?.[2].map(item => item.documentId))
      .toEqual(['node-a']);

    const excessive = dependencies({});
    await expect(
      createContextSearchIndexPopulationPort(excessive).populateCreatedMap(
        'account-1',
        map(
          Array.from({ length: 10_001 }, (_, index) => ({
            id: `node-${index}`,
            kind: 'file',
            title: `${index}.txt`,
            path: `${index}.txt`,
          })),
        ),
      ),
    ).rejects.toThrow('context_search_index_snapshot_invalid');
    expect(excessive.stat).not.toHaveBeenCalled();
  });

  it('fails closed and cleans the snapshot when bytes or hashes change', async () => {
    const deps = dependencies({ 'C:\\repo\\a.txt': 'alpha' });
    deps.stat
      .mockResolvedValueOnce({
        ok: true,
        path: 'C:\\repo\\a.txt',
        kind: 'file',
        size: 5,
        modifiedMs: 10,
        sha256: `sha256:${HASH_A}`,
      })
      .mockResolvedValueOnce({
        ok: true,
        path: 'C:\\repo\\a.txt',
        kind: 'file',
        size: 5,
        modifiedMs: 11,
        sha256: `sha256:${HASH_B}`,
      });

    await expect(
      createContextSearchIndexPopulationPort(deps).populateCreatedMap(
        'account-1',
        map([{ id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt' }]),
      ),
    ).rejects.toThrow('context_search_index_source_changed');
    expect(deps.port.replaceDocuments).not.toHaveBeenCalled();
    expect(deps.port.deleteDocuments).toHaveBeenCalledWith('account-1', 'map-1', ['node-a']);
  });

  it('cleans partial mutations and verifies zero after cancellation', async () => {
    const deps = dependencies({
      'C:\\repo\\a.txt': 'alpha',
      'C:\\repo\\b.txt': 'bravo',
    });
    const controller = new AbortController();
    vi.mocked(deps.port.replaceDocuments).mockImplementationOnce(async (_a, _m, documents) => {
      controller.abort();
      return { affectedDocuments: documents.length, documentCount: documents.length };
    });

    await expect(
      createContextSearchIndexPopulationPort(deps).populateCreatedMap(
        'account-1',
        map(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.port.deleteDocuments).toHaveBeenCalledWith('account-1', 'map-1', [
      'node-a',
      'node-b',
    ]);
    expect(deps.port.status).toHaveBeenCalled();
  });

  it('repairs confirmed-empty maps and leaves nonempty maps untouched', async () => {
    const contents = { 'C:\\repo\\a.txt': 'alpha' };
    const empty = dependencies(contents);
    const current = dependencies(contents);
    vi.mocked(current.port.status).mockResolvedValue({
      documentCount: 1,
      indexId: 'index-1',
      engine: 'tantivy-0.22.1',
      schemaVersion: 1,
      recoveredCorruption: false,
      needsRebuild: false,
    });
    const target = map([{ id: 'node-a', kind: 'file', title: 'a.txt', path: 'a.txt' }]);

    await expect(
      createContextSearchIndexPopulationPort(empty).repairEmptyMap('account-1', target),
    ).resolves.toMatchObject({ status: 'ready', documentCount: 1 });
    await expect(
      createContextSearchIndexPopulationPort(current).repairEmptyMap('account-1', target),
    ).resolves.toMatchObject({ status: 'already_populated', documentCount: 1 });
    expect(current.port.replaceDocuments).not.toHaveBeenCalled();
  });

  it('serializes population across maps', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = dependencies({ 'C:\\repo\\a.txt': 'alpha' });
    const second = dependencies({ 'C:\\repo\\a.txt': 'alpha' });
    const firstMutation = vi.mocked(first.port.replaceDocuments).getMockImplementation()!;
    const secondMutation = vi.mocked(second.port.replaceDocuments).getMockImplementation()!;
    vi.mocked(first.port.replaceDocuments).mockImplementationOnce(async (_a, mapId, docs) => {
      order.push(`start:${mapId}`);
      await gate;
      order.push(`end:${mapId}`);
      return firstMutation(_a, mapId, docs);
    });
    vi.mocked(second.port.replaceDocuments).mockImplementationOnce(async (_a, mapId, docs) => {
      order.push(`start:${mapId}`);
      order.push(`end:${mapId}`);
      return secondMutation(_a, mapId, docs);
    });
    const targetA = map([{ id: 'node-a', kind: 'file', title: 'a', path: 'a.txt' }]);
    const targetB = { ...targetA, id: 'map-2' };

    const pendingA = createContextSearchIndexPopulationPort(first).populateCreatedMap(
      'account-1',
      targetA,
    );
    const pendingB = createContextSearchIndexPopulationPort(second).populateCreatedMap(
      'account-1',
      targetB,
    );
    await vi.waitFor(() => expect(order).toEqual(['start:map-1']));
    release();
    await Promise.all([pendingA, pendingB]);
    expect(order).toEqual(['start:map-1', 'end:map-1', 'start:map-2', 'end:map-2']);
  });
});
