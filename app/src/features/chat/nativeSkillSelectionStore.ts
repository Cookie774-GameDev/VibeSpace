export type NativeSkillHarness = 'opencode' | 'codex';
export type NativeSkillRevalidation = 'required' | 'validated' | 'stale';

export interface NativeSkillSelectionScope {
  accountId: string;
  workspaceId: string | null;
  projectId: string | null;
  chatId: string;
  harness: NativeSkillHarness;
  executionHost: string;
  workingDirectory: string | null;
}

/** A reference only. This store deliberately has no field for a skill body. */
export interface NativeSkillSelectionReference {
  origin: NativeSkillHarness;
  name: string;
  path: string;
  sourceRevision: string;
  executionHost: string;
}

export interface NativeSkillSelectionEntry extends NativeSkillSelectionReference {
  revalidation: NativeSkillRevalidation;
}

export interface NativeSkillSelectionState {
  version: 2;
  scope: NativeSkillSelectionScope;
  entries: readonly NativeSkillSelectionEntry[];
}

export type NativeSkillSelectionError =
  | 'invalid_scope'
  | 'invalid_reference'
  | 'malformed_state'
  | 'scope_mismatch'
  | 'legacy_scope_missing'
  | 'revalidation_required'
  | 'storage_unavailable';

export type NativeSkillSelectionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: NativeSkillSelectionError };

export interface NativeSkillSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORE_PREFIX = 'vibespace.nativeSkillSelection.v2:';
const LEGACY_STORE_PREFIX = 'vibespace.nativeSkillSelection.v1:';
const MAX_ENTRIES = 64;
const MAX_DISCOVERED_REFERENCES = 4_096;
const MAX_REFERENCE_LENGTH = 4_096;
const CONTROL_BYTES = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function exactText(value: unknown, maximum = MAX_REFERENCE_LENGTH): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !CONTROL_BYTES.test(value)
  );
}

function isNullableScopeId(value: unknown): value is string | null {
  return value === null || exactText(value, 512);
}

function validScope(value: unknown): value is NativeSkillSelectionScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'accountId',
      'workspaceId',
      'projectId',
      'chatId',
      'harness',
      'executionHost',
      'workingDirectory',
    ])
  )
    return false;
  return (
    exactText(value.accountId, 512) &&
    isNullableScopeId(value.workspaceId) &&
    isNullableScopeId(value.projectId) &&
    exactText(value.chatId, 512) &&
    (value.harness === 'opencode' || value.harness === 'codex') &&
    exactText(value.executionHost, 512) &&
    isNullableScopeId(value.workingDirectory)
  );
}

function validReference(value: unknown): value is NativeSkillSelectionReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['origin', 'name', 'path', 'sourceRevision', 'executionHost'])
  )
    return false;
  return (
    (value.origin === 'opencode' || value.origin === 'codex') &&
    exactText(value.name, 256) &&
    exactText(value.path) &&
    exactText(value.sourceRevision, 512) &&
    exactText(value.executionHost, 512)
  );
}

function validEntry(value: unknown): value is NativeSkillSelectionEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'origin',
      'name',
      'path',
      'sourceRevision',
      'executionHost',
      'revalidation',
    ])
  )
    return false;
  const { revalidation, ...reference } = value;
  return (
    validReference(reference) &&
    (revalidation === 'required' || revalidation === 'validated' || revalidation === 'stale')
  );
}

function sameScope(left: NativeSkillSelectionScope, right: NativeSkillSelectionScope): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.projectId === right.projectId &&
    left.chatId === right.chatId &&
    left.harness === right.harness &&
    left.executionHost === right.executionHost &&
    left.workingDirectory === right.workingDirectory
  );
}

function referenceIdentity(reference: NativeSkillSelectionReference): string {
  return JSON.stringify([reference.origin, reference.name, reference.executionHost]);
}

function sameReference(
  left: NativeSkillSelectionReference,
  right: NativeSkillSelectionReference,
): boolean {
  return (
    left.origin === right.origin &&
    left.name === right.name &&
    left.path === right.path &&
    left.sourceRevision === right.sourceRevision &&
    left.executionHost === right.executionHost
  );
}

function keyFor(scope: NativeSkillSelectionScope): string {
  return STORE_PREFIX + encodeURIComponent(JSON.stringify(scope));
}

function legacyKeyFor(scope: NativeSkillSelectionScope): string {
  const { workingDirectory: _workingDirectory, ...legacyScope } = scope;
  return LEGACY_STORE_PREFIX + encodeURIComponent(JSON.stringify(legacyScope));
}

function emptyState(scope: NativeSkillSelectionScope): NativeSkillSelectionState {
  return { version: 2, scope: { ...scope }, entries: [] };
}

function decodeState(
  raw: string | null,
  expectedScope: NativeSkillSelectionScope,
): NativeSkillSelectionResult<NativeSkillSelectionState> {
  if (raw === null) return { ok: true, value: emptyState(expectedScope) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed_state' };
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ['version', 'scope', 'entries']) ||
    parsed.version !== 2 ||
    !validScope(parsed.scope) ||
    !sameScope(parsed.scope, expectedScope) ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > MAX_ENTRIES ||
    !parsed.entries.every(validEntry)
  ) {
    return {
      ok: false,
      error:
        isRecord(parsed) && validScope(parsed.scope) && !sameScope(parsed.scope, expectedScope)
          ? 'scope_mismatch'
          : 'malformed_state',
    };
  }
  const entries = parsed.entries as NativeSkillSelectionEntry[];
  const identities = new Set(entries.map(referenceIdentity));
  if (
    identities.size !== entries.length ||
    entries.some((entry) => entry.executionHost !== expectedScope.executionHost)
  ) {
    return { ok: false, error: 'malformed_state' };
  }
  return {
    ok: true,
    value: {
      version: 2,
      scope: { ...expectedScope },
      entries: entries.map((entry) => ({ ...entry })),
    },
  };
}

/** Account/workspace/project/chat/harness/host/root-scoped storage for exact native references. */
export function createNativeSkillSelectionStore(storage: NativeSkillSelectionStorage) {
  const read = (
    scope: NativeSkillSelectionScope,
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    try {
      const current = storage.getItem(keyFor(scope));
      if (current === null && storage.getItem(legacyKeyFor(scope)) !== null) {
        return { ok: false, error: 'legacy_scope_missing' };
      }
      return decodeState(current, scope);
    } catch {
      return { ok: false, error: 'storage_unavailable' };
    }
  };

  const write = (
    scope: NativeSkillSelectionScope,
    entries: readonly NativeSkillSelectionEntry[],
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    const state: NativeSkillSelectionState = { version: 2, scope: { ...scope }, entries };
    try {
      storage.setItem(keyFor(scope), JSON.stringify(state));
      return { ok: true, value: state };
    } catch {
      return { ok: false, error: 'storage_unavailable' };
    }
  };

  const upsert = (
    scope: NativeSkillSelectionScope,
    reference: NativeSkillSelectionReference,
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    if (!validReference(reference) || reference.executionHost !== scope.executionHost) {
      return { ok: false, error: 'invalid_reference' };
    }
    const current = read(scope);
    if (!current.ok && current.error !== 'legacy_scope_missing') return current;
    const entries = current.ok ? current.value.entries : [];
    const next = entries.filter(
      (entry) => referenceIdentity(entry) !== referenceIdentity(reference),
    );
    if (next.length >= MAX_ENTRIES) return { ok: false, error: 'invalid_reference' };
    next.push({ ...reference, revalidation: 'required' });
    return write(scope, next);
  };

  const remove = (
    scope: NativeSkillSelectionScope,
    identity: Pick<NativeSkillSelectionReference, 'origin' | 'name' | 'executionHost'>,
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    if (
      (identity.origin !== 'opencode' && identity.origin !== 'codex') ||
      !exactText(identity.name, 256) ||
      !exactText(identity.executionHost, 512) ||
      identity.executionHost !== scope.executionHost
    ) {
      return { ok: false, error: 'invalid_reference' };
    }
    const current = read(scope);
    if (!current.ok) return current;
    const key = JSON.stringify([identity.origin, identity.name, identity.executionHost]);
    return write(
      scope,
      current.value.entries.filter((entry) => referenceIdentity(entry) !== key),
    );
  };

  const clear = (
    scope: NativeSkillSelectionScope,
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    try {
      storage.removeItem(keyFor(scope));
      storage.removeItem(legacyKeyFor(scope));
      return { ok: true, value: emptyState(scope) };
    } catch {
      return { ok: false, error: 'storage_unavailable' };
    }
  };

  const markNeedsRevalidation = (
    scope: NativeSkillSelectionScope,
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    const current = read(scope);
    if (!current.ok) return current;
    return write(
      scope,
      current.value.entries.map((entry) => ({ ...entry, revalidation: 'required' })),
    );
  };

  const revalidate = (
    scope: NativeSkillSelectionScope,
    discovered: readonly NativeSkillSelectionReference[],
  ): NativeSkillSelectionResult<NativeSkillSelectionState> => {
    if (!validScope(scope)) return { ok: false, error: 'invalid_scope' };
    if (
      !Array.isArray(discovered) ||
      discovered.length > MAX_DISCOVERED_REFERENCES ||
      !discovered.every(
        (reference) => validReference(reference) && reference.executionHost === scope.executionHost,
      )
    ) {
      return { ok: false, error: 'invalid_reference' };
    }
    const current = read(scope);
    if (!current.ok) return current;
    const discoveredByIdentity = new Map(
      discovered.map((reference) => [referenceIdentity(reference), reference]),
    );
    if (discoveredByIdentity.size !== discovered.length)
      return { ok: false, error: 'invalid_reference' };
    const entries = current.value.entries.map((entry) => {
      const candidate = discoveredByIdentity.get(referenceIdentity(entry));
      return {
        ...entry,
        revalidation:
          candidate && sameReference(entry, candidate)
            ? ('validated' as const)
            : ('stale' as const),
      };
    });
    return write(scope, entries);
  };

  const selectedForDispatch = (
    scope: NativeSkillSelectionScope,
  ): NativeSkillSelectionResult<readonly NativeSkillSelectionReference[]> => {
    const current = read(scope);
    if (!current.ok) return current;
    if (current.value.entries.some((entry) => entry.revalidation !== 'validated')) {
      return { ok: false, error: 'revalidation_required' };
    }
    return {
      ok: true,
      value: current.value.entries.map(({ origin, name, path, sourceRevision, executionHost }) => ({
        origin,
        name,
        path,
        sourceRevision,
        executionHost,
      })),
    };
  };

  return Object.freeze({
    read,
    upsert,
    remove,
    clear,
    markNeedsRevalidation,
    revalidate,
    selectedForDispatch,
  });
}
