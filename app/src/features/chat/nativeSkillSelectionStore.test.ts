import { describe, expect, it } from 'vitest';
import {
  createNativeSkillSelectionStore,
  type NativeSkillSelectionReference,
  type NativeSkillSelectionScope,
  type NativeSkillSelectionStorage,
} from './nativeSkillSelectionStore';

function createMemoryStorage(): NativeSkillSelectionStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const scope: NativeSkillSelectionScope = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  projectId: 'project-a',
  chatId: 'chat-a',
  harness: 'opencode',
  executionHost: 'local-host',
  workingDirectory: 'C:\\repo-one',
};

const reference: NativeSkillSelectionReference = {
  origin: 'opencode',
  name: 'safe-fast-fix',
  path: 'C:\\Users\\viper\\.agents\\skills\\safe-fast-fix\\SKILL.md',
  sourceRevision: 'sha256:revision-one',
  executionHost: 'local-host',
};

describe('native skill selection store', () => {
  it('persists exact references only within the full account/workspace/project/chat/harness/host/root scope', () => {
    const storage = createMemoryStorage();
    const store = createNativeSkillSelectionStore(storage);
    expect(store.upsert(scope, reference)).toMatchObject({ ok: true });
    expect(store.selectedForDispatch(scope)).toEqual({ ok: false, error: 'revalidation_required' });
    expect(store.revalidate(scope, [reference])).toMatchObject({
      ok: true,
      value: { entries: [{ ...reference, revalidation: 'validated' }] },
    });
    expect(store.selectedForDispatch(scope)).toEqual({ ok: true, value: [reference] });

    for (const otherScope of [
      { ...scope, accountId: 'account-b' },
      { ...scope, workspaceId: 'workspace-b' },
      { ...scope, projectId: 'project-b' },
      { ...scope, chatId: 'chat-b' },
      { ...scope, harness: 'codex' as const },
      { ...scope, executionHost: 'remote-host' },
      { ...scope, workingDirectory: 'C:\\repo-two' },
    ]) {
      expect(store.read(otherScope)).toMatchObject({ ok: true, value: { entries: [] } });
      expect(store.selectedForDispatch(otherScope)).toEqual({ ok: true, value: [] });
    }
    const serialized = [...storage.values.values()].join('\n');
    expect(JSON.parse(serialized).entries[0].path).toBe(reference.path);
    expect(serialized).not.toMatch(/body|content|instructions/iu);
  });

  it('marks changed path or revision stale and never translates a stored path', () => {
    const store = createNativeSkillSelectionStore(createMemoryStorage());
    expect(store.upsert(scope, reference).ok).toBe(true);
    expect(
      store.revalidate(scope, [{ ...reference, sourceRevision: 'sha256:revision-two' }]),
    ).toMatchObject({
      ok: true,
      value: { entries: [{ revalidation: 'stale' }] },
    });
    expect(store.selectedForDispatch(scope)).toEqual({ ok: false, error: 'revalidation_required' });

    expect(
      store.upsert(scope, { ...reference, path: '/remote/native/path/SKILL.md' }),
    ).toMatchObject({
      ok: true,
      value: { entries: [{ path: '/remote/native/path/SKILL.md', revalidation: 'required' }] },
    });
    expect(
      store.revalidate(scope, [{ ...reference, path: '/remote/native/path/SKILL.md' }]),
    ).toMatchObject({
      ok: true,
      value: { entries: [{ path: '/remote/native/path/SKILL.md', revalidation: 'validated' }] },
    });
    expect(store.selectedForDispatch(scope)).toEqual({
      ok: true,
      value: [{ ...reference, path: '/remote/native/path/SKILL.md' }],
    });
  });

  it('revalidates a selected reference against a native catalog larger than the selection cap', () => {
    const store = createNativeSkillSelectionStore(createMemoryStorage());
    const catalog = Array.from({ length: 65 }, (_, index) => ({
      ...reference,
      name: `skill-${index}`,
      path: `C:\\repo-one\\skills\\skill-${index}\\SKILL.md`,
    }));
    store.upsert(scope, catalog[0]!);

    expect(store.revalidate(scope, catalog)).toMatchObject({ ok: true });
    expect(store.selectedForDispatch(scope)).toMatchObject({
      ok: true,
      value: [catalog[0]],
    });
  });

  it('supports remove, clear, and explicit return-to-revalidation lifecycle', () => {
    const store = createNativeSkillSelectionStore(createMemoryStorage());
    store.upsert(scope, reference);
    store.revalidate(scope, [reference]);
    expect(store.markNeedsRevalidation(scope)).toMatchObject({
      ok: true,
      value: { entries: [{ revalidation: 'required' }] },
    });
    expect(store.selectedForDispatch(scope)).toEqual({ ok: false, error: 'revalidation_required' });
    expect(store.revalidate(scope, [reference]).ok).toBe(true);
    expect(store.remove(scope, reference)).toMatchObject({ ok: true, value: { entries: [] } });
    store.upsert(scope, reference);
    expect(store.clear(scope)).toMatchObject({ ok: true, value: { entries: [] } });
    expect(store.read(scope)).toMatchObject({ ok: true, value: { entries: [] } });
  });

  it('fails closed on corrupt, cross-scope, duplicate, or body-bearing persisted state', () => {
    const storage = createMemoryStorage();
    const store = createNativeSkillSelectionStore(storage);
    store.upsert(scope, reference);
    const key = [...storage.values.keys()][0]!;
    const valid = storage.values.get(key)!;
    storage.values.set(key, '{invalid');
    expect(store.read(scope)).toEqual({ ok: false, error: 'malformed_state' });
    expect(store.upsert(scope, { ...reference, name: 'another' })).toEqual({
      ok: false,
      error: 'malformed_state',
    });

    const state = JSON.parse(valid) as Record<string, unknown>;
    const entry = (state.entries as Record<string, unknown>[])[0]!;
    storage.values.set(
      key,
      JSON.stringify({ ...state, entries: [{ ...entry, skillBody: 'never persist' }] }),
    );
    expect(store.selectedForDispatch(scope)).toEqual({ ok: false, error: 'malformed_state' });

    storage.values.set(
      key,
      JSON.stringify({ ...state, scope: { ...scope, chatId: 'other-chat' } }),
    );
    expect(store.read(scope)).toEqual({ ok: false, error: 'scope_mismatch' });
    expect(store.upsert(scope, { ...reference, name: 'another' })).toEqual({
      ok: false,
      error: 'scope_mismatch',
    });
  });

  it('rejects a reference from a different host and malformed reference metadata', () => {
    const store = createNativeSkillSelectionStore(createMemoryStorage());
    expect(store.upsert(scope, { ...reference, executionHost: 'remote-host' })).toEqual({
      ok: false,
      error: 'invalid_reference',
    });
    expect(store.upsert(scope, { ...reference, path: '   ' })).toEqual({
      ok: false,
      error: 'invalid_reference',
    });
  });

  it('fails closed on a rootless v1 selection without assigning it to the current working directory', () => {
    const storage = createMemoryStorage();
    const legacyScope = {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      chatId: scope.chatId,
      harness: scope.harness,
      executionHost: scope.executionHost,
    };
    const legacyKey =
      'vibespace.nativeSkillSelection.v1:' + encodeURIComponent(JSON.stringify(legacyScope));
    const legacyState = {
      version: 1,
      scope: legacyScope,
      entries: [{ ...reference, revalidation: 'validated' }],
    };
    const rawLegacyState = JSON.stringify(legacyState);
    storage.values.set(legacyKey, rawLegacyState);
    const store = createNativeSkillSelectionStore(storage);

    expect(store.read(scope)).toEqual({ ok: false, error: 'legacy_scope_missing' });
    expect(store.selectedForDispatch(scope)).toEqual({
      ok: false,
      error: 'legacy_scope_missing',
    });
    expect(storage.values.get(legacyKey)).toBe(rawLegacyState);

    // An explicit current-catalog selection can start a new root-scoped record; the old
    // rootless entry is neither copied nor trusted.
    expect(store.upsert(scope, reference)).toMatchObject({ ok: true });
    expect(store.read(scope)).toMatchObject({
      ok: true,
      value: { scope, entries: [{ ...reference, revalidation: 'required' }] },
    });
    expect(storage.values.get(legacyKey)).toBe(rawLegacyState);
  });
});
