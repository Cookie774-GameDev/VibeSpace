import { db, type JarvisDexie } from '@/lib/db';
import { getStoredProjectRoot, projectStorageKey, ROOT_PREFIX } from '@/features/files/projectFiles';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import { createContextPointer, type ContextPointer } from './losslessContext';

const PREFIX = 'context-evidence-link-v2:';
const LEGACY_PREFIX = 'context-evidence-link-v1:';
export const CONTEXT_EVIDENCE_LINK_LIMITS = Object.freeze({
  batch: 32,
  recordBytes: 8 * 1024,
  batchBytes: 256 * 1024,
  perAccount: 4096,
  total: 16384,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
});
export type ContextEvidenceLinkScope = Readonly<{
  accountId: string;
  accountSource: 'local' | 'supabase';
  workspaceId: string;
  projectId: string;
  chatId: string;
  /** Current UI Files-root identity; null explicitly means no configured root. */
  projectRoot: string | null;
  /** Exact issuer runtime identity, independently revalidated on a fresh click. */
  worktreeId?: string;
}>;
export type ContextEvidenceNavigationScope = Omit<ContextEvidenceLinkScope, 'worktreeId'>;
export type ContextEvidenceLinkOrigin = Readonly<{
  runId: string;
  requestId: string;
  attemptNumber: number;
}>;
export type ContextEvidenceLinkTarget = Readonly<{
  uri: string;
  mapId: string;
  entityId: string;
  rootDir: string;
  sourcePath: string;
  sourceKind: 'file_version' | 'git';
  gitCommit?: string;
  membershipRevision: string;
  pointer: Readonly<ContextPointer>;
}>;
export type ContextEvidenceLinkRecord = Readonly<{
  kind: 'context-evidence-link-v2';
  version: 2;
  scope: ContextEvidenceLinkScope;
  origin: ContextEvidenceLinkOrigin;
  target: ContextEvidenceLinkTarget;
  issuedAt: number;
  expiresAt: number;
}>;
export type ContextEvidenceLinkWriteAuthority = Readonly<{
  signal: AbortSignal;
  /** The production caller must bind this and signal to an actual live issuance lease. */
  assertCurrent(): void;
}>;

function fail(reason: string): never {
  throw new Error(`context_evidence_link_${reason}`);
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail('invalid');
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail('invalid');
  return record;
}
function text(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    fail('invalid');
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('invalid');
  return value;
}
function scopeOf(value: unknown): ContextEvidenceLinkScope {
  const v = exact(
    value,
    ['accountId', 'accountSource', 'workspaceId', 'projectId', 'chatId', 'projectRoot'],
    ['worktreeId'],
  );
  if (v.accountSource !== 'local' && v.accountSource !== 'supabase') fail('invalid');
  return Object.freeze({
    accountId: text(v.accountId),
    accountSource: v.accountSource,
    workspaceId: text(v.workspaceId),
    projectId: text(v.projectId),
    chatId: text(v.chatId),
    projectRoot: v.projectRoot === null ? null : text(v.projectRoot, 2048),
    ...(v.worktreeId === undefined ? {} : { worktreeId: text(v.worktreeId, 2048) }),
  });
}
function originOf(value: unknown): ContextEvidenceLinkOrigin {
  const v = exact(value, ['runId', 'requestId', 'attemptNumber']);
  const attemptNumber = timestamp(v.attemptNumber);
  if (attemptNumber < 1) fail('invalid');
  return Object.freeze({ runId: text(v.runId), requestId: text(v.requestId), attemptNumber });
}
function targetOf(value: unknown): ContextEvidenceLinkTarget {
  const v = exact(
    value,
    [
      'uri',
      'mapId',
      'entityId',
      'rootDir',
      'sourcePath',
      'sourceKind',
      'membershipRevision',
      'pointer',
    ],
    ['gitCommit'],
  );
  const raw = exact(
    v.pointer,
    ['id', 'recordId', 'sourceVersion', 'contentHash'],
    ['lineStart', 'lineEnd', 'byteStart', 'byteEnd', 'messageId', 'eventId', 'toolCallId'],
  );
  const pointer = createContextPointer(raw as unknown as ContextPointer);
  const uri = text(v.uri, 2048);
  if (
    uri !== canonicalContextUri('evidence', pointer.id) ||
    pointer.sourceVersion !== `sha256:${pointer.contentHash}` ||
    (v.sourceKind !== 'file_version' && v.sourceKind !== 'git') ||
    (v.sourceKind === 'git' && v.gitCommit === undefined) ||
    (v.sourceKind !== 'git' && v.gitCommit !== undefined)
  )
    fail('invalid');
  return Object.freeze({
    uri,
    mapId: text(v.mapId),
    entityId: text(v.entityId),
    rootDir: text(v.rootDir, 2048),
    sourcePath: text(v.sourcePath, 2048),
    sourceKind: v.sourceKind,
    membershipRevision: text(v.membershipRevision, 1024),
    ...(v.gitCommit === undefined ? {} : { gitCommit: text(v.gitCommit) }),
    pointer,
  });
}
function recordOf(value: unknown): ContextEvidenceLinkRecord {
  const v = exact(value, ['kind', 'version', 'scope', 'origin', 'target', 'issuedAt', 'expiresAt']);
  if (v.kind !== 'context-evidence-link-v2' || v.version !== 2) fail('invalid');
  const issuedAt = timestamp(v.issuedAt),
    expiresAt = timestamp(v.expiresAt);
  if (expiresAt - issuedAt !== CONTEXT_EVIDENCE_LINK_LIMITS.retentionMs) fail('invalid');
  const record = Object.freeze({
    kind: 'context-evidence-link-v2' as const,
    version: 2 as const,
    scope: scopeOf(v.scope),
    origin: originOf(v.origin),
    target: targetOf(v.target),
    issuedAt,
    expiresAt,
  });
  if (
    new TextEncoder().encode(JSON.stringify(record)).byteLength >
    CONTEXT_EVIDENCE_LINK_LIMITS.recordBytes
  )
    fail('size');
  return record;
}
async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function navigationScope(scope: ContextEvidenceLinkScope): ContextEvidenceNavigationScope {
  const { worktreeId: _runtimeIdentity, ...navigation } = scope;
  return navigation;
}
async function keys(scope: ContextEvidenceLinkScope, uri: string) {
  const owner = await digest(JSON.stringify([scope.accountSource, scope.accountId]));
  const accountPrefix = `${PREFIX}${owner}:`;
  return { accountPrefix, legacyAccountPrefix: `${LEGACY_PREFIX}${owner}:`,
    key: accountPrefix + (await digest(JSON.stringify([navigationScope(scope), uri]))) };
}

/** Observe Files-root continuity without confusing it with the provider runtime worktree. */
export function captureContextEvidenceProjectRoot(projectId: string) {
  const read = () => getStoredProjectRoot(projectId) || null;
  const projectRoot = read();
  const controller = new AbortController();
  const changed = () => { if (read() !== projectRoot) controller.abort(); };
  const rootChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
    if (detail?.projectId !== projectId) return;
    if ((detail.path || null) !== projectRoot) controller.abort();
    changed();
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null ||
        (event.key === projectStorageKey(ROOT_PREFIX, projectId) && event.oldValue !== event.newValue)) {
      controller.abort();
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('jarvis:files:root-changed', rootChanged);
    window.addEventListener('storage', storageChanged);
  }
  return Object.freeze({
    projectRoot,
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
      changed();
      controller.signal.throwIfAborted();
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('jarvis:files:root-changed', rootChanged);
        window.removeEventListener('storage', storageChanged);
      }
    },
  });
}

/** Local-only historical issuance backing. Lookup is not a file-read or navigation grant. */
export function createContextEvidenceLinkStore(
  database: JarvisDexie = db,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async retain(
      rawScope: ContextEvidenceLinkScope,
      rawOrigin: ContextEvidenceLinkOrigin,
      targets: readonly ContextEvidenceLinkTarget[],
      authority: ContextEvidenceLinkWriteAuthority,
    ): Promise<number> {
      const check = () => {
        authority.signal.throwIfAborted();
        authority.assertCurrent();
      };
      check();
      const scope = scopeOf(rawScope),
        origin = originOf(rawOrigin),
        issuedAt = timestamp(now());
      if (
        !Array.isArray(targets) ||
        targets.length < 1 ||
        targets.length > CONTEXT_EVIDENCE_LINK_LIMITS.batch
      )
        fail('count');
      const unique = new Map<string, ContextEvidenceLinkRecord>();
      for (const target of targets) {
        const record = recordOf({
          kind: 'context-evidence-link-v2',
          version: 2,
          scope,
          origin,
          target,
          issuedAt,
          expiresAt: issuedAt + CONTEXT_EVIDENCE_LINK_LIMITS.retentionMs,
        });
        const previous = unique.get(record.target.uri);
        if (previous && JSON.stringify(previous.target) !== JSON.stringify(record.target))
          fail('collision');
        unique.set(record.target.uri, record);
      }
      if (
        new TextEncoder().encode(JSON.stringify([...unique.values()])).byteLength >
        CONTEXT_EVIDENCE_LINK_LIMITS.batchBytes
      )
        fail('size');
      const pending = await Promise.all(
        [...unique.values()].map(async (record) => ({
          record,
          ...(await keys(scope, record.target.uri)),
        })),
      );
      check();
      let detachAbort = () => {};
      try {
        return await database.transaction('rw', database.settings, async (transaction) => {
          const abort = () => transaction.abort();
          authority.signal.addEventListener('abort', abort, { once: true });
          detachAbort = () => authority.signal.removeEventListener('abort', abort);
          check();
          const rows = await database.settings.bulkGet(pending.map((item) => item.key));
          check();
          const writes: typeof pending = [];
          let additions = 0;
          for (const [index, item] of pending.entries()) {
            const row = rows[index];
            if (row) {
              let previous: ContextEvidenceLinkRecord;
              try {
                previous = recordOf(row.value);
              } catch {
                fail('collision');
              }
              if (
                JSON.stringify(previous.scope) !== JSON.stringify(scope) ||
                JSON.stringify(previous.target) !== JSON.stringify(item.record.target)
              )
                fail('collision');
              // Never silently evict active evidence. A fresh exact issuance can
              // renew an expired identical target; ordinary repeats are idle.
              if (previous.expiresAt > issuedAt) continue;
            } else additions++;
            writes.push(item);
          }
          const [accountCount, legacyAccountCount, totalCount, legacyTotalCount] = await Promise.all([
            database.settings.where('key').startsWith(pending[0]!.accountPrefix).count(),
            database.settings.where('key').startsWith(pending[0]!.legacyAccountPrefix).count(),
            database.settings.where('key').startsWith(PREFIX).count(),
            database.settings.where('key').startsWith(LEGACY_PREFIX).count(),
          ]);
          check();
          if (
            accountCount + legacyAccountCount + additions > CONTEXT_EVIDENCE_LINK_LIMITS.perAccount ||
            totalCount + legacyTotalCount + additions > CONTEXT_EVIDENCE_LINK_LIMITS.total
          )
            fail('capacity');
          for (const item of writes) {
            check();
            await database.settings.put({
              key: item.key,
              value: item.record,
              updated_at: issuedAt,
            });
            check();
          }
          check();
          return pending.length;
        });
      } finally {
        detachAbort();
      }
    },
    async lookup(
      rawScope: ContextEvidenceLinkScope,
      uri: string,
    ): Promise<ContextEvidenceLinkRecord | undefined> {
      try {
        const scope = scopeOf(rawScope);
        if (!text(uri, 2048).startsWith('vibespace:context/evidence/')) return undefined;
        const { key } = await keys(scope, uri);
        const row = await database.settings.get(key);
        if (!row) return undefined;
        const record = recordOf(row.value);
        if (
          JSON.stringify(navigationScope(record.scope)) !== JSON.stringify(navigationScope(scope)) ||
          (scope.worktreeId !== undefined && record.scope.worktreeId !== scope.worktreeId) ||
          record.target.uri !== uri ||
          record.issuedAt > now() ||
          record.expiresAt <= now()
        )
          return undefined;
        return record;
      } catch {
        return undefined;
      }
    },
  });
}
export type ContextEvidenceLinkStore = ReturnType<typeof createContextEvidenceLinkStore>;
