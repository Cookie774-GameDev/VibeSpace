import 'fake-indexeddb/auto';
import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createJarvisDb, type JarvisDexie } from '@/lib/db';
import { TEST_INDEXED_DB, uniqueTestDbName } from '@/test/indexedDb';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { ChatId, MessageId, ProjectId, WorkspaceId } from '@/types/common';
import type { ContextPersistenceState, ContextSelectionGuard } from './contextPersistence';
import type { ProjectContextTree } from './tree';
import { setStoredProjectRoot } from '@/features/files/projectFiles';
import { canonicalContextUri } from '@/lib/harness/toolGatewayCitations';
import type { Part } from '@/types/chat';
const io = vi.hoisted(() => ({
  state: null as ContextPersistenceState | null,
  service: null as ReturnType<
    typeof import('./contextPersistence').createContextPersistenceService
  > | null,
  nav: null as ReturnType<
    typeof import('./contextEvidenceNavigation').createContextEvidenceNavigation
  > | null,
  heldSelection: undefined as Promise<void> | undefined,
  selectingA: false,
  selectCalls: [] as string[],
}));
vi.mock('@/lib/ai/useAccessibleChatModels', () => ({
  useAccessibleChatModels: () => ({ groups: [], flatOptions: [], loading: false }),
}));
vi.mock('./NightlySecondBrainPanel', () => ({ NightlySecondBrainPanel: () => null }));
vi.mock('./ContextAutoUpdateCheckbox', () => ({ ContextAutoUpdateCheckbox: () => null }));
vi.mock('./ContextGalaxy', () => ({ ContextGalaxy: () => null }));
vi.mock('./siyuan/SiyuanVaultSurface', () => ({
  SiyuanVaultSurface: () => null,
  SiyuanVaultLoading: () => null,
}));
vi.mock('./siyuanContextMapIntegration', () => ({
  productionSiyuanContextMaps: {
    prewarm: async () => {},
    read: async (_project: unknown, map: { tree: ProjectContextTree }) => ({ tree: map.tree }),
  },
}));
vi.mock('./contextPersistence', async (original) => ({
  ...(await original<typeof import('./contextPersistence')>()),
  ensureContextPersistence: () => io.service!.load('page-account', 'page-project'),
  getActiveContextPersistenceState: () => io.state,
  selectPersistedContextMap: async (
    projectId: string,
    mapId: string,
    guard?: ContextSelectionGuard,
  ) => {
    io.selectCalls.push(mapId);
    if (guard && mapId === 'page-map-A') {
      io.selectingA = true;
      await io.heldSelection;
    }
    return io.service!.selectMap('page-account', projectId, mapId, guard);
  },
}));
vi.mock('./contextEvidenceNavigation', async (original) => ({
  ...(await original<typeof import('./contextEvidenceNavigation')>()),
  contextEvidenceNavigation: {
    open: (input: Parameters<NonNullable<typeof io.nav>['open']>[0]) => io.nav!.open(input),
    take: (projectId: string | null) => io.nav!.take(projectId),
    subscribe: (listener: () => void) => io.nav!.subscribe(listener),
    cancel: () => io.nav?.cancel(),
  },
}));
import { createContextPersistenceService } from './contextPersistence';
import { createContextEvidenceNavigation } from './contextEvidenceNavigation';
import { createContextEvidenceLinkStore } from './contextEvidenceLinks';
import { ContextPage } from './ContextPage';
import { MessagePart } from '@/features/chat/MessagePart';

let database: JarvisDexie;
let part: Part;
const scope = {
  accountId: 'page-account',
  accountSource: 'local' as const,
  workspaceId: 'page-workspace',
  projectId: 'page-project',
  chatId: 'page-chat',
  worktreeId: 'C:/owned-page',
  projectRoot: 'C:/owned-page',
};
function Shell() {
  const route = useUIStore((state) => state.route);
  return route === 'context' ? (
    <ContextPage />
  ) : (
    <MessagePart
      part={part}
      allParts={[part]}
      chatId={scope.chatId}
      messageId={'page-message' as MessageId}
    />
  );
}
beforeEach(async () => {
  localStorage.clear();
  io.state = null;
  io.heldSelection = undefined;
  io.selectingA = false;
  io.selectCalls = [];
  useAuthStore.setState({
    localUserId: scope.accountId,
    cloudSession: null,
    workspaceId: scope.workspaceId as WorkspaceId,
    projectId: scope.projectId as ProjectId,
  });
  useUIStore.setState({ activeChatId: scope.chatId, route: 'chat' });
  setStoredProjectRoot(scope.projectId, scope.worktreeId);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  database = createJarvisDb(uniqueTestDbName('D02-page'), TEST_INDEXED_DB);
  io.service = createContextPersistenceService(database, localStorage, (state) => {
    io.state = state;
    window.dispatchEvent(
      new CustomEvent('jarvis:context-tree-updated', { detail: { projectId: scope.projectId } }),
    );
  });
  await io.service.initialize(scope.accountId, scope.projectId);
  const tree: ProjectContextTree = {
    version: 1,
    projectId: scope.projectId,
    rootDir: scope.worktreeId,
    generatedAt: 1,
    model: 'local-fallback',
    fileCount: 1,
    totalBytes: 4,
    summary: 'Owned map',
    nodes: [
      {
        id: 'node-file',
        title: 'linked-file.txt',
        path: 'linked-file.txt',
        kind: 'file',
        summary: 'Owned source',
        modifiedAt: 1,
      },
    ],
  };
  const state = await io.service.saveTree(scope.accountId, tree, {
    mapId: 'page-map-A',
    name: 'Map A',
    sourceStatus: 'ready',
  });
  await io.service.saveTree(
    scope.accountId,
    { ...tree, rootDir: 'C:/owned-page-B' },
    { mapId: 'page-map-B', name: 'Map B', sourceStatus: 'ready' },
  );
  const map = state.maps.find((map) => map.id === 'page-map-A')!;
  const pointer = {
    id: 'page-pointer',
    recordId: 'page-record',
    byteStart: 0,
    byteEnd: 4,
    sourceVersion: `sha256:${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
  };
  const uri = canonicalContextUri('evidence', pointer.id);
  await createContextEvidenceLinkStore(database).retain(
    scope,
    { runId: 'page-run', requestId: 'page-request', attemptNumber: 1 },
    [
      {
        uri,
        mapId: map.id,
        entityId: map.tree.nodes[0]!.id,
        rootDir: scope.worktreeId,
        sourcePath: `${scope.worktreeId}/linked-file.txt`,
        sourceKind: 'file_version',
        membershipRevision: `sha256:${'b'.repeat(64)}`,
        pointer,
      },
    ],
    { signal: new AbortController().signal, assertCurrent() {} },
  );
  part = {
    kind: 'jarvis_source_ref',
    source: {
      id: pointer.id,
      kind: 'context_node',
      label: 'Open verified Context source',
      uri,
      trust: 'app_verified',
      sensitivity: 'private',
    },
  };
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
    id: 'page-message' as MessageId,
    chat_id: scope.chatId as ChatId,
    role: 'assistant',
    parts: [part],
    created_at: 1,
    updated_at: 1,
  });
  io.nav = createContextEvidenceNavigation({
    database,
    revalidate: async (input) => {
      input.assertCurrent();
      return {
        accountId: scope.accountId,
        projectId: scope.projectId,
        mapId: map.id,
        entityId: map.tree.nodes[0]!.id,
        path: `${scope.worktreeId}/linked-file.txt`,
        mapUpdatedAt: map.updatedAt,
      };
    },
  });
});
afterEach(async () => {
  cleanup();
  io.nav?.dispose();
  vi.restoreAllMocks();
  await database.delete();
  localStorage.clear();
});

it('opens the exact source node through the actual chip, route mount and guarded persistence', async () => {
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() =>
    expect(screen.getByText('Opened linked-file.txt from chat Context.')).toBeTruthy(),
  );
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-A',
  );
  expect(io.selectCalls.filter((id) => id === 'page-map-A')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /^Map A/ })).toBeTruthy();
});

it('keeps historical missing backing inside the app without route or selection changes', async () => {
  await database.settings.where('key').startsWith('context-evidence-link-v2:').delete();
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(useUIStore.getState().route).toBe('chat');
  expect(io.selectCalls).toEqual([]);
  expect(screen.queryByRole('link', { name: 'Open verified Context source' })).toBeNull();
});

it('lets a newer real Map B choice defeat an older held evidence-link selection', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  fireEvent.click(await screen.findByRole('button', { name: /^Map B/ }));
  await waitFor(() => expect(io.selectCalls).toContain('page-map-B'));
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});

it('a newer workspace section choice cancels a held citation before its late completion', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});

it('a newer actual source-node choice defeats a held evidence-link selection', async () => {
  let release!: () => void;
  io.heldSelection = new Promise((resolve) => {
    release = resolve;
  });
  render(<Shell />);
  fireEvent.click(screen.getByRole('button', { name: 'Open verified Context source' }));
  await waitFor(() => expect(io.selectingA).toBe(true));
  const sourceButtons = await screen.findAllByRole('button', { name: /linked-file\.txt/ });
  fireEvent.click(sourceButtons[0]!);
  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect((await io.service!.load(scope.accountId, scope.projectId)).selectedMapId).toBe(
    'page-map-B',
  );
  expect(screen.queryByText('Opened linked-file.txt from chat Context.')).toBeNull();
});
