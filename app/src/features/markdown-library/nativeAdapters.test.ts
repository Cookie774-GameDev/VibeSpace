import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { sha256Text } from '@/lib/fs';
import {
  createDexieMarkdownIndexStore,
  openNativeMarkdownLibrary,
  type MarkdownLibraryIndexStore,
} from './nativeAdapters';
import type { MarkdownLibrarySnapshot } from './runtime';

function fixture() {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const snapshots = new Map<string, MarkdownLibrarySnapshot>();
  const indexStore: MarkdownLibraryIndexStore = {
    async read(key) {
      return snapshots.get(key);
    },
    async compareAndSet(key, expectedGeneration, next) {
      if ((snapshots.get(key)?.generation ?? 0) !== expectedGeneration) return false;
      snapshots.set(key, structuredClone(next));
      return true;
    },
  };
  const files = {
    async createDirectory(path: string) {
      folders.add(path);
      return { ok: true as const, path, created: true };
    },
    async list(path: string) {
      const prefix = `${path}\\`;
      return {
        ok: true as const,
        path,
        entries: [...content.keys()]
          .filter(
            (candidate) =>
              candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('\\'),
          )
          .map((candidate) => ({
            name: candidate.slice(prefix.length),
            path: candidate,
            isDir: false,
          })),
      };
    },
    async read(path: string) {
      const value = content.get(path);
      return value === undefined
        ? { ok: false as const, path, error: { code: 'not_found' as const } }
        : { ok: true as const, path, content: value };
    },
    async compareAndSwap(path: string, expectedSha256: `sha256:${string}` | null, next: string) {
      const before = content.get(path);
      const hash = before === undefined ? null : await sha256Text(before);
      if (hash !== expectedSha256) {
        return {
          ok: false as const,
          path,
          error: { code: before === undefined ? ('not_found' as const) : ('stale_base' as const) },
        };
      }
      content.set(path, next);
      return {
        ok: true as const,
        path,
        beforeSha256: hash,
        afterSha256: await sha256Text(next),
        beforeBytes: before?.length ?? 0,
        afterBytes: next.length,
      };
    },
  };
  return { files, indexStore, content, folders, snapshots };
}

describe('native Markdown library adapters', () => {
  it('stores generation compare-and-set atomically in the local database', async () => {
    const store = createDexieMarkdownIndexStore();
    const key = 'markdown-library-test:a5q15';
    const first: MarkdownLibrarySnapshot = {
      generation: 1,
      documents: [],
      revisions: [],
      pendingRollback: null,
    };
    expect(await store.read(key)).toBeUndefined();
    expect(await store.compareAndSet(key, 0, first)).toBe(true);
    expect(await store.compareAndSet(key, 0, { ...first, generation: 2 })).toBe(false);
    expect(await createDexieMarkdownIndexStore().read(key)).toEqual(first);
  });

  it('persists physical Markdown and scoped revisions across new sessions', async () => {
    const deps = fixture();
    const options = { dataRoot: 'C:\\app-data', files: deps.files, indexStore: deps.indexStore };
    const first = await openNativeMarkdownLibrary('account-one', 'project-one', options);
    const created = await first.authority.create(first.scope, { title: 'Plan', body: 'Before' });
    const saved = await first.authority.save(first.scope, created.documentId, 1, '# Plan\n\nAfter');
    expect(deps.content.get(saved.path)).toBe('# Plan\n\nAfter');
    expect(deps.folders.has(first.scope.root)).toBe(true);

    const reopened = await openNativeMarkdownLibrary('account-one', 'project-one', options);
    expect(await reopened.authority.open(reopened.scope, saved.documentId)).toEqual({
      document: saved,
      content: '# Plan\n\nAfter',
    });
    expect((await reopened.authority.history(reopened.scope, saved.documentId)).items).toHaveLength(
      2,
    );
  });

  it('keeps the same project ID separate across accounts and rejects outside file edits', async () => {
    const deps = fixture();
    const options = { dataRoot: 'C:\\app-data', files: deps.files, indexStore: deps.indexStore };
    const accountA = await openNativeMarkdownLibrary('account-a', 'project-shared', options);
    const accountB = await openNativeMarkdownLibrary('account-b', 'project-shared', options);
    const created = await accountA.authority.create(accountA.scope, {
      title: 'Private',
      body: 'Only A',
    });
    expect(accountB.scope.root).not.toBe(accountA.scope.root);
    expect(await accountB.authority.reindex(accountB.scope)).toEqual([]);
    expect(await accountB.authority.list(accountB.scope, { query: 'Private' })).toEqual([]);

    deps.content.set(created.path, '# Private\n\nExternal change');
    await expect(accountA.authority.open(accountA.scope, created.documentId)).rejects.toThrow(
      'markdown_library_file_stale',
    );
    await expect(
      accountA.authority.save(accountA.scope, created.documentId, 1, '# Private\n\nClobber'),
    ).rejects.toThrow('markdown_library_file_stale');
    expect(deps.content.get(created.path)).toBe('# Private\n\nExternal change');
  });

  it('recovers physical files when the scoped index is absent', async () => {
    const deps = fixture();
    const options = { dataRoot: 'C:\\app-data', files: deps.files, indexStore: deps.indexStore };
    const first = await openNativeMarkdownLibrary('account-a', 'project-a', options);
    const created = await first.authority.create(first.scope, { title: 'Recovered', body: 'Body' });
    deps.snapshots.clear();
    const reopened = await openNativeMarkdownLibrary('account-a', 'project-a', options);
    expect((await reopened.authority.reindex(reopened.scope)).map((row) => row.documentId)).toEqual(
      [created.documentId],
    );
  });
});
