import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createNativeSkillSelectionStore,
  type NativeSkillSelectionEntry,
  type NativeSkillSelectionError,
  type NativeSkillSelectionReference,
  type NativeSkillSelectionResult,
  type NativeSkillSelectionScope,
  type NativeSkillSelectionState,
  type NativeSkillSelectionStorage,
} from './nativeSkillSelectionStore';

export type NativeSkillCatalogMetadataValue = string | number | boolean | null;
export type NativeSkillCatalogMetadata = Readonly<Record<string, NativeSkillCatalogMetadataValue>>;

export interface NativeSkillCatalogReferenceInput {
  origin: NativeSkillSelectionReference['origin'];
  name: string;
  path: string;
  executionHost: string;
  metadata: NativeSkillCatalogMetadata;
}

export interface UseNativeSkillSelectionOptions {
  scope: NativeSkillSelectionScope | null;
  /** Undefined while discovery is in flight; an empty array is a fresh empty catalog. */
  catalog: readonly NativeSkillSelectionReference[] | undefined;
  storage?: NativeSkillSelectionStorage;
}

export interface NativeSkillSelectionHookValue {
  /** Stable until the persisted selection or its validation state changes. */
  entries: readonly NativeSkillSelectionEntry[];
  /** Empty until every selected entry matches the current catalog exactly. */
  selectedReferences: readonly NativeSkillSelectionReference[];
  canDispatch: boolean;
  error: NativeSkillSelectionError | null;
  select(
    reference: NativeSkillSelectionReference,
  ): NativeSkillSelectionResult<NativeSkillSelectionState>;
  remove(
    reference: Pick<NativeSkillSelectionReference, 'origin' | 'name' | 'executionHost'>,
  ): NativeSkillSelectionResult<NativeSkillSelectionState>;
  clear(): NativeSkillSelectionResult<NativeSkillSelectionState>;
}

interface HookSnapshot {
  scopeKey: string | null;
  catalogKey: string | null;
  entries: readonly NativeSkillSelectionEntry[];
  error: NativeSkillSelectionError | null;
}

const EMPTY_ENTRIES: readonly NativeSkillSelectionEntry[] = Object.freeze([]);
const EMPTY_REFERENCES: readonly NativeSkillSelectionReference[] = Object.freeze([]);
const browserStorage: NativeSkillSelectionStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  removeItem: (key) => globalThis.localStorage.removeItem(key),
};
const PRIVATE_METADATA_TOKENS = new Set([
  'body',
  'content',
  'instruction',
  'instructions',
  'markdown',
  'prompt',
  'raw',
  'text',
]);

function hasPrivateMetadataToken(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return tokens.some((token) => PRIVATE_METADATA_TOKENS.has(token));
}

function scopeKeyFor(scope: NativeSkillSelectionScope | null): string | null {
  if (!scope) return null;
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.projectId,
    scope.chatId,
    scope.harness,
    scope.executionHost,
    scope.workingDirectory,
  ]);
}

function catalogKeyFor(
  catalog: readonly NativeSkillSelectionReference[] | undefined,
): string | null {
  if (catalog === undefined) return null;
  return JSON.stringify(
    catalog.map(({ origin, name, path, sourceRevision, executionHost }) => [
      origin,
      name,
      path,
      sourceRevision,
      executionHost,
    ]),
  );
}

function entriesFromResult(
  result: NativeSkillSelectionResult<NativeSkillSelectionState>,
): readonly NativeSkillSelectionEntry[] {
  return result.ok ? result.value.entries : EMPTY_ENTRIES;
}

/**
 * Creates a revision label from native catalog metadata. It deliberately excludes skill
 * bodies and does not claim to fingerprint the contents of a SKILL.md file.
 */
export async function nativeSkillCatalogReference(
  input: NativeSkillCatalogReferenceInput,
): Promise<NativeSkillSelectionReference> {
  if (
    (input.origin !== 'opencode' && input.origin !== 'codex') ||
    !input.name.trim() ||
    input.name !== input.name.trim() ||
    !input.path.trim() ||
    input.path !== input.path.trim() ||
    !input.executionHost.trim() ||
    input.executionHost !== input.executionHost.trim()
  ) {
    throw new TypeError('Native skill reference metadata must contain exact identifiers.');
  }

  const stableMetadata: Record<string, NativeSkillCatalogMetadataValue> = {};
  for (const key of Object.keys(input.metadata).sort()) {
    const value = input.metadata[key];
    if (
      !key.trim() ||
      hasPrivateMetadataToken(key) ||
      (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
      (typeof value === 'string' && value.length > 16_384) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw new TypeError('Native skill metadata must contain public catalog fields only.');
    }
    stableMetadata[key] = value;
  }

  const serialized = JSON.stringify(stableMetadata);
  try {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(serialized),
    );
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    return {
      origin: input.origin,
      name: input.name,
      path: input.path,
      sourceRevision: `catalog:${hex}`,
      executionHost: input.executionHost,
    };
  } catch {
    throw new Error('Native skill catalog metadata could not be fingerprinted.');
  }
}

export function useNativeSkillSelection({
  scope,
  catalog,
  storage,
}: UseNativeSkillSelectionOptions): NativeSkillSelectionHookValue {
  const store = useMemo(
    () => createNativeSkillSelectionStore(storage ?? browserStorage),
    [storage],
  );
  const scopeKey = scopeKeyFor(scope);
  const catalogKey = catalogKeyFor(catalog);
  const [snapshot, setSnapshot] = useState<HookSnapshot>({
    scopeKey: null,
    catalogKey: null,
    entries: EMPTY_ENTRIES,
    error: null,
  });

  useEffect(() => {
    if (!scope || scopeKey === null) {
      setSnapshot({ scopeKey: null, catalogKey: null, entries: EMPTY_ENTRIES, error: null });
      return;
    }

    const persisted = store.read(scope);
    if (!persisted.ok) {
      setSnapshot({ scopeKey, catalogKey: null, entries: EMPTY_ENTRIES, error: persisted.error });
      return;
    }

    const required = store.markNeedsRevalidation(scope);
    if (!required.ok) {
      setSnapshot({
        scopeKey,
        catalogKey: null,
        entries: persisted.value.entries,
        error: required.error,
      });
      return;
    }

    const current = catalog === undefined ? required : store.revalidate(scope, catalog);
    setSnapshot({
      scopeKey,
      catalogKey: catalog === undefined ? null : catalogKey,
      entries: entriesFromResult(current),
      error: current.ok ? null : current.error,
    });
  }, [store, scopeKey, catalogKey]);

  const activeEntries = snapshot.scopeKey === scopeKey ? snapshot.entries : EMPTY_ENTRIES;
  const validationError =
    snapshot.scopeKey === scopeKey
      ? (snapshot.error ??
        (activeEntries.some((entry) => entry.revalidation !== 'validated') ||
        (activeEntries.length > 0 && (catalog === undefined || snapshot.catalogKey !== catalogKey))
          ? 'revalidation_required'
          : null))
      : null;
  const canDispatch =
    snapshot.scopeKey === scopeKey &&
    snapshot.error === null &&
    activeEntries.every((entry) => entry.revalidation === 'validated') &&
    (activeEntries.length === 0 || (catalog !== undefined && snapshot.catalogKey === catalogKey));
  const selectedReferences = useMemo<readonly NativeSkillSelectionReference[]>(() => {
    if (!canDispatch) return EMPTY_REFERENCES;
    return activeEntries.map(({ origin, name, path, sourceRevision, executionHost }) => ({
      origin,
      name,
      path,
      sourceRevision,
      executionHost,
    }));
  }, [activeEntries, canDispatch]);

  const applyResult = useCallback(
    (
      result: NativeSkillSelectionResult<NativeSkillSelectionState>,
      fallbackEntries?: readonly NativeSkillSelectionEntry[],
    ) => {
      setSnapshot((current) => ({
        scopeKey,
        catalogKey: catalog === undefined ? null : catalogKey,
        entries: result.ok
          ? result.value.entries
          : (fallbackEntries ?? (current.scopeKey === scopeKey ? current.entries : EMPTY_ENTRIES)),
        error: result.ok ? null : result.error,
      }));
      return result;
    },
    [catalog, catalogKey, scopeKey],
  );

  const select = useCallback(
    (reference: NativeSkillSelectionReference) => {
      if (!scope) return applyResult({ ok: false, error: 'invalid_scope' });
      if (catalog === undefined) return applyResult({ ok: false, error: 'revalidation_required' });
      if (!catalog.some((candidate) => referenceKey(candidate) === referenceKey(reference))) {
        return applyResult({ ok: false, error: 'invalid_reference' });
      }
      const upserted = store.upsert(scope, reference);
      if (!upserted.ok) return applyResult(upserted);
      const revalidated = store.revalidate(scope, catalog);
      return applyResult(revalidated, upserted.value.entries);
    },
    [applyResult, catalog, scope, store],
  );

  const remove = useCallback(
    (reference: Pick<NativeSkillSelectionReference, 'origin' | 'name' | 'executionHost'>) => {
      if (!scope) return applyResult({ ok: false, error: 'invalid_scope' });
      const removed = store.remove(scope, reference);
      if (!removed.ok) return applyResult(removed);
      const current =
        catalog === undefined
          ? store.markNeedsRevalidation(scope)
          : store.revalidate(scope, catalog);
      return applyResult(current);
    },
    [applyResult, catalog, scope, store],
  );

  const clear = useCallback(
    () =>
      scope ? applyResult(store.clear(scope)) : applyResult({ ok: false, error: 'invalid_scope' }),
    [applyResult, scope, store],
  );

  return {
    entries: activeEntries,
    selectedReferences,
    canDispatch,
    error: validationError,
    select,
    remove,
    clear,
  };
}

function referenceKey(reference: NativeSkillSelectionReference): string {
  return JSON.stringify([
    reference.origin,
    reference.name,
    reference.path,
    reference.sourceRevision,
    reference.executionHost,
  ]);
}
