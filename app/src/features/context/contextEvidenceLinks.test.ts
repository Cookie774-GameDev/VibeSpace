import { setStoredProjectRoot, projectStorageKey, ROOT_PREFIX } from '@/features/files/projectFiles';
import {
  captureToolGatewayAuthorityClaim,
  captureToolGatewaySessionLease,
  bindToolGatewaySessionAuthority,
  readToolGatewaySessionAuthority,
  releaseToolGatewaySessionAuthority,
  clearToolGatewayAuthorityForTests,
} from '@/lib/harness/toolGatewayAuthority';
import { useAuthStore } from '@/stores/auth';
import type { ProjectId, WorkspaceId } from '@/types/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import {
  captureContextEvidenceProjectRoot,
  createContextEvidenceLinkStore,
  CONTEXT_EVIDENCE_LINK_LIMITS,
  type ContextEvidenceLinkScope,
  type ContextEvidenceLinkTarget,
} from './contextEvidenceLinks';

const scope: ContextEvidenceLinkScope = {
  accountId: 'account-A',
  accountSource: 'local',
  workspaceId: 'workspace-A',
  projectId: 'project-A',
  chatId: 'chat-A',
  projectRoot: null,
};
const origin = { runId: 'run-A', requestId: 'request-A', attemptNumber: 1 };
const target = (id = 'pointer-A'): ContextEvidenceLinkTarget => ({
  uri: canonicalContextUri('evidence', id),
  mapId: 'map-A',
  entityId: 'node-A',
  rootDir: 'C:/owned',
  sourcePath: 'C:/owned/a.txt',
  sourceKind: 'file_version',
  membershipRevision: 'membership-A',
  pointer: {
    id,
    recordId: 'record-A',
    byteStart: 0,
    byteEnd: 4,
    sourceVersion: `sha256:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
  },
});
let database: JarvisDexie;
let now: number;
let controller: AbortController;
let current: boolean;
const authority = () => ({
  signal: controller.signal,
  assertCurrent() {
    if (!current) throw new Error('revoked');
  },
});
beforeEach(() => {
  database = createJarvisDb(uniqueTestDbName('D01-store'), TEST_INDEXED_DB);
  now = 1_000;
  controller = new AbortController();
  current = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await database.delete();
});

describe('local issuer-backed Context evidence records', () => {
  it('persists idempotently and reopens after the in-memory issuer is gone', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    await store.retain(scope, origin, [target()], authority());
    const first = await store.lookup(scope, target().uri);
    expect(first).toMatchObject({
      kind: 'context-evidence-link-v2',
      scope,
      origin,
      target: target(),
      issuedAt: now,
    });
    now += 100;
    await store.retain(scope, { ...origin, requestId: 'new-request' }, [target()], authority());
    database.close();
    await database.open();
    expect(
      await createContextEvidenceLinkStore(database, () => now).lookup(scope, target().uri),
    ).toEqual(first);
    expect(await database.settings.count()).toBe(1);
    expect(await database.sync_queue.count()).toBe(0);
  });
  it('has no authority for missing, malformed, foreign or expired backing and never deletes it', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    expect(await store.lookup(scope, target().uri)).toBeUndefined();
    await store.retain(scope, origin, [target()], authority());
    expect(await store.lookup({ ...scope, accountId: 'account-B' }, target().uri)).toBeUndefined();
    expect(await store.lookup(scope, 'vibespace:context/evidence/%2E%2E%2Fsecret')).toBeUndefined();
    now += CONTEXT_EVIDENCE_LINK_LIMITS.retentionMs;
    expect(await store.lookup(scope, target().uri)).toBeUndefined();
    expect(await database.settings.count()).toBe(1);
  });
  it('refuses a conflicting target atomically without changing prior or unrelated records', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    await store.retain(scope, origin, [target()], authority());
    const before = await database.settings.toArray();
    await expect(
      store.retain(
        scope,
        origin,
        [target('pointer-B'), { ...target(), entityId: 'foreign-node' }],
        authority(),
      ),
    ).rejects.toThrow('collision');
    expect(await database.settings.toArray()).toEqual(before);
  });
  it('keeps the same opaque URI isolated between actual scoped owners', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    await store.retain(scope, origin, [target()], authority());
    const other = { ...scope, accountId: 'account-B', chatId: 'chat-B' };
    await store.retain(other, origin, [{ ...target(), mapId: 'map-B' }], authority());
    expect((await store.lookup(scope, target().uri))?.target.mapId).toBe('map-A');
    expect((await store.lookup(other, target().uri))?.target.mapId).toBe('map-B');
  });
  it('refuses an unacknowledged-shaped URI and extra source-body fields', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    await expect(
      store.retain(
        scope,
        origin,
        [{ ...target(), uri: canonicalContextUri('source', target().pointer.id) }],
        authority(),
      ),
    ).rejects.toThrow();
    await expect(
      store.retain(
        scope,
        origin,
        [Object.assign(target(), { sourceBody: 'must never be retained' })],
        authority(),
      ),
    ).rejects.toThrow();
    expect(await database.settings.count()).toBe(0);
  });
  it('refuses revoked authority before writing', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    current = false;
    await expect(store.retain(scope, origin, [target()], authority())).rejects.toThrow('revoked');
    expect(await database.settings.count()).toBe(0);
  });
  it('aborts the real transaction after a successful queued put', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    const put = database.settings.put.bind(database.settings);
    vi.spyOn(database.settings, 'put').mockImplementation((...args) =>
      put(...args).then((result) => {
        controller.abort();
        return result;
      }),
    );
    await expect(store.retain(scope, origin, [target()], authority())).rejects.toThrow();
    expect(await database.settings.count()).toBe(0);
  });
  it('holds the abort subscription through the final callback and transaction settlement', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    let putSucceeded = false;
    const put = database.settings.put.bind(database.settings);
    vi.spyOn(database.settings, 'put').mockImplementation((...args) =>
      put(...args).then((result) => {
        putSucceeded = true;
        return result;
      }),
    );
    const late = {
      signal: controller.signal,
      assertCurrent() {
        if (putSucceeded) queueMicrotask(() => controller.abort());
      },
    };
    await expect(store.retain(scope, origin, [target()], late)).rejects.toThrow();
    expect(await database.settings.count()).toBe(0);
  });
});

it('fails the entire batch on a storage error and detaches its abort listener', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  const put = database.settings.put.bind(database.settings);
  let calls = 0;
  const added = vi.spyOn(controller.signal, 'addEventListener');
  const removed = vi.spyOn(controller.signal, 'removeEventListener');
  vi.spyOn(database.settings, 'put').mockImplementation((...args) => {
    if (++calls === 2) throw new Error('synthetic disk failure');
    return put(...args);
  });
  await expect(
    store.retain(scope, origin, [target(), target('pointer-B')], authority()),
  ).rejects.toThrow('synthetic disk failure');
  expect(await database.settings.count()).toBe(0);
  expect(added).toHaveBeenCalledTimes(1);
  expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
});

it('preserves unknown-version records without interpreting them as empty', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await store.retain(scope, origin, [target()], authority());
  const [row] = await database.settings.toArray();
  await database.settings.put({ ...row!, value: { ...(row!.value as object), version: 999 } });
  const original = await database.settings.toArray();
  expect(await store.lookup(scope, target().uri)).toBeUndefined();
  await expect(store.retain(scope, origin, [target()], authority())).rejects.toThrow('collision');
  expect(await database.settings.toArray()).toEqual(original);
});

it('refuses capacity overflow without silently evicting active acceptance evidence', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await store.retain(scope, origin, [target()], authority());
  const [row] = await database.settings.toArray();
  const prefix = row!.key.slice(0, row!.key.lastIndexOf(':') + 1);
  await database.settings.bulkPut(
    Array.from({ length: CONTEXT_EVIDENCE_LINK_LIMITS.perAccount - 1 }, (_, i) => ({
      key: `${prefix}owned-padding-${i}`,
      value: { ownedSynthetic: true },
      updated_at: now,
    })),
  );
  await expect(store.retain(scope, origin, [target('pointer-B')], authority())).rejects.toThrow(
    'capacity',
  );
  expect(await database.settings.count()).toBe(CONTEXT_EVIDENCE_LINK_LIMITS.perAccount);
  expect((await store.lookup(scope, target().uri))?.target).toEqual(target());
  await expect(store.retain(scope, origin, [target()], authority())).resolves.toBe(1);
});

it('bounds batch and record size before any write', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await expect(
    store.retain(
      scope,
      origin,
      Array.from({ length: 33 }, (_, i) => target(`pointer-${i}`)),
      authority(),
    ),
  ).rejects.toThrow('count');
  const large = {
    ...scope,
    accountId: 'a'.repeat(512),
    workspaceId: 'w'.repeat(512),
    projectId: 'p'.repeat(512),
    chatId: 'c'.repeat(512),
    worktreeId: 't'.repeat(2048),
  };
  await expect(
    store.retain(
      large,
      origin,
      [
        {
          ...target(),
          rootDir: 'r'.repeat(2048),
          sourcePath: 's'.repeat(2048),
          membershipRevision: 'm'.repeat(1024),
        },
      ],
      authority(),
    ),
  ).rejects.toThrow('size');
  expect(await database.settings.count()).toBe(0);
});

it('renews only an expired identical target under a fresh live issuance', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await store.retain(scope, origin, [target()], authority());
  now += CONTEXT_EVIDENCE_LINK_LIMITS.retentionMs;
  await expect(
    store.retain(scope, origin, [{ ...target(), entityId: 'replacement' }], authority()),
  ).rejects.toThrow('collision');
  const renewed = { ...origin, requestId: 'renewed-request' };
  await store.retain(scope, renewed, [target()], authority());
  expect(await store.lookup(scope, target().uri)).toMatchObject({
    issuedAt: now,
    origin: renewed,
    target: target(),
  });
  expect(await database.settings.count()).toBe(1);
});

it('rolls back after actual session release following the final currentness callback', async () => {
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as WorkspaceId,
    projectId: scope.projectId as ProjectId,
  });
  clearToolGatewayAuthorityForTests();
  const claim = captureToolGatewayAuthorityClaim()!;
  const turn = {
    requestId: origin.requestId,
    chatId: scope.chatId,
    protectedAttempt: { accountId: scope.accountId, ...origin },
  };
  expect(bindToolGatewaySessionAuthority('store-release', claim, controller.signal, turn)).toBe(
    true,
  );
  const lease = captureToolGatewaySessionLease('store-release', claim, turn)!;
  const store = createContextEvidenceLinkStore(database, () => now);
  let putSucceeded = false;
  const put = database.settings.put.bind(database.settings);
  vi.spyOn(database.settings, 'put').mockImplementation((...args) =>
    put(...args).then((result) => {
      putSucceeded = true;
      return result;
    }),
  );
  const live = {
    signal: lease.signal,
    assertCurrent() {
      if (readToolGatewaySessionAuthority('store-release') !== claim) throw new Error('revoked');
      if (putSucceeded) queueMicrotask(() => releaseToolGatewaySessionAuthority('store-release'));
    },
  };
  try {
    await expect(store.retain(scope, origin, [target()], live)).rejects.toThrow();
    expect(lease.signal.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(await database.settings.count()).toBe(0);
  } finally {
    lease.dispose();
    clearToolGatewayAuthorityForTests();
  }
});

it('refuses global capacity growth while preserving all other owned scopes', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await database.settings.bulkPut(
    Array.from({ length: CONTEXT_EVIDENCE_LINK_LIMITS.total }, (_, i) => ({
      key: `context-evidence-link-v1:other-account:owned-${i}`,
      value: { ownedSynthetic: true },
      updated_at: now,
    })),
  );
  await expect(store.retain(scope, origin, [target()], authority())).rejects.toThrow('capacity');
  expect(await database.settings.count()).toBe(CONTEXT_EVIDENCE_LINK_LIMITS.total);
  expect(await store.lookup(scope, target().uri)).toBeUndefined();
});

it('refuses internally inconsistent source hashes and future-dated records', async () => {
  const store = createContextEvidenceLinkStore(database, () => now);
  await expect(
    store.retain(
      scope,
      origin,
      [
        {
          ...target(),
          pointer: { ...target().pointer, sourceVersion: `sha256:${'b'.repeat(64)}` },
        },
      ],
      authority(),
    ),
  ).rejects.toThrow();
  await store.retain(scope, origin, [target()], authority());
  now -= 1;
  expect(await store.lookup(scope, target().uri)).toBeUndefined();
  expect(await database.settings.count()).toBe(1);
});


describe('v2 navigation root and runtime identity separation', () => {
  it('finds only the exact UI root while preserving the independently supplied runtime identity', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    const issued = {...scope, projectRoot:'D:/owned-files',worktreeId:'/'};
    await store.retain(issued,origin,[target()],authority());
    const {worktreeId: _runtime, ...navigation} = issued;
    expect((await store.lookup(navigation,target().uri))?.scope).toEqual(issued);
    expect(await store.lookup({...navigation,projectRoot:'D:/other'},target().uri)).toBeUndefined();
    expect(await store.lookup({...navigation,projectRoot:'d:/owned-files'},target().uri)).toBeUndefined();
    expect(await store.lookup({...navigation,projectRoot:'D:\\owned-files'},target().uri)).toBeUndefined();
    expect(await store.lookup({...issued,worktreeId:'D:/other-runtime'},target().uri)).toBeUndefined();
  });
  it('never overwrites the same navigation key from another runtime identity', async () => {
    const store = createContextEvidenceLinkStore(database, () => now);
    const issued = {...scope,projectRoot:'D:/owned-files',worktreeId:'/'};
    await store.retain(issued,origin,[target()],authority());
    const before=await database.settings.toArray();
    await expect(store.retain({...issued,worktreeId:'D:/other-runtime'},origin,[target()],authority())).rejects.toThrow('collision');
    expect(await database.settings.toArray()).toEqual(before);
  });
  it.each([undefined, '', ' ', 12, 'C:/bad\nroot', 'x'.repeat(2049)])('rejects malformed or missing UI-root binding %s',async(projectRoot)=>{
    const store=createContextEvidenceLinkStore(database,()=>now);
    const malformed={...scope,projectRoot} as unknown as ContextEvidenceLinkScope;
    await expect(store.retain(malformed,origin,[target()],authority())).rejects.toThrow('invalid');
    expect(await database.settings.count()).toBe(0);
  });
  it('explicit null is an absent root and is different from any configured root',async()=>{
    const store=createContextEvidenceLinkStore(database,()=>now);
    await store.retain({...scope,projectRoot:null,worktreeId:'/'},origin,[target()],authority());
    expect((await store.lookup(scope,target().uri))?.scope.projectRoot).toBeNull();
    expect(await store.lookup({...scope,projectRoot:'/'},target().uri)).toBeUndefined();
  });
  it('preserves legacy and missing-root records but never grants navigation from them',async()=>{
    const store=createContextEvidenceLinkStore(database,()=>now);
    await store.retain(scope,origin,[target()],authority());
    const [row]=(await database.settings.toArray());
    const record=row!.value as Record<string,unknown>;
    const {projectRoot:_root,...oldScope}=scope;
    await database.settings.put({...row!,value:{...record,kind:'context-evidence-link-v1',version:1,scope:oldScope}});
    expect(await store.lookup(scope,target().uri)).toBeUndefined();
    await database.settings.put({...row!,value:{...record,scope:oldScope}});
    expect(await store.lookup(scope,target().uri)).toBeUndefined();
    expect(await database.settings.count()).toBe(1);
  });
  it('counts both legacy and current records against the original account cap',async()=>{
    const store=createContextEvidenceLinkStore(database,()=>now);
    await store.retain(scope,origin,[target()],authority());
    const [row]=await database.settings.toArray();
    const legacyPrefix=row!.key.split(':').slice(0,2).join(':').replace('v2','v1')+':';
    await database.settings.bulkPut(Array.from({length:CONTEXT_EVIDENCE_LINK_LIMITS.perAccount-1},(_,i)=>({
      key:legacyPrefix+'owned-'+i,value:{ownedSynthetic:true},updated_at:now,
    })));
    await expect(store.retain(scope,origin,[target('new-pointer')],authority())).rejects.toThrow('capacity');
    expect(await database.settings.count()).toBe(CONTEXT_EVIDENCE_LINK_LIMITS.perAccount);
  });
  it('counts a mixed legacy/current population against the original global cap',async()=>{
    const store=createContextEvidenceLinkStore(database,()=>now);
    await store.retain(scope,origin,[target()],authority());
    await database.settings.bulkPut(Array.from({length:CONTEXT_EVIDENCE_LINK_LIMITS.total-1},(_,i)=>({
      key:`context-evidence-link-v${i%2?1:2}:other-account:owned-${i}`,value:{ownedSynthetic:true},updated_at:now,
    })));
    await expect(store.retain(scope,origin,[target('new-pointer')],authority())).rejects.toThrow('capacity');
    expect(await database.settings.count()).toBe(CONTEXT_EVIDENCE_LINK_LIMITS.total);
  });
});

describe('issuance UI-root lease',()=>{
  it('captures absent root explicitly and permanently revokes same-window ABA',()=>{
    setStoredProjectRoot('root-test','');
    const lease=captureContextEvidenceProjectRoot('root-test');
    try {
      expect(lease.projectRoot).toBeNull();
      setStoredProjectRoot('root-test','D:/B');
      setStoredProjectRoot('root-test','');
      expect(lease.signal.aborted).toBe(true);
      expect(()=>lease.assertCurrent()).toThrow();
    } finally {lease.dispose();}
  });
  it('ignores unrelated root/settings events and rejects delayed relevant storage ABA',()=>{
    setStoredProjectRoot('root-test','D:/A');
    const lease=captureContextEvidenceProjectRoot('root-test');
    try {
      setStoredProjectRoot('other-project','D:/unrelated');
      window.dispatchEvent(new StorageEvent('storage',{key:'unrelated-setting',oldValue:'A',newValue:'B'}));
      expect(()=>lease.assertCurrent()).not.toThrow();
      window.dispatchEvent(new StorageEvent('storage',{
        key:projectStorageKey(ROOT_PREFIX,'root-test'),oldValue:'D:/A',newValue:'D:/B',
      }));
      expect(lease.signal.aborted).toBe(true);
      expect(()=>lease.assertCurrent()).toThrow();
    } finally {lease.dispose();}
  });
});
