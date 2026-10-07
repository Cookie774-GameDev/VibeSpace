import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { waitFor } from '@testing-library/react';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ChatId, MessageId, ProjectId, WorkspaceId } from '@/types/common';
import {
  setStoredProjectRoot,
  ROOT_PREFIX,
  projectStorageKey,
} from '@/features/files/projectFiles';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import { createContextPersistenceService } from './contextPersistence';
import {
  createContextEvidenceLinkStore,
  type ContextEvidenceLinkScope,
  type ContextEvidenceLinkTarget,
} from './contextEvidenceLinks';
import {
  createContextEvidenceNavigation,
  type ContextEvidenceRevalidator,
} from './contextEvidenceNavigation';
import type { ProjectContextTree } from './tree';

const scope: ContextEvidenceLinkScope = {
  accountId: 'nav-account',
  accountSource: 'local',
  workspaceId: 'nav-workspace',
  projectId: 'nav-project',
  chatId: 'nav-chat',
  worktreeId: 'C:/owned',
  projectRoot: 'C:/owned',
};
const input = {
  chatId: scope.chatId,
  messageId: 'nav-message',
  uri: canonicalContextUri('evidence', 'nav-pointer'),
};
let database: JarvisDexie;
let service: ReturnType<typeof createContextPersistenceService>;
let target: ContextEvidenceLinkTarget;
let nav: ReturnType<typeof createContextEvidenceNavigation>;
let revalidate: Mock<ContextEvidenceRevalidator>;

beforeEach(async () => {
  localStorage.clear();
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as WorkspaceId,
    projectId: scope.projectId as ProjectId,
  });
  useUIStore.setState({ activeChatId: scope.chatId, route: 'chat' });
  setStoredProjectRoot(scope.projectId, scope.worktreeId!);
  database = createJarvisDb(uniqueTestDbName('D02-navigation'), TEST_INDEXED_DB);
  service = createContextPersistenceService(database, localStorage);
  await service.initialize(scope.accountId, scope.projectId);
  const tree: ProjectContextTree = {
    version: 1,
    projectId: scope.projectId,
    rootDir: 'C:/owned',
    generatedAt: 1,
    model: 'local-fallback',
    fileCount: 1,
    totalBytes: 4,
    summary: 'Owned test',
    nodes: [
      {
        id: 'node-a',
        title: 'a.txt',
        path: 'a.txt',
        kind: 'file',
        summary: 'Owned',
        modifiedAt: 1,
      },
    ],
  };
  const first = await service.saveTree(scope.accountId, tree, { mapId: 'nav-map-A' });
  await service.saveTree(scope.accountId, { ...tree, rootDir: 'C:/other' }, { mapId: 'nav-map-B' });
  const map = first.maps.find((row) => row.id === 'nav-map-A')!;
  target = {
    uri: input.uri,
    mapId: map.id,
    entityId: map.tree.nodes[0]!.id,
    rootDir: 'C:/owned',
    sourcePath: 'C:/owned/a.txt',
    sourceKind: 'file_version',
    membershipRevision: `sha256:${'b'.repeat(64)}`,
    pointer: {
      id: 'nav-pointer',
      recordId: 'nav-record',
      byteStart: 0,
      byteEnd: 4,
      sourceVersion: `sha256:${'a'.repeat(64)}`,
      contentHash: 'a'.repeat(64),
    },
  };
  await createContextEvidenceLinkStore(database).retain(
    scope,
    { runId: 'nav-run', requestId: 'nav-request', attemptNumber: 1 },
    [target],
    { signal: new AbortController().signal, assertCurrent() {} },
  );
  await database.projects.put({
    id: scope.projectId as ProjectId,
    workspace_id: scope.workspaceId as WorkspaceId,
    name: 'Owned',
    created_at: 1,
    updated_at: 1,
  });
  await database.chats.put({
    id: scope.chatId as ChatId,
    workspace_id: scope.workspaceId as WorkspaceId,
    project_id: scope.projectId as ProjectId,
    title: 'Owned',
    mode: 'chat',
    active_agent_ids: [],
    created_at: 1,
    updated_at: 1,
  });
  await database.messages.put({
    id: input.messageId as MessageId,
    chat_id: scope.chatId as ChatId,
    role: 'assistant',
    parts: [
      {
        kind: 'jarvis_source_ref',
        source: {
          id: target.pointer.id,
          kind: 'context_node',
          label: 'Context evidence',
          uri: target.uri,
          trust: 'app_verified',
          sensitivity: 'private',
        },
      },
    ],
    created_at: 1,
    updated_at: 1,
  });
  revalidate = vi.fn(async (request) => {
    request.signal.throwIfAborted();
    request.assertCurrent();
    return {
      accountId: scope.accountId,
      projectId: scope.projectId,
      mapId: target.mapId,
      entityId: target.entityId,
      path: target.sourcePath,
      mapUpdatedAt: map.updatedAt,
    };
  });
  nav = createContextEvidenceNavigation({ database, revalidate });
});
afterEach(async () => {
  nav?.dispose();
  vi.restoreAllMocks();
  await database.delete();
  localStorage.clear();
});

async function ticket() {
  let found: ReturnType<typeof nav.take>;
  await waitFor(() => {
    found ??= nav.take(scope.projectId);
    expect(found).toBeDefined();
  });
  return found!;
}

describe('fresh Context evidence navigation intent', () => {
  it('refuses a UI-root change since issuance before any source revalidation',async()=>{
    setStoredProjectRoot(scope.projectId,'D:/new-root');
    await expect(nav.open(input)).rejects.toMatchObject({code:'unavailable'});
    expect(revalidate).not.toHaveBeenCalled();
    expect(useUIStore.getState().route).toBe('chat');
  });
  it('accepts explicit absent UI root while retaining its runtime identity',async()=>{
    await database.settings.where('key').startsWith('context-evidence-link-v2:').delete();
    await createContextEvidenceLinkStore(database).retain({...scope,projectRoot:null,worktreeId:'/'},
      {runId:'nav-run',requestId:'nav-request',attemptNumber:1},[target],
      {signal:new AbortController().signal,assertCurrent(){}});
    setStoredProjectRoot(scope.projectId,'');
    const done=nav.open(input);const issued=await ticket();
    expect(revalidate.mock.calls[0]?.[0].scope.worktreeId).toBe('/');
    issued.complete();await done;
  });

  it('separates issuer runtime worktree from an unchanged UI project root', async () => {
    await database.settings.where('key').startsWith('context-evidence-link-v2:').delete();
    const projectRoot = 'D:/VibeSpace-Testing/Chat01-CH31-fixtures';
    const issuedScope = { ...scope, worktreeId: '/', projectRoot };
    await createContextEvidenceLinkStore(database).retain(issuedScope,
      {runId:'nav-run',requestId:'nav-request',attemptNumber:1}, [target],
      {signal:new AbortController().signal,assertCurrent() {}});
    setStoredProjectRoot(scope.projectId, projectRoot);
    const done = nav.open(input);
    const issued = await ticket();
    expect(useUIStore.getState().route).toBe('context');
    expect(revalidate.mock.calls[0]?.[0].scope.worktreeId).toBe('/');
    issued.complete();
    await done;
  });

  it('joins the persisted message/backing and yields one-use guarded selection only', async () => {
    const done = nav.open(input);
    const issued = await ticket();
    expect(nav.take(scope.projectId)).toBeUndefined();
    expect(useUIStore.getState().route).toBe('context');
    const selected = await service.selectMap(
      scope.accountId,
      scope.projectId,
      target.mapId,
      issued.guard,
    );
    expect(selected.selectedMapId).toBe(target.mapId);
    issued.complete();
    await done;
    expect(() => issued.assertCurrent()).toThrow();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
  it.each([
    'missing-backing',
    'wrong-chat',
    'missing-message',
    'untrusted-part',
    'archived-chat',
  ] as const)('refuses %s before a navigation grant', async (reason) => {
    if (reason === 'missing-backing')
      await database.settings.where('key').startsWith('context-evidence-link-v2:').delete();
    if (reason === 'wrong-chat')
      await database.messages.update(input.messageId as MessageId, {
        chat_id: 'foreign-chat' as ChatId,
      });
    if (reason === 'missing-message') await database.messages.delete(input.messageId as MessageId);
    if (reason === 'untrusted-part')
      await database.messages.update(input.messageId as MessageId, {
        parts: [
          {
            kind: 'jarvis_source_ref',
            source: {
              id: target.pointer.id,
              kind: 'context_node',
              label: 'Injected',
              uri: target.uri,
              trust: 'external_untrusted',
              sensitivity: 'private',
            },
          },
        ],
      });
    if (reason === 'archived-chat')
      await database.chats.update(scope.chatId as ChatId, { archived: true });
    await expect(nav.open(input)).rejects.toThrow();
    expect(nav.take(scope.projectId)).toBeUndefined();
    expect(useUIStore.getState().route).toBe('chat');
    expect(revalidate).not.toHaveBeenCalled();
  });
  it.each(['account', 'workspace', 'project', 'chat', 'root', 'route'] as const)(
    'revokes %s ABA during a held source check',
    async (field) => {
      let release!: () => void, entered!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
      revalidate.mockImplementationOnce(async (request) => {
        entered();
        await hold;
        request.signal.throwIfAborted();
        request.assertCurrent();
        return undefined;
      });
      const done = nav.open(input).then(
        () => true,
        () => false,
      );
      await reached;
      if (field === 'account') {
        useAuthStore.setState({ localUserId: 'other' });
        useAuthStore.setState({ localUserId: scope.accountId });
      }
      if (field === 'workspace') {
        useAuthStore.setState({ workspaceId: 'other' as WorkspaceId });
        useAuthStore.setState({ workspaceId: scope.workspaceId as WorkspaceId });
      }
      if (field === 'project') {
        useAuthStore.setState({ projectId: 'other' as ProjectId });
        useAuthStore.setState({ projectId: scope.projectId as ProjectId });
      }
      if (field === 'chat') {
        useUIStore.setState({ activeChatId: 'other' });
        useUIStore.setState({ activeChatId: scope.chatId });
      }
      if (field === 'root') {
        setStoredProjectRoot(scope.projectId, 'C:/other');
        setStoredProjectRoot(scope.projectId, scope.worktreeId!);
      }
      if (field === 'route') {
        useUIStore.setState({ route: 'context' });
        useUIStore.setState({ route: 'chat' });
      }
      release();
      expect(await done).toBe(false);
      expect(nav.take(scope.projectId)).toBeUndefined();
    },
  );
  it('a newer explicit selection revokes a consumed older ticket', async () => {
    const done = nav.open(input).then(
      () => true,
      () => false,
    );
    const issued = await ticket();
    nav.cancel();
    await service.selectMap(scope.accountId, scope.projectId, 'nav-map-B');
    await expect(
      service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard),
    ).rejects.toThrow();
    expect(await done).toBe(false);
    expect((await service.load(scope.accountId, scope.projectId)).selectedMapId).toBe('nav-map-B');
  });
});

it('rechecks stored message ownership when a ready ticket reaches its selection transaction', async () => {
  const done = nav.open(input).then(
    () => true,
    () => false,
  );
  const issued = await ticket();
  try {
    await database.messages.delete(input.messageId as MessageId);
    await expect(
      service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard),
    ).rejects.toThrow();
    expect((await service.load(scope.accountId, scope.projectId)).selectedMapId).toBe('nav-map-B');
  } finally {
    issued.fail();
    await done;
  }
});

it('does not reuse a changed message or chat after the source-read await', async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const valid = revalidate.getMockImplementation()!;
  revalidate.mockImplementationOnce(async (request) => {
    entered();
    await hold;
    return valid(request);
  });
  const done = nav.open(input).then(
    () => true,
    () => false,
  );
  await reached;
  await database.messages.update(input.messageId as MessageId, { parts: [], updated_at: 2 });
  release();
  expect(await done).toBe(false);
  expect(nav.take(scope.projectId)).toBeUndefined();
  expect(useUIStore.getState().route).toBe('chat');
});

it('rejects a persisted map revision change while the source check is pending', async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const valid = revalidate.getMockImplementation()!;
  revalidate.mockImplementationOnce(async (request) => {
    entered();
    await hold;
    return valid(request);
  });
  const done = nav.open(input).then(
    () => true,
    () => false,
  );
  await reached;
  const map = await database.context_maps.get(target.mapId);
  await database.context_maps.update(target.mapId, {
    knowledgeRevision: map!.knowledgeRevision + 1,
  });
  release();
  expect(await done).toBe(false);
  expect(nav.take(scope.projectId)).toBeUndefined();
});

it('captures click arguments instead of reading a later caller mutation', async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const valid = revalidate.getMockImplementation()!;
  revalidate.mockImplementationOnce(async (request) => {
    entered();
    await hold;
    return valid(request);
  });
  const clicked = { ...input };
  const done = nav.open(clicked);
  await reached;
  clicked.uri = canonicalContextUri('evidence', 'forged-later');
  clicked.messageId = 'different-message';
  release();
  const issued = await ticket();
  expect(issued.target.entityId).toBe(target.entityId);
  await service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard);
  issued.complete();
  await done;
});

it('supersedes an older pending click and publishes only the newer ticket', async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const valid = revalidate.getMockImplementation()!;
  revalidate.mockImplementationOnce(async (request) => {
    entered();
    await hold;
    return valid(request);
  });
  const older = nav.open(input).then(
    () => true,
    () => false,
  );
  await reached;
  const newer = nav.open(input);
  const issued = await ticket();
  release();
  expect(await older).toBe(false);
  expect(nav.take(scope.projectId)).toBeUndefined();
  await service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard);
  issued.complete();
  await newer;
});

it('reclaims a timed-out pending read without late routing or a reusable ticket', async () => {
  nav.dispose();
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const valid = revalidate.getMockImplementation()!;
  revalidate.mockImplementationOnce(async (request) => {
    entered();
    await hold;
    return valid(request);
  });
  nav = createContextEvidenceNavigation({ database, revalidate, timeoutMs: 500 });
  const done = nav.open(input).then(
    () => true,
    () => false,
  );
  await reached;
  expect(await done).toBe(false);
  release();
  await Promise.resolve();
  expect(nav.take(scope.projectId)).toBeUndefined();
  expect(useUIStore.getState().route).toBe('chat');
});

it('rejects wrong-project consumption without losing the legitimate one-use ticket', async () => {
  const done = nav.open(input);
  await waitFor(() => expect(useUIStore.getState().route).toBe('context'));
  expect(nav.take('foreign-project')).toBeUndefined();
  const issued = nav.take(scope.projectId)!;
  expect(issued).toBeDefined();
  await service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard);
  issued.complete();
  await done;
  expect(nav.take(scope.projectId)).toBeUndefined();
});

it.each([true, false])(
  'observes delayed root-storage transitions without revoking unrelated settings, relevant=%s',
  async (relevant) => {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const valid = revalidate.getMockImplementation()!;
    revalidate.mockImplementationOnce(async (request) => {
      entered();
      await hold;
      return valid(request);
    });
    const done = nav.open(input).then(
      () => true,
      () => false,
    );
    await reached;
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: relevant ? projectStorageKey(ROOT_PREFIX, scope.projectId) : 'unrelated-setting',
        oldValue: scope.worktreeId,
        newValue: 'C:/transient-other-root',
      }),
    );
    expect(revalidate.mock.calls[0]![0].signal.aborted).toBe(relevant);
    release();
    if (relevant) {
      expect(await done).toBe(false);
      expect(nav.take(scope.projectId)).toBeUndefined();
    } else {
      const issued = await ticket();
      await service.selectMap(scope.accountId, scope.projectId, target.mapId, issued.guard);
      issued.complete();
      expect(await done).toBe(true);
    }
  },
);
