import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type NativeSkillSelectionReference,
  type NativeSkillSelectionScope,
  type NativeSkillSelectionStorage,
} from './nativeSkillSelectionStore';
import { nativeSkillCatalogReference, useNativeSkillSelection } from './useNativeSkillSelection';

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
  path: 'C:\\repo-one\\.agents\\skills\\safe-fast-fix\\SKILL.md',
  sourceRevision: 'catalog:revision-one',
  executionHost: 'local-host',
};

afterEach(cleanup);

describe('native skill selection hook', () => {
  it('restores selections as required until the fresh exact catalog revalidates them', async () => {
    const storage = createMemoryStorage();
    const first = renderHook(
      ({ catalog }) => useNativeSkillSelection({ scope, catalog, storage }),
      {
        initialProps: {
          catalog: [reference] as readonly NativeSkillSelectionReference[] | undefined,
        },
      },
    );

    act(() => {
      expect(first.result.current.select(reference).ok).toBe(true);
    });
    expect(first.result.current.canDispatch).toBe(true);
    expect(first.result.current.selectedReferences).toEqual([reference]);
    const stableEntries = first.result.current.entries;
    first.rerender({ catalog: [reference] });
    expect(first.result.current.entries).toBe(stableEntries);
    first.rerender({ catalog: undefined });
    expect(first.result.current.canDispatch).toBe(false);
    expect(first.result.current.selectedReferences).toEqual([]);
    first.unmount();

    const restored = renderHook(() =>
      useNativeSkillSelection({ scope, catalog: undefined, storage }),
    );
    expect(restored.result.current.entries).toMatchObject([{ revalidation: 'required' }]);
    expect(restored.result.current.selectedReferences).toEqual([]);
    expect(restored.result.current.canDispatch).toBe(false);
    expect(restored.result.current.error).toBe('revalidation_required');

    restored.rerender();
    // The same absent catalog is not evidence that a persisted reference is valid.
    expect(restored.result.current.canDispatch).toBe(false);
    expect(restored.result.current.entries).toMatchObject([{ revalidation: 'required' }]);
  });

  it('revalidates restored entries against the current exact path and metadata revision', async () => {
    const storage = createMemoryStorage();
    const initial = renderHook(() =>
      useNativeSkillSelection({ scope, catalog: [reference], storage }),
    );
    act(() => {
      initial.result.current.select(reference);
    });
    initial.unmount();

    const changedReference = { ...reference, sourceRevision: 'catalog:revision-two' };
    const restored = renderHook(() =>
      useNativeSkillSelection({ scope, catalog: [changedReference], storage }),
    );
    await waitFor(() =>
      expect(restored.result.current.entries).toMatchObject([{ revalidation: 'stale' }]),
    );
    expect(restored.result.current.selectedReferences).toEqual([]);
    expect(restored.result.current.canDispatch).toBe(false);
    expect(restored.result.current.error).toBe('revalidation_required');
    act(() => {
      restored.result.current.remove(reference);
    });
    expect(restored.result.current.entries).toEqual([]);
    expect(restored.result.current.canDispatch).toBe(true);
  });

  it('isolates saved selections by exact working directory', () => {
    const storage = createMemoryStorage();
    const first = renderHook(() =>
      useNativeSkillSelection({ scope, catalog: [reference], storage }),
    );
    act(() => {
      first.result.current.select(reference);
    });
    first.unmount();

    const otherRoot = { ...scope, workingDirectory: 'C:\\repo-two' };
    const otherReference = {
      ...reference,
      path: 'C:\\repo-two\\.agents\\skills\\safe-fast-fix\\SKILL.md',
    };
    const other = renderHook(() =>
      useNativeSkillSelection({ scope: otherRoot, catalog: undefined, storage }),
    );
    expect(other.result.current.entries).toEqual([]);
    expect(other.result.current.selectedReferences).toEqual([]);
    expect(other.result.current.canDispatch).toBe(true);
  });

  it('rejects a reference that is not in the current eligible catalog', () => {
    const storage = createMemoryStorage();
    const result = renderHook(() =>
      useNativeSkillSelection({ scope, catalog: [reference], storage }),
    );
    const unavailable = { ...reference, name: 'not-in-catalog' };

    let selection: ReturnType<typeof result.result.current.select> | undefined;
    act(() => {
      selection = result.result.current.select(unavailable);
    });

    expect(selection).toEqual({ ok: false, error: 'invalid_reference' });
    expect(result.result.current.entries).toEqual([]);
    expect(result.result.current.selectedReferences).toEqual([]);
  });

  it('does not rescan the same catalog to rebuild its key after selecting a skill', () => {
    let mapCalls = 0;
    const catalog = new Proxy([reference] as readonly NativeSkillSelectionReference[], {
      get(target, property, receiver) {
        if (property === 'map') mapCalls += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const storage = createMemoryStorage();
    const result = renderHook(() => useNativeSkillSelection({ scope, catalog, storage }));
    const mapCallsBeforeSelection = mapCalls;

    act(() => {
      expect(result.result.current.select(reference).ok).toBe(true);
    });

    // The store still maps the catalog once to revalidate persisted selections.
    // The hook should reuse its catalog snapshot for the state update render.
    expect(mapCalls - mapCallsBeforeSelection).toBe(1);
    expect(result.result.current.canDispatch).toBe(true);
    expect(result.result.current.selectedReferences).toEqual([reference]);
  });

  it('builds a stable SHA-256 metadata fingerprint without retaining descriptor content', async () => {
    const base = {
      origin: 'opencode' as const,
      name: 'safe-fast-fix',
      path: reference.path,
      executionHost: reference.executionHost,
    };
    const first = await nativeSkillCatalogReference({
      ...base,
      metadata: { cwd: scope.workingDirectory, path: reference.path, name: reference.name },
    });
    const reordered = await nativeSkillCatalogReference({
      ...base,
      metadata: { name: reference.name, cwd: scope.workingDirectory, path: reference.path },
    });
    const changed = await nativeSkillCatalogReference({
      ...base,
      metadata: {
        cwd: scope.workingDirectory,
        path: reference.path,
        name: reference.name,
        description: 'Updated metadata only',
      },
    });

    expect(first.sourceRevision).toMatch(/^catalog:[a-f0-9]{64}$/u);
    expect(reordered.sourceRevision).toBe(first.sourceRevision);
    expect(changed.sourceRevision).not.toBe(first.sourceRevision);
    expect(first).not.toHaveProperty('metadata');
    await expect(
      nativeSkillCatalogReference({ ...base, metadata: { body: 'private skill body' } }),
    ).rejects.toThrow(/metadata/iu);
    await expect(
      nativeSkillCatalogReference({
        ...base,
        metadata: { instructionsMarkdown: 'private skill body' },
      }),
    ).rejects.toThrow(/metadata/iu);
  });
});
