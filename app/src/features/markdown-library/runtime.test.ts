import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Text } from '@/lib/fs';
import {
  createMarkdownLibraryAuthority,
  type MarkdownLibraryFilePort,
  type MarkdownLibraryRepository,
  type MarkdownLibrarySnapshot,
} from './runtime';

const scope = {
  accountId: 'account-alpha',
  projectId: 'project-alpha',
  root: 'C:\\repo',
} as const;

function emptySnapshot(): MarkdownLibrarySnapshot {
  return { generation: 0, documents: [], revisions: [], pendingRollback: null };
}

describe('Markdown Library authority', () => {
  let snapshot: MarkdownLibrarySnapshot;
  let files: Map<string, string>;
  let scan: ReturnType<typeof vi.fn<MarkdownLibraryFilePort['scanMarkdown']>>;
  let replace: ReturnType<typeof vi.fn<MarkdownLibraryRepository['replaceProjectIndex']>>;
  let compareAndWrite: ReturnType<typeof vi.fn<MarkdownLibraryFilePort['compareAndWrite']>>;
  let filePort: MarkdownLibraryFilePort;
  let repository: MarkdownLibraryRepository;

  beforeEach(() => {
    snapshot = emptySnapshot();
    files = new Map([
      ['C:\\repo\\docs\\generated\\goal-release.md', '# Release goal\nFirst'],
      ['C:\\repo\\docs\\generated\\policy-security.md', '# Security policy\nRules'],
    ]);
    scan = vi.fn(async () =>
      Array.from(files, ([path, content], index) => ({ path, content, modifiedAt: 100 + index })),
    );
    replace = vi.fn(async ({ expectedGeneration, next }) => {
      if (snapshot.generation !== expectedGeneration) return false;
      snapshot = next;
      return true;
    });
    compareAndWrite = vi.fn(async ({ path, expectedSha256, content }) => {
      const current = files.get(path);
      if (expectedSha256 === null) {
        if (current !== undefined) return false;
      } else if (current === undefined || (await sha256Text(current)) !== expectedSha256) {
        return false;
      }
      files.set(path, content);
      return true;
    });
    filePort = {
      scanMarkdown: scan,
      readText: vi.fn(async ({ path }) => files.get(path) ?? null),
      compareAndWrite,
    };
    repository = {
      readProjectIndex: vi.fn(async () => snapshot),
      replaceProjectIndex: replace,
    };
  });

  it('reindexes physical Markdown deterministically and fails closed for unsafe inventory', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    const indexed = await authority.reindex(scope);

    expect(indexed.map(({ kind, title, revision }) => ({ kind, title, revision }))).toEqual([
      { kind: 'goal', title: 'Release goal', revision: 1 },
      { kind: 'policy', title: 'Security policy', revision: 1 },
    ]);
    expect(indexed.map(({ path }) => path)).toEqual([...indexed.map(({ path }) => path)].sort());
    expect(snapshot.generation).toBe(1);
    expect(snapshot.revisions).toHaveLength(2);

    scan.mockResolvedValueOnce([
      { path: 'C:\\repo\\docs\\ok.md', content: '# Safe', modifiedAt: 1 },
      { path: 'C:\\outside\\escape.md', content: '# Unsafe', modifiedAt: 1 },
    ]);
    await expect(authority.reindex(scope)).rejects.toThrow('markdown_library_inventory_invalid');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('adds immutable history only when physical content changes', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    await authority.reindex(scope);
    await authority.reindex(scope);
    expect(snapshot.revisions).toHaveLength(2);

    files.set('C:\\repo\\docs\\generated\\goal-release.md', '# Release goal\nSecond');
    await authority.reindex(scope);
    const goal = snapshot.documents.find(({ kind }) => kind === 'goal');
    expect(goal?.revision).toBe(2);
    expect(
      snapshot.revisions.filter(({ documentId }) => documentId === goal?.documentId),
    ).toHaveLength(2);
  });

  it('reuses retained revision truth when a physical path is removed and later re-added', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    const original = files.get(path)!;

    await authority.reindex(scope);
    const originalDocument = snapshot.documents.find(({ path: candidate }) => candidate === path)!;
    files.delete(path);
    await authority.reindex(scope);
    files.set(path, original);
    await authority.reindex(scope);

    const restored = (await authority.list(scope)).find(
      ({ path: candidate }) => candidate === path,
    )!;
    expect(restored).toMatchObject({
      documentId: originalDocument.documentId,
      revision: 1,
      contentSha256: originalDocument.contentSha256,
    });
    expect(
      snapshot.revisions.filter(({ documentId }) => documentId === originalDocument.documentId),
    ).toHaveLength(1);
  });

  it('validates the complete replacement snapshot before repository CAS', async () => {
    snapshot = { ...emptySnapshot(), generation: Number.MAX_SAFE_INTEGER };
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });

    await expect(authority.reindex(scope)).rejects.toThrow('markdown_library_index_invalid');
    expect(replace).not.toHaveBeenCalled();
  });

  it('rejects an active document below its highest retained revision', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    await authority.reindex(scope);
    files.set(path, '# Release goal\nSecond');
    await authority.reindex(scope);
    const active = snapshot.documents.find(({ path: candidate }) => candidate === path)!;
    const stale = snapshot.revisions.find(
      ({ documentId, revision }) => documentId === active.documentId && revision === 1,
    )!;
    snapshot = {
      ...snapshot,
      documents: snapshot.documents.map((document) =>
        document.documentId === active.documentId
          ? {
              ...document,
              contentSha256: stale.contentSha256,
              sizeBytes: stale.sizeBytes,
              revision: stale.revision,
              indexedAt: stale.createdAt,
            }
          : document,
      ),
    };

    await expect(authority.list(scope)).rejects.toThrow('markdown_library_index_invalid');
  });

  it('lists and filters only bounded account/project metadata without revision content', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    await authority.reindex(scope);

    expect(await authority.list(scope, { query: 'security', kind: 'policy' })).toEqual([
      expect.objectContaining({ title: 'Security policy', kind: 'policy' }),
    ]);
    expect(await authority.list(scope, { limit: 1 })).toHaveLength(1);
    const goal = snapshot.documents.find(({ kind }) => kind === 'goal')!;
    expect(await authority.history(scope, goal.documentId)).toEqual({
      items: [
        {
          revision: 1,
          contentSha256: goal.contentSha256,
          sizeBytes: goal.sizeBytes,
          createdAt: 500,
        },
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(await authority.list(scope))).not.toContain('First');
    expect(JSON.stringify(await authority.history(scope, goal.documentId))).not.toContain('First');
  });

  it('paginates metadata-only history through a clamped stable document cursor', async () => {
    let now = 500;
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => now });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    await authority.reindex(scope);
    const id = snapshot.documents.find(({ path: candidate }) => candidate === path)!.documentId;
    files.set(path, '# Release goal\nSecond');
    now = 600;
    await authority.reindex(scope);
    files.set(path, '# Release goal\nThird');
    now = 700;
    await authority.reindex(scope);

    const first = await authority.history(scope, id, { limit: 2 });
    expect(first.items.map(({ revision }) => revision)).toEqual([3, 2]);
    expect(first.nextCursor).toEqual({ schemaVersion: 1, documentId: id, beforeRevision: 2 });
    const second = await authority.history(scope, id, { limit: 999, cursor: first.nextCursor! });
    expect(second.items.map(({ revision }) => revision)).toEqual([1]);
    expect(second.nextCursor).toBeNull();
    expect((await authority.history(scope, id, { limit: 0 })).items).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain('Third');

    const other = snapshot.documents.find(({ documentId }) => documentId !== id)!;
    await expect(
      authority.history(scope, id, {
        cursor: { schemaVersion: 1, documentId: other.documentId, beforeRevision: 2 },
      }),
    ).rejects.toThrow('markdown_library_history_cursor_invalid');

    const manyRevisions = await Promise.all(
      Array.from({ length: 205 }, async (_value, index) => {
        const revision = index + 1;
        const content = `# Release goal\nVersion ${revision}`;
        return {
          schemaVersion: 1 as const,
          documentId: id,
          revision,
          contentSha256: await sha256Text(content),
          sizeBytes: new TextEncoder().encode(content).byteLength,
          createdAt: 1_000 + revision,
          content,
        };
      }),
    );
    const latest = manyRevisions.at(-1)!;
    snapshot = {
      generation: snapshot.generation + 1,
      documents: snapshot.documents.map((candidate) =>
        candidate.documentId === id
          ? {
              ...candidate,
              contentSha256: latest.contentSha256,
              sizeBytes: latest.sizeBytes,
              revision: latest.revision,
              indexedAt: latest.createdAt,
            }
          : candidate,
      ),
      revisions: [
        ...snapshot.revisions.filter(({ documentId }) => documentId !== id),
        ...manyRevisions,
      ],
      pendingRollback: null,
    };
    expect((await authority.history(scope, id, { limit: 999 })).items).toHaveLength(200);
  });

  it('rolls back through exact file and index authority while appending a new revision', async () => {
    let now = 500;
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => now });
    await authority.reindex(scope);
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    files.set(path, '# Release goal\nSecond');
    now = 600;
    await authority.reindex(scope);
    const before = snapshot.documents.find(({ path: candidate }) => candidate === path)!;

    now = 700;
    const rolledBack = await authority.rollback(scope, before.documentId, 1);

    expect(files.get(path)).toBe('# Release goal\nFirst');
    expect(rolledBack.revision).toBe(3);
    expect(
      snapshot.revisions.map(({ revision }) => revision).filter((revision) => revision === 3),
    ).toEqual([3]);
    expect(compareAndWrite).toHaveBeenCalledWith(
      expect.objectContaining({ path, expectedSha256: before.contentSha256 }),
    );
  });

  it('recognizes repository throw-after-commit truth without compensating the committed file', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 700 });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    const firstContent = files.get(path)!;
    await authority.reindex(scope);
    files.set(path, '# Release goal\nSecond');
    await authority.reindex(scope);
    const document = snapshot.documents.find(({ path: candidate }) => candidate === path)!;
    let acknowledgementLost = false;
    replace.mockImplementation(async ({ expectedGeneration, next }) => {
      if (snapshot.generation !== expectedGeneration) return false;
      snapshot = next;
      if (!acknowledgementLost && next.pendingRollback === null) {
        acknowledgementLost = true;
        throw new Error('commit acknowledgement lost');
      }
      return true;
    });

    await expect(authority.rollback(scope, document.documentId, 1)).resolves.toMatchObject({
      revision: 3,
    });
    expect(files.get(path)).toBe(firstContent);
    expect(
      snapshot.documents.find(({ documentId }) => documentId === document.documentId),
    ).toMatchObject({ revision: 3 });
  });

  it('recovers a durable prepared rollback after reload by restoring the indexed file truth', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 700 });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    const firstContent = files.get(path)!;
    await authority.reindex(scope);
    files.set(path, '# Release goal\nSecond');
    await authority.reindex(scope);
    const document = snapshot.documents.find(({ path: candidate }) => candidate === path)!;
    files.set(path, firstContent);
    snapshot = {
      ...snapshot,
      generation: snapshot.generation + 1,
      pendingRollback: {
        schemaVersion: 1,
        documentId: document.documentId,
        fromRevision: document.revision,
        targetRevision: 1,
        createdAt: 700,
      },
    };

    const reloaded = createMarkdownLibraryAuthority({ filePort, repository, now: () => 800 });
    await reloaded.list(scope);

    expect(files.get(path)).toBe('# Release goal\nSecond');
    expect(snapshot.pendingRollback).toBeNull();
  });

  it('serializes exact-scope reads and reindex behind a live prepared rollback', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 700 });
    const path = 'C:\\repo\\docs\\generated\\goal-release.md';
    await authority.reindex(scope);
    files.set(path, '# Release goal\nSecond');
    await authority.reindex(scope);
    const document = snapshot.documents.find(({ path: candidate }) => candidate === path)!;
    let releaseWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeEntered!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      writeEntered = resolve;
    });
    compareAndWrite.mockImplementationOnce(async ({ path: candidate, expectedSha256, content }) => {
      writeEntered();
      await writeReleased;
      const current = files.get(candidate);
      if (current === undefined || (await sha256Text(current)) !== expectedSha256) return false;
      files.set(candidate, content);
      return true;
    });

    const rollback = authority.rollback(scope, document.documentId, 1);
    await writeStarted;
    expect(snapshot.pendingRollback).not.toBeNull();
    const reloaded = createMarkdownLibraryAuthority({ filePort, repository, now: () => 800 });
    let settled = 0;
    const queued = [
      authority.list(scope),
      authority.history(scope, document.documentId),
      authority.reindex(scope),
      reloaded.list(scope),
    ].map((operation) => operation.then((value) => ((settled += 1), value)));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(0);
    expect(snapshot.pendingRollback).not.toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);

    releaseWrite();
    await expect(rollback).resolves.toMatchObject({ revision: 3 });
    await Promise.all(queued);
    expect(files.get(path)).toBe('# Release goal\nFirst');
    expect(snapshot.pendingRollback).toBeNull();
    expect(
      snapshot.documents.find(({ documentId }) => documentId === document.documentId),
    ).toMatchObject({ revision: 3 });
  });

  it.each([
    ['drive root', 'C:\\Repo', 'c:\\repo', 'C:\\Repo\\docs\\goal-release.md'],
    [
      'UNC root',
      '\\\\Server\\Share',
      '\\\\server\\share',
      '\\\\Server\\Share\\docs\\goal-release.md',
    ],
  ] as const)(
    'serializes mixed-case %s aliases as one physical scope',
    async (_label, firstRoot, secondRoot, path) => {
      snapshot = emptySnapshot();
      files = new Map([[path, '# Release goal\nFirst']]);
      let releaseScan!: () => void;
      const scanReleased = new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      let enterScan!: () => void;
      const scanEntered = new Promise<void>((resolve) => {
        enterScan = resolve;
      });
      scan.mockImplementationOnce(async () => {
        enterScan();
        await scanReleased;
        return [{ path, content: files.get(path)!, modifiedAt: 1 }];
      });
      const firstAuthority = createMarkdownLibraryAuthority({
        filePort,
        repository,
        now: () => 500,
      });
      const secondAuthority = createMarkdownLibraryAuthority({
        filePort,
        repository,
        now: () => 600,
      });
      const firstScope = { ...scope, root: firstRoot };
      const secondScope = { ...scope, root: secondRoot };

      const first = firstAuthority.reindex(firstScope);
      await scanEntered;
      let secondSettled = false;
      const second = secondAuthority.list(secondScope).then((documents) => {
        secondSettled = true;
        return documents;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(secondSettled).toBe(false);
      releaseScan();
      await first;
      await expect(second).resolves.toHaveLength(1);
    },
  );

  it('fails nested repository callbacks fast and releases the outer scope lease', async () => {
    const nestedScope = { ...scope, root: 'C:\\reentrant-repository' };
    let authority!: ReturnType<typeof createMarkdownLibraryAuthority>;
    let nestedResults: PromiseSettledResult<unknown>[] = [];
    let firstRead = true;
    repository = {
      ...repository,
      readProjectIndex: vi.fn(async () => {
        if (firstRead) {
          firstRead = false;
          nestedResults = await Promise.allSettled([
            authority.list(nestedScope),
            authority.history(nestedScope, 'mdoc_missing'),
            authority.reindex(nestedScope),
            authority.rollback(nestedScope, 'mdoc_missing', 1),
          ]);
        }
        return snapshot;
      }),
    };
    authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });

    const terminal = await Promise.race([
      authority.list(nestedScope).then(() => 'completed'),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 250)),
    ]);

    expect(terminal).toBe('completed');
    expect(nestedResults).toHaveLength(4);
    expect(
      nestedResults.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.message === 'markdown_library_scope_reentrant',
      ),
    ).toBe(true);
    await expect(authority.list(nestedScope)).resolves.toEqual([]);
  });

  it('fails nested file-port callbacks fast and releases the outer scope lease', async () => {
    const nestedScope = { ...scope, root: 'C:\\reentrant-file-port' };
    const path = 'C:\\reentrant-file-port\\goal-release.md';
    files = new Map([[path, '# Release goal\nFirst']]);
    let authority!: ReturnType<typeof createMarkdownLibraryAuthority>;
    let nestedResults: PromiseSettledResult<unknown>[] = [];
    scan.mockImplementationOnce(async () => {
      nestedResults = await Promise.allSettled([
        authority.list(nestedScope),
        authority.history(nestedScope, 'mdoc_missing'),
        authority.reindex(nestedScope),
        authority.rollback(nestedScope, 'mdoc_missing', 1),
      ]);
      return [{ path, content: files.get(path)!, modifiedAt: 1 }];
    });
    authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });

    const terminal = await Promise.race([
      authority.reindex(nestedScope).then(() => 'completed'),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 250)),
    ]);

    expect(terminal).toBe('completed');
    expect(nestedResults).toHaveLength(4);
    expect(
      nestedResults.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof Error &&
          result.reason.message === 'markdown_library_scope_reentrant',
      ),
    ).toBe(true);
    await expect(authority.list(nestedScope)).resolves.toHaveLength(1);
  });

  it('rejects stale files and compensates a physical rollback when index CAS loses', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    await authority.reindex(scope);
    const first = snapshot.documents[0]!;
    const secondContent = '# Release goal\nSecond';
    files.set(first.path, secondContent);
    await authority.reindex(scope);
    const document = snapshot.documents.find(({ documentId }) => documentId === first.documentId)!;
    files.set(document.path, '# Changed outside authority');
    await expect(authority.rollback(scope, document.documentId, 1)).rejects.toThrow(
      'markdown_library_file_stale',
    );
    expect(replace).toHaveBeenCalledTimes(2);

    files.set(document.path, secondContent);
    let rejectFinalOnce = true;
    replace.mockImplementation(async ({ expectedGeneration, next }) => {
      if (snapshot.generation !== expectedGeneration) return false;
      if (rejectFinalOnce && snapshot.pendingRollback && next.pendingRollback === null) {
        rejectFinalOnce = false;
        return false;
      }
      snapshot = next;
      return true;
    });

    await expect(authority.rollback(scope, document.documentId, 1)).rejects.toThrow(
      'markdown_library_index_conflict',
    );
    expect(files.get(document.path)).toBe(secondContent);
    expect(compareAndWrite).toHaveBeenCalledTimes(2);
  });

  it('compensates repository rejection and reports a terminal compensation failure exactly', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 500 });
    await authority.reindex(scope);
    const first = snapshot.documents[0]!;
    const secondContent = '# Release goal\nSecond';
    files.set(first.path, secondContent);
    await authority.reindex(scope);
    const document = snapshot.documents.find(({ documentId }) => documentId === first.documentId)!;

    let throwBeforeFinalOnce = true;
    replace.mockImplementation(async ({ expectedGeneration, next }) => {
      if (snapshot.generation !== expectedGeneration) return false;
      if (throwBeforeFinalOnce && snapshot.pendingRollback && next.pendingRollback === null) {
        throwBeforeFinalOnce = false;
        throw new Error('database unavailable');
      }
      snapshot = next;
      return true;
    });
    await expect(authority.rollback(scope, document.documentId, 1)).rejects.toThrow(
      'markdown_library_index_conflict',
    );
    expect(files.get(document.path)).toBe(secondContent);

    let rejectFinalOnce = true;
    replace.mockImplementation(async ({ expectedGeneration, next }) => {
      if (snapshot.generation !== expectedGeneration) return false;
      if (rejectFinalOnce && snapshot.pendingRollback && next.pendingRollback === null) {
        rejectFinalOnce = false;
        return false;
      }
      snapshot = next;
      return true;
    });
    compareAndWrite
      .mockImplementationOnce(async ({ path, content }) => {
        files.set(path, content);
        return true;
      })
      .mockResolvedValueOnce(false);
    await expect(authority.rollback(scope, document.documentId, 1)).rejects.toThrow(
      'markdown_library_rollback_compensation_failed',
    );
  });

  it('creates, searches body text, edits, and reopens a saved revision', async () => {
    const first = createMarkdownLibraryAuthority({ filePort, repository, now: () => 900 });
    const created = await first.create(scope, {
      title: 'Release notes',
      body: 'Copper compass 682',
    });
    expect(created.title).toBe('Release notes');
    expect(created.revision).toBe(1);
    expect(files.get(created.path)).toBe('# Release notes\n\nCopper compass 682');
    expect(
      (await first.list(scope, { query: 'compass' })).map((item) => item.documentId),
    ).toContain(created.documentId);

    const saved = await first.save(
      scope,
      created.documentId,
      created.revision,
      '# Release notes\n\nUpdated fact',
    );
    expect(saved.revision).toBe(2);
    expect(await first.revisionContent(scope, created.documentId, 1)).toBe(
      '# Release notes\n\nCopper compass 682',
    );
    const reloaded = createMarkdownLibraryAuthority({ filePort, repository, now: () => 1000 });
    expect(await reloaded.open(scope, created.documentId)).toEqual({
      document: saved,
      content: '# Release notes\n\nUpdated fact',
    });
    expect(
      (await reloaded.history(scope, created.documentId)).items.map((entry) => entry.revision),
    ).toEqual([2, 1]);
    expect(await reloaded.list(scope, { query: 'compass' })).not.toContainEqual(saved);
  });

  it('refuses stale edits and duplicate creates without overwriting physical content', async () => {
    const authority = createMarkdownLibraryAuthority({ filePort, repository, now: () => 900 });
    const created = await authority.create(scope, { title: 'Daily plan', body: 'First' });
    const saved = await authority.save(scope, created.documentId, 1, '# Daily plan\n\nSecond');
    await expect(
      authority.save(scope, created.documentId, 1, '# Daily plan\n\nStale'),
    ).rejects.toThrow('markdown_library_revision_stale');
    await expect(
      authority.create(scope, { title: 'Daily plan', body: 'Duplicate' }),
    ).rejects.toThrow('markdown_library_file_exists');
    expect(files.get(saved.path)).toBe('# Daily plan\n\nSecond');
  });
});
