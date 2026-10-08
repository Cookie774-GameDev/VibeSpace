import { db, openDb, projectRepo } from '@/lib/db';
import { invoke } from '@tauri-apps/api/core';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { useUIStore } from '@/stores/ui';
import {
  dailyContextLocalDate,
  ensureContextPersistence,
  generateProjectContextTree,
  loadPersistedContextMaps,
  reloadPersistedContextMaps,
  savePersistedContextTree,
  selectPersistedContextFile,
  type ContextMapRecord,
  type ContextTreeNode,
} from '@/features/context';
import { getAllCatalogSkills } from '@/features/skills';
import { createDirectory, createTextFileWithContent, readTextFile } from '@/lib/fs';
import { getDataDir } from '@/lib/tauri';
import {
  TerminalCliRuntimeServiceError,
  type TerminalCliAgent,
  type TerminalCliCaoIdentityInput,
  type TerminalCliContextEntity,
  type TerminalCliContextMap,
  type TerminalCliProject,
  type TerminalCliRuntimeDependencies,
} from './terminalCliRuntime';
import type { BackendTerminalInfo } from './restoreSession';
import type { ExpectedTerminalProcessBinding } from './terminalRefs';
import {
  invalidateCaoTerminalExecutionIdentity,
  observeCaoTerminalOpenCodeEvent,
} from '@/features/cao/terminalExecutionIdentity';
import {
  createTerminalCliContextContentService,
  TerminalCliContextContentError,
  type TerminalCliContextContentStorage,
} from './terminalCliContextContent';
import {
  createTerminalCliContextSourceService,
  TerminalCliContextSourceError,
} from './terminalCliContextSources';
import { createProductionContextAutoUpdater } from '@/features/context/contextAutoUpdate';
import { productionContextGateway } from '@/features/context/gateway/productionContextGateway';
import {
  authorizeTerminalContextBridgeIdentity,
  registerTerminalContextBridgeRequest,
} from './terminalContextBridgeIdentity';

const MAX_SEARCH_RESULTS = 50;

export type TerminalCliProductionOptions = Readonly<{
  readAccountId?: () => string | null;
  authorizeProject?: (accountId: string, projectId: string) => Promise<boolean>;
  listNativeTerminals?: () => Promise<readonly BackendTerminalInfo[]>;
}>;

async function defaultAuthorizeProject(accountId: string, projectId: string): Promise<boolean> {
  const project = await projectRepo.getById(projectId as never);
  if (!project || useAuthStore.getState().workspaceId !== project.workspace_id) return false;
  const workspace = await db.workspaces.get(project.workspace_id);
  return workspace?.owner_id === accountId;
}

function verifiedProcessBinding(
  native: BackendTerminalInfo,
  projectId: string,
): ExpectedTerminalProcessBinding | null {
  if (
    native.projectId !== projectId ||
    typeof native.processInstanceId !== 'string' ||
    native.processInstanceId.trim() !== native.processInstanceId ||
    native.processInstanceId.length === 0 ||
    typeof native.runtimeGeneration !== 'string' ||
    native.runtimeGeneration.trim() !== native.runtimeGeneration ||
    native.runtimeGeneration.length === 0 ||
    !Number.isSafeInteger(native.pid) ||
    native.pid <= 0 ||
    !Number.isSafeInteger(native.processStartedAt) ||
    native.processStartedAt <= 0
  ) {
    return null;
  }
  return Object.freeze({
    projectId,
    processInstanceId: native.processInstanceId,
    pid: native.pid,
    processStartedAt: native.processStartedAt,
    runtimeGeneration: native.runtimeGeneration,
  });
}

async function recordCaoTerminalIdentity(
  input: TerminalCliCaoIdentityInput,
  options: TerminalCliProductionOptions,
): Promise<void> {
  const accountId = (
    options.readAccountId ?? (() => getActiveAccountIdentity()?.accountId ?? null)
  )();
  if (
    !accountId ||
    !(await (options.authorizeProject ?? defaultAuthorizeProject)(accountId, input.projectId))
  ) {
    throw new TerminalCliRuntimeServiceError(
      'permission_denied',
      'The OpenCode identity is outside the active account scope.',
    );
  }

  const nativeTerminals = await (
    options.listNativeTerminals ?? (() => invoke<BackendTerminalInfo[]>('terminal_list'))
  )();
  const native = nativeTerminals.find(
    (candidate) => candidate.sessionId === input.terminalSessionId,
  );
  const process = native ? verifiedProcessBinding(native, input.projectId) : null;
  if (!native || !process || process.processInstanceId !== input.identity.processInstanceId) {
    throw new TerminalCliRuntimeServiceError(
      'permission_denied',
      'The OpenCode identity does not match the live terminal process.',
    );
  }

  const accountAfterNativeLookup = options.readAccountId
    ? options.readAccountId()
    : (getActiveAccountIdentity()?.accountId ?? null);
  if (accountAfterNativeLookup !== accountId) {
    throw new TerminalCliRuntimeServiceError(
      'permission_denied',
      'The active account changed while the terminal identity was being verified.',
    );
  }

  const binding = Object.freeze({
    accountId,
    projectId: input.projectId,
    paneId: input.paneId,
    sessionId: input.terminalSessionId,
    process,
  });
  const event = Object.freeze({
    type: 'message.updated' as const,
    properties: Object.freeze({
      sessionID: input.identity.opencodeSessionId,
      info: Object.freeze({
        role: 'assistant' as const,
        providerID: input.identity.providerId,
        modelID: input.identity.modelId,
        variant: input.identity.variant,
      }),
    }),
  });
  const receipt = observeCaoTerminalOpenCodeEvent(
    binding,
    event,
    Date.now(),
    input.identity.opencodeSessionId,
  );
  if (!receipt) {
    throw new TerminalCliRuntimeServiceError(
      'invalid_request',
      'The OpenCode identity event is invalid.',
    );
  }

  const accountAfterReceipt = options.readAccountId
    ? options.readAccountId()
    : (getActiveAccountIdentity()?.accountId ?? null);
  if (accountAfterReceipt !== accountId) {
    invalidateCaoTerminalExecutionIdentity(binding);
    throw new TerminalCliRuntimeServiceError(
      'permission_denied',
      'The active account changed while the terminal identity was recorded.',
    );
  }
}

function descriptor(map: ContextMapRecord): TerminalCliContextMap {
  const sourceLabel = map.github
    ? `${map.github.owner}/${map.github.repository}`
    : map.rootDir || map.filePath || map.name;
  return Object.freeze({
    id: map.id,
    name: map.name,
    status: map.status,
    ...(map.sourceType ? { sourceType: map.sourceType } : {}),
    sourceLabel,
    updatedAt: map.updatedAt,
  });
}

function walkNodes(
  nodes: readonly ContextTreeNode[],
  visit: (node: ContextTreeNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.children) walkNodes(node.children, visit);
  }
}

function entity(map: ContextMapRecord, node: ContextTreeNode): TerminalCliContextEntity {
  return Object.freeze({
    id: node.id,
    label: node.title,
    ...(node.path ? { path: node.path } : {}),
    mapId: map.id,
  });
}

export function searchPersistedTerminalContext(
  maps: readonly ContextMapRecord[],
  mapIds: readonly string[],
  query: string,
): readonly TerminalCliContextEntity[] {
  const wantedMaps = new Set(mapIds);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const matches: Array<{ value: TerminalCliContextEntity; score: number }> = [];
  for (const map of maps) {
    if (map.status !== 'active' || !wantedMaps.has(map.id)) continue;
    walkNodes(map.tree.nodes, (node) => {
      const title = node.title.toLocaleLowerCase();
      const path = (node.path ?? '').toLocaleLowerCase();
      const summary = node.summary.toLocaleLowerCase();
      if (
        !terms.every(
          (term) => title.includes(term) || path.includes(term) || summary.includes(term),
        )
      ) {
        return;
      }
      const score =
        terms.reduce(
          (total, term) =>
            total +
            (title.includes(term) ? 4 : 0) +
            (path.includes(term) ? 2 : 0) +
            (summary.includes(term) ? 1 : 0),
          0,
        ) + (node.importance ?? 0);
      matches.push({ value: entity(map, node), score });
    });
  }
  return Object.freeze(
    matches
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.value.label.localeCompare(right.value.label, 'en-US') ||
          left.value.id.localeCompare(right.value.id, 'en-US'),
      )
      .slice(0, MAX_SEARCH_RESULTS)
      .map(({ value }) => value),
  );
}

export function resolvePersistedTerminalContextEntity(
  maps: readonly ContextMapRecord[],
  target: string,
): TerminalCliContextEntity | null {
  const normalized = target.trim().replaceAll('\\', '/').toLocaleLowerCase();
  const matches: TerminalCliContextEntity[] = [];
  for (const map of maps) {
    if (map.status !== 'active') continue;
    walkNodes(map.tree.nodes, (node) => {
      if (
        node.id === target ||
        node.path?.replaceAll('\\', '/').toLocaleLowerCase() === normalized
      ) {
        matches.push(entity(map, node));
      }
    });
  }
  return matches.length === 1 ? matches[0]! : null;
}

async function accessibleProject(projectId: string): Promise<TerminalCliProject | null> {
  const workspaceId = useAuthStore.getState().workspaceId;
  if (!workspaceId) return null;
  const project = await projectRepo.getById(projectId as never);
  if (!project || project.workspace_id !== workspaceId) return null;
  return Object.freeze({
    id: project.id,
    name: project.name,
    workspaceId: project.workspace_id,
  });
}

async function currentProject(): Promise<TerminalCliProject | null> {
  const projectId = useAuthStore.getState().projectId;
  return projectId ? accessibleProject(projectId) : null;
}

async function activeMaps(projectId: string | null): Promise<readonly ContextMapRecord[]> {
  return (await loadPersistedContextMaps(projectId)).filter((map) => map.status === 'active');
}

async function selectedMap(
  projectId: string | null,
  mapId: string | null,
): Promise<ContextMapRecord> {
  const maps = await activeMaps(projectId);
  const selected = mapId
    ? maps.find((map) => map.id === mapId)
    : [...maps].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!selected) {
    throw new TerminalCliRuntimeServiceError(
      'not_found',
      'The requested Context Map was not found.',
    );
  }
  return selected;
}

async function digestSha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function contentPath(relativePath: string): Promise<{
  root: string;
  path: string;
  directory: string;
}> {
  const parts = relativePath.split('/');
  if (parts.length < 2 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(part))) {
    throw new Error('context_content_path_invalid');
  }
  const root = await getDataDir();
  if (root === 'browser:idb') throw new Error('context_content_native_storage_unavailable');
  const { join } = await import('@tauri-apps/api/path');
  return {
    root,
    path: await join(root, ...parts),
    directory: await join(root, ...parts.slice(0, -1)),
  };
}

export function createProductionTerminalCliContextContentStorage(): TerminalCliContextContentStorage {
  return Object.freeze({
    async create(relativePath: string, content: string) {
      const resolved = await contentPath(relativePath);
      const directory = await createDirectory(resolved.directory, { root: resolved.root });
      if (!directory.ok) throw new Error(directory.error.code);
      const created = await createTextFileWithContent(resolved.path, content, {
        root: resolved.root,
      });
      if (!created.ok) throw new Error(created.error.code);
    },
    async read(relativePath: string) {
      const resolved = await contentPath(relativePath);
      const result = await readTextFile(resolved.path, { root: resolved.root });
      if (!result.ok) throw new Error(result.error.code);
      return result.content;
    },
  });
}

let productionContent: ReturnType<typeof createTerminalCliContextContentService> | undefined;
let productionSources: ReturnType<typeof createTerminalCliContextSourceService> | undefined;

function productionContentService() {
  productionContent ??= createTerminalCliContextContentService({
    database: db,
    storage: createProductionTerminalCliContextContentStorage(),
    now: Date.now,
    randomId: () => crypto.randomUUID(),
    digestSha256,
  });
  return productionContent;
}

function productionSourceService() {
  productionSources ??= createTerminalCliContextSourceService({
    database: db,
    now: Date.now,
    digestSha256,
    async readLocalFile(path) {
      const result = await readTextFile(path);
      if (!result.ok) throw new Error(result.error.code);
      return Object.freeze({ content: result.content });
    },
  });
  return productionSources;
}

async function contentScope(projectId: string | null, mapId: string) {
  await openDb();
  const state = await ensureContextPersistence(projectId);
  const map = state.maps.find(
    (candidate) =>
      candidate.id === mapId && candidate.projectId === projectId && candidate.status === 'active',
  );
  if (!map) {
    throw new TerminalCliRuntimeServiceError(
      'permission_denied',
      'The selected Context Map is not available in this project.',
    );
  }
  return Object.freeze({
    accountId: state.accountId,
    projectId,
    mapId: map.id,
  });
}

async function contentOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TerminalCliRuntimeServiceError) throw error;
    if (error instanceof TerminalCliContextContentError) {
      throw new TerminalCliRuntimeServiceError(error.code, error.message);
    }
    throw new TerminalCliRuntimeServiceError(
      'internal_error',
      'The Context Note command could not be completed.',
    );
  }
}

async function sourceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TerminalCliRuntimeServiceError) throw error;
    if (error instanceof TerminalCliContextSourceError) {
      throw new TerminalCliRuntimeServiceError(error.code, error.message);
    }
    throw new TerminalCliRuntimeServiceError(
      'internal_error',
      'The Context source command could not be completed.',
    );
  }
}

export function createProductionTerminalCliRuntimeDependencies(
  options: TerminalCliProductionOptions = {},
): TerminalCliRuntimeDependencies {
  return {
    now: Date.now,
    recordCaoTerminalIdentity: (input) => recordCaoTerminalIdentity(input, options),
    authorizeContextIdentity: authorizeTerminalContextBridgeIdentity,
    async askContext({ requestId, question, identity }) {
      const complete = registerTerminalContextBridgeRequest(identity.identityId, requestId, () => {
        productionContextGateway.cancel(requestId);
      });
      try {
        return await productionContextGateway.ask({
          requestId,
          question,
          scope: {
            accountId: identity.accountId,
            workspaceId: identity.workspaceId,
            projectId: identity.projectId,
            worktreeId: identity.worktreeId,
            revision: identity.scopeRevision,
          },
          executionIdentity: {
            transportConnectionId: 'vibespace-terminal-context',
            transportAdapterId: 'terminal-local-ipc',
            upstreamProviderId: 'local-context-gateway',
            upstreamModelId: 'context-only',
            providerQualifiedModelId: 'local-context-gateway/context-only',
            authBillingRoute: 'local-only',
            effort: 'not-applicable',
            fastVariant: 'not-applicable',
            catalogRevision: identity.scopeRevision,
            observedProviderIdentity: 'local-context-gateway',
          },
          taskKind: 'answer',
          access: identity.access,
          workingSet: 'incomplete',
          userIntent: { context: true },
          performance: 'quality',
          optionalEnrichmentEnabled: true,
          activePaths: [identity.worktreeId],
        });
      } finally {
        complete();
      }
    },
    verifyContextReceipt(input) {
      return Boolean(productionContextGateway.verifyRequiredReceipt(input));
    },
    currentProject,
    resolveProject: accessibleProject,
    async switchProject(projectId) {
      const project = await accessibleProject(projectId);
      if (!project) {
        throw new TerminalCliRuntimeServiceError(
          'permission_denied',
          'The requested project is not available in the active workspace.',
        );
      }
      useAuthStore.getState().setProjectId(project.id as never);
      return project;
    },
    async listContextMaps(projectId) {
      return (await loadPersistedContextMaps(projectId)).slice(0, 50).map(descriptor);
    },
    async selectContextMap(projectId, mapId) {
      const map = (await loadPersistedContextMaps(projectId)).find(
        (candidate) => candidate.id === mapId,
      );
      if (!map || map.status !== 'active') {
        throw new TerminalCliRuntimeServiceError(
          'not_found',
          'The requested Context Map was not found.',
        );
      }
      return descriptor(map);
    },
    async searchContext(projectId, mapIds, query) {
      return searchPersistedTerminalContext(await activeMaps(projectId), mapIds, query);
    },
    async resolveContextEntity(projectId, target) {
      return resolvePersistedTerminalContextEntity(await activeMaps(projectId), target);
    },
    async openContextEntity(projectId, selected) {
      if (selected.path) {
        await selectPersistedContextFile(projectId, selected.path, {
          mapId: selected.mapId,
          entityId: selected.id,
        });
      }
      useUIStore.getState().setRoute('context');
    },
    async refreshContextMap(projectId, mapId) {
      const auth = useAuthStore.getState();
      const identity = getActiveAccountIdentity();
      if (!identity || !auth.workspaceId || String(auth.projectId) !== projectId) {
        throw new TerminalCliRuntimeServiceError('conflict', 'The Context refresh scope is no longer active.');
      }
      const controller = new AbortController();
      const current = () => {
        const next = useAuthStore.getState();
        const account = getActiveAccountIdentity();
        return account?.accountId === identity.accountId && account.source === identity.source &&
          next.workspaceId === auth.workspaceId && next.projectId === auth.projectId;
      };
      // Bind before the first await: a leave-and-return transition still revokes this request.
      const unsubscribe = useAuthStore.subscribe(() => { if (!current()) controller.abort(); });
      try {
        const map = await selectedMap(projectId, mapId);
        controller.signal.throwIfAborted();
        if (map.sourceType === 'local_file') {
          return sourceOperation(async () => {
            await openDb();
            const state = await ensureContextPersistence(projectId);
            await productionSourceService().refreshLocalFile({
              accountId: state.accountId,
              projectId,
              mapId: map.id,
            });
            const refreshed = (await reloadPersistedContextMaps(projectId)).find(
              (candidate) => candidate.id === map.id,
            );
            if (!refreshed) {
              throw new TerminalCliRuntimeServiceError(
                'internal_error',
                'The Context Map refresh did not produce a persisted map.',
              );
            }
            return descriptor(refreshed);
          });
        }
        if (!map.rootDir || map.sourceType === 'github_repository') {
          throw new TerminalCliRuntimeServiceError(
            'conflict',
            'This Context source cannot be refreshed from the local terminal runtime.',
          );
        }
        const updater = await createProductionContextAutoUpdater({
          accountId: identity.accountId,
          workspaceId: String(auth.workspaceId),
          projectId,
          mapId: map.id,
        });
        controller.signal.throwIfAborted();
        if (await updater.refresh(controller.signal) !== 'updated') {
          throw new TerminalCliRuntimeServiceError('conflict', 'The Context refresh did not complete.');
        }
        controller.signal.throwIfAborted();
        const refreshed = (await reloadPersistedContextMaps(projectId)).find(candidate => candidate.id === map.id);
        controller.signal.throwIfAborted();
        if (!current() || !refreshed || refreshed.status !== 'active') {
          throw new TerminalCliRuntimeServiceError('conflict', 'The Context refresh scope is no longer active.');
        }
        return descriptor(refreshed);
      } finally {
        unsubscribe();
      }
    },
    async createContextMap(projectId, input) {
      if (input.sourceKind === 'file') {
        return sourceOperation(async () => {
          await openDb();
          const state = await ensureContextPersistence(projectId);
          const createdSource = await productionSourceService().createLocalFile({
            accountId: state.accountId,
            projectId,
            path: input.source,
          });
          const created = (await reloadPersistedContextMaps(projectId)).find(
            (candidate) => candidate.id === createdSource.mapId,
          );
          if (!created) {
            throw new TerminalCliRuntimeServiceError(
              'internal_error',
              'The Context Map was not persisted.',
            );
          }
          return descriptor(created);
        });
      }
      if (input.sourceKind !== 'folder') {
        throw new TerminalCliRuntimeServiceError(
          'conflict',
          'This Context source type is not connected to terminal creation yet.',
        );
      }
      const tree = await generateProjectContextTree({
        projectId,
        rootDir: input.source,
        provider: 'local',
      });
      const state = await savePersistedContextTree(tree);
      const created =
        state.maps.find((map) => map.id === state.selectedMapId) ??
        [...state.maps].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (!created) {
        throw new TerminalCliRuntimeServiceError(
          'internal_error',
          'The Context Map was not persisted.',
        );
      }
      return descriptor(created);
    },
    listSkills() {
      return getAllCatalogSkills()
        .slice(0, 100)
        .map((skill) =>
          Object.freeze({
            id: skill.id,
            name: skill.name,
            description: skill.description.slice(0, 500),
          }),
        );
    },
    listAgents() {
      const state = useAgentStore.getState();
      return Object.values(state.agents)
        .slice(0, 100)
        .map(
          (agent): TerminalCliAgent =>
            Object.freeze({
              slug: agent.slug,
              name: agent.name,
              status: state.runStates[agent.id] ?? 'idle',
            }),
        );
    },
    async createNote(projectId, mapId) {
      return contentOperation(async () => {
        const scope = await contentScope(projectId, mapId);
        const note = await productionContentService().createNote({
          ...scope,
          title: 'Untitled',
        });
        useUIStore.getState().setRoute('context');
        return note;
      });
    },
    async openNote(projectId, mapId, name) {
      return contentOperation(async () => {
        const scope = await contentScope(projectId, mapId);
        const note = await productionContentService().openNote({ ...scope, name });
        useUIStore.getState().setRoute('context');
        return note;
      });
    },
    async linkNotes(projectId, mapId, source, target) {
      return contentOperation(async () => {
        const scope = await contentScope(projectId, mapId);
        return productionContentService().linkNotes({ ...scope, source, target });
      });
    },
    async openDailyNote(projectId, mapId) {
      return contentOperation(async () => {
        const scope = await contentScope(projectId, mapId);
        const timestamp = Date.now();
        const localDate = dailyContextLocalDate(
          timestamp,
          -new Date(timestamp).getTimezoneOffset(),
        );
        const note = await productionContentService().openDailyNote({
          ...scope,
          localDate,
        });
        useUIStore.getState().setRoute('context');
        return note;
      });
    },
    async addDailyNoteText(projectId, mapId, text) {
      return contentOperation(async () => {
        const scope = await contentScope(projectId, mapId);
        const timestamp = Date.now();
        const localDate = dailyContextLocalDate(
          timestamp,
          -new Date(timestamp).getTimezoneOffset(),
        );
        return productionContentService().appendDailyNote({
          ...scope,
          localDate,
          text,
        });
      });
    },
  };
}
