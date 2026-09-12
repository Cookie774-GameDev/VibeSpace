import * as React from 'react';
import {
  ArrowLeft,
  BrainCircuit,
  Boxes,
  ChevronRight,
  Clock3,
  Database,
  FileSearch,
  FileText,
  FolderOpen,
  GitBranch,
  Github,
  History,
  LayoutTemplate,
  Link2,
  LocateFixed,
  Layers3,
  MousePointer2,
  Move,
  Network,
  NotebookPen,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TableProperties,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button, Input, toast } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { formatUserDateTime } from '@/lib/timeFormat';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { notifyDone } from '@/lib/notifications';
import type { ProviderId } from '@/types';
import {
  basename,
  chooseProjectFolder,
  chooseProjectFiles,
  getStoredProjectRoot,
  setStoredProjectRoot,
} from '@/features/files/projectFiles';
import { startRightClickDrag } from '@/lib/rightClickDrag';
import {
  ContextGraphPerformanceIndex,
  buildContextGraphPerformanceIndexCooperatively,
  createContextGraphLayoutWorker,
  createGraphLayoutCoordinator,
  hasMoreThanContextGraphNodes,
  hitTestContextGraph,
  selectGraphRenderer,
  writeContextGraphEdgePoints,
} from './graphPerformance';
import {
  CONTEXT_MIME,
  MAX_ACTIVE_CONTEXT_MAPS,
  CONTEXT_PROVIDER_OPTIONS,
  contextMapFilePath,
  contextNodeFilePath,
  findContextFileNodeByPath,
  findContextNode,
  flattenContextNodes,
  formatContextAttachmentForTerminal,
  generateProjectContextTree,
  nodeToAttachment,
  serializeContextAttachment,
  type ContextMapRecord,
  type ContextGenerationProvider,
  type ContextTreeNode,
  type ProjectContextTree,
} from './tree';
import {
  deletePersistedContextMap,
  ensureContextPersistence,
  getActiveContextPersistenceState,
  savePersistedContextTree,
  selectPersistedContextFile,
  selectPersistedContextMap,
} from './contextPersistence';
import type { ContextRecoverySummary } from './contextRecovery';
import { NightlySecondBrainPanel } from './NightlySecondBrainPanel';
import { searchContextNodes } from './contextSearch';
import { createContextSearchIndexPopulationPort } from './contextSearchIndexing';
import {
  CONTEXT_CENTER_MODES,
  CONTEXT_INSPECTOR_TABS,
  CONTEXT_WORKSPACE_SECTIONS,
  buildContextSourceCards,
  buildGitHubMapBadge,
  buildJarvisContextUi,
  contextTabKeyTarget,
  contextWorkspaceNoteStorageKey,
  getLatestContextJarvisUi,
  type ContextCenterModeId,
  type ContextGitHubMapBadge,
  type ContextInspectorTabId,
  type ContextJarvisUi,
  type ContextSourceCard,
  type ContextWorkspaceSectionId,
} from './contextWorkspaceUi';
import { ContextGalaxy } from './ContextGalaxy';
import { contextTreeToGalaxyData, publishContextGalaxySnapshot } from './contextGalaxyRegistry';
import {
  createSupabaseGitHubContextServerExecutor,
  type GitHubContextServerRepository,
} from './githubContextAuth';
import { buildGitHubProjectContextTree } from './githubContextTree';
import './sakura-context.css';

const PROJECT_ROOT_NODE_ID = '__jarvis-context-root__';
const CLOUD_CONTEXT_PROVIDERS: Array<Exclude<ContextGenerationProvider, 'local'>> = [
  'google',
  'groq',
  'openai',
  'anthropic',
];

const MAP_WIDTH = 6400;
const MAP_HEIGHT = 4400;
const MAP_CENTER = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
const MAX_CONTEXT_MAP_LAYOUT_NODES = 100_000;
const MAX_CONTEXT_MAP_LAYOUT_EDGES = 500_000;
const DEFAULT_VIEW = centeredView(3000, 2100);
const WARM_CONTEXT_SOURCE_ART: Record<ContextSourceCard['kind'], string> = {
  local_folder: '/assets/themes/warm/context/context-folder-v1.webp',
  local_file: '/assets/themes/warm/context/context-file-v1.webp',
  github_repository: '/assets/themes/warm/context/context-repository-v1.webp',
};
const contextSearchIndexPopulation = createContextSearchIndexPopulationPort();

type ProviderKeys = Partial<Record<ProviderId, string>>;

export function ContextPage() {
  const projectId = useAuthStore((s) => s.projectId);
  const accountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? null);
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const setRoute = useUIStore((s) => s.setRoute);
  const [rootDraft, setRootDraft] = React.useState(() => getStoredProjectRoot(projectId));
  const [maps, setMaps] = React.useState<ContextMapRecord[]>([]);
  const [recovery, setRecovery] = React.useState<ContextRecoverySummary | null>(null);
  const [selectedMapId, setSelectedMapId] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [provider, setProvider] = React.useState<ContextGenerationProvider>('local');
  const [generating, setGenerating] = React.useState(false);
  const [structuralPreview, setStructuralPreview] = React.useState<ProjectContextTree | null>(null);
  const [mapFlash, setMapFlash] = React.useState(false);
  const [status, setStatus] = React.useState('Ready.');
  const [workspaceSection, setWorkspaceSection] = React.useState<ContextWorkspaceSectionId>('maps');
  const [centerMode, setCenterMode] = React.useState<ContextCenterModeId>('graph');
  const [inspectorTab, setInspectorTab] = React.useState<ContextInspectorTabId>('details');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [focusedMap, setFocusedMap] = React.useState(false);
  const [githubPickerOpen, setGithubPickerOpen] = React.useState(false);
  const [githubInstallationId, setGithubInstallationId] = React.useState('');
  const [githubRepositories, setGithubRepositories] = React.useState<
    readonly GitHubContextServerRepository[]
  >([]);
  const [githubBusy, setGithubBusy] = React.useState(false);
  const [githubError, setGithubError] = React.useState('');
  const [jarvisUi, setJarvisUi] = React.useState<ContextJarvisUi>(() => buildJarvisContextUi(null));
  const lastAppliedFileRef = React.useRef('');
  const generationAbortRef = React.useRef<AbortController | null>(null);

  const applyPersistenceState = React.useCallback(
    (state: Awaited<ReturnType<typeof ensureContextPersistence>>) => {
      const auth = useAuthStore.getState();
      if (
        resolveAccountIdentity(auth)?.accountId !== state.accountId ||
        (auth.projectId ?? null) !== state.projectId
      ) {
        return false;
      }
      setMaps([...state.maps]);
      setRecovery(state.recovery);
      setSelectedMapId(state.selectedMapId);
      setSelectedId((current) => current ?? (state.selectedMapId ? PROJECT_ROOT_NODE_ID : null));
      return true;
    },
    [],
  );

  const providerChoices = React.useMemo(() => getProviderChoices(apiKeys), [apiKeys]);
  const providerChoiceKey = providerChoices.join('|');

  React.useEffect(() => {
    setProvider((current) => {
      if (providerChoices.includes(current)) return current;
      return pickDefaultProvider(providerChoices, defaultProvider);
    });
  }, [defaultProvider, providerChoiceKey, providerChoices]);

  React.useEffect(() => {
    generationAbortRef.current?.abort('context_scope_changed');
    generationAbortRef.current = null;
    setRootDraft(getStoredProjectRoot(projectId));
    setMaps([]);
    setRecovery(null);
    setSelectedMapId(null);
    setSelectedId(null);
    setGenerating(false);
    setStructuralPreview(null);
    setJarvisUi(buildJarvisContextUi(null));
    lastAppliedFileRef.current = '';
    if (!accountId) return;
    let active = true;
    void ensureContextPersistence(projectId)
      .then((state) => {
        if (active) applyPersistenceState(state);
      })
      .catch((error) => {
        if (!active) return;
        setStatus('Context storage recovery required.');
        toast.error(
          'Context storage unavailable',
          error instanceof Error ? error.message : 'Unknown persistence error',
        );
      });
    return () => {
      active = false;
    };
  }, [accountId, applyPersistenceState, projectId]);

  React.useEffect(
    () => () => {
      generationAbortRef.current?.abort('context_unmounted');
      generationAbortRef.current = null;
    },
    [],
  );

  React.useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; mapId?: string | null }>)
        .detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      const next = getActiveContextPersistenceState(projectId);
      if (next) applyPersistenceState(next);
    };
    window.addEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
    return () =>
      window.removeEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
  }, [applyPersistenceState, projectId]);

  const selectedMap = React.useMemo(
    () =>
      maps.find((map) => map.id === selectedMapId && map.status === 'active') ??
      maps.find((map) => map.status === 'active') ??
      null,
    [maps, selectedMapId],
  );
  const tree = structuralPreview ?? selectedMap?.tree ?? null;
  const activeMapCount = React.useMemo(
    () => maps.filter((map) => map.status === 'active').length,
    [maps],
  );
  const sourceCards = React.useMemo(
    () =>
      buildContextSourceCards({
        localFolderSelected: Boolean(rootDraft.trim()),
        localFileSelected: maps.some(
          (map) => map.status === 'active' && map.sourceType === 'local_file',
        ),
        githubConnected: maps.some(
          (map) =>
            map.status === 'active' &&
            map.sourceType === 'github_repository' &&
            Boolean(map.github) &&
            !['permission_required', 'error', 'removed'].includes(map.sourceStatus ?? 'ready'),
        ),
      }),
    [maps, rootDraft],
  );
  const githubBadge = React.useMemo<ContextGitHubMapBadge | null>(() => {
    if (
      selectedMap?.sourceType !== 'github_repository' ||
      !selectedMap.github ||
      !selectedMap.branchRef ||
      selectedMap.lastIndexedAt === undefined
    ) {
      return null;
    }
    try {
      return buildGitHubMapBadge({
        ...selectedMap.github,
        branch: selectedMap.branchRef,
        lastSyncAt: selectedMap.lastIndexedAt,
        status: selectedMap.sourceStatus === 'stale' ? 'stale' : 'ready',
      });
    } catch {
      return null;
    }
  }, [selectedMap]);
  const selectFilePath = React.useCallback(
    async (path: string, notify = true, persist = true): Promise<boolean> => {
      const clean = path.trim();
      if (!clean) return false;
      const targetMap = maps.find(
        (map) => map.status === 'active' && findContextFileNodeByPath(map.tree, clean),
      );
      const targetNode = targetMap ? findContextFileNodeByPath(targetMap.tree, clean) : null;
      if (!targetMap || !targetNode) {
        if (notify) toast.info('File not found in Context maps', clean);
        return false;
      }
      if (persist) {
        try {
          const state = await selectPersistedContextFile(projectId, clean);
          if (!applyPersistenceState(state)) return false;
        } catch (error) {
          if (notify) {
            toast.error(
              'Could not save selected Context file',
              error instanceof Error ? error.message : 'Unknown persistence error',
            );
          }
          return false;
        }
      } else if (targetMap.id !== selectedMapId) {
        setSelectedMapId(targetMap.id);
      }
      setSelectedId(targetNode.id);
      setStatus(`Selected ${basename(clean)} in ${targetMap.name}.`);
      return true;
    },
    [applyPersistenceState, maps, projectId, selectedMapId],
  );

  React.useEffect(() => {
    const stored = getActiveContextPersistenceState(projectId)?.selectedFile ?? '';
    if (!stored || stored === lastAppliedFileRef.current) return;
    void selectFilePath(stored, false, false).then((selected) => {
      if (selected) lastAppliedFileRef.current = stored;
    });
  }, [projectId, selectFilePath]);

  React.useEffect(() => {
    const onSelectFile = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if (!detail?.path) return;
      if ((detail.projectId ?? null) !== (projectId ?? null)) return;
      void selectFilePath(detail.path).then((selected) => {
        if (selected) lastAppliedFileRef.current = detail.path!;
      });
    };
    window.addEventListener('jarvis:context:select-file', onSelectFile as EventListener);
    return () =>
      window.removeEventListener('jarvis:context:select-file', onSelectFile as EventListener);
  }, [projectId, selectFilePath]);

  React.useEffect(() => {
    const onOpenCitation = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          projectId: string | null;
          mapId: string;
          entityId: string;
          path?: string;
        }>
      ).detail;
      if (!detail || detail.projectId !== (projectId ?? null)) return;
      const targetMap = maps.find((map) => map.id === detail.mapId && map.status === 'active');
      if (!targetMap) {
        toast.info('Context source is unavailable', 'Refresh the Context map and try again.');
        return;
      }
      void selectPersistedContextMap(projectId, targetMap.id)
        .then((state) => {
          if (!applyPersistenceState(state)) return;
          const targetNode = findContextNode(targetMap.tree, detail.entityId);
          if (targetNode) {
            setSelectedId(targetNode.id);
            setStatus(`Opened ${targetNode.title} from chat Context.`);
            return;
          }
          const targetFile = detail.path
            ? findContextFileNodeByPath(targetMap.tree, detail.path)
            : null;
          if (targetFile) {
            setSelectedId(targetFile.id);
            setStatus(`Opened ${targetFile.title} from chat Context.`);
            return;
          }
          setSelectedId(PROJECT_ROOT_NODE_ID);
          setStatus(`Opened ${targetMap.name} from chat Context.`);
        })
        .catch((error) =>
          toast.error(
            'Could not save Context selection',
            error instanceof Error ? error.message : 'Unknown persistence error',
          ),
        );
    };
    window.addEventListener('jarvis:context:open-citation', onOpenCitation as EventListener);
    return () =>
      window.removeEventListener('jarvis:context:open-citation', onOpenCitation as EventListener);
  }, [applyPersistenceState, maps, projectId]);

  React.useEffect(() => {
    const refreshActivity = () => {
      const next = getLatestContextJarvisUi({
        projectId: projectId ?? null,
        mapId: selectedMap?.id ?? null,
      });
      setJarvisUi(next);
      if (next.visible) setInspectorTab('jarvis_activity');
    };
    const onActivity = () => refreshActivity();
    window.addEventListener('jarvis:context:activity', onActivity as EventListener);
    refreshActivity();
    return () => window.removeEventListener('jarvis:context:activity', onActivity as EventListener);
  }, [projectId, selectedMap?.id]);

  const rootNode = React.useMemo(() => (tree ? makeProjectRootNode(tree) : null), [tree]);
  const flatNodes = React.useMemo(() => flattenContextNodes(tree?.nodes ?? []), [tree]);
  const selected = React.useMemo(() => {
    if (!tree || !selectedId) return null;
    if (selectedId === PROJECT_ROOT_NODE_ID) return rootNode;
    return findContextNode(tree, selectedId) ?? rootNode ?? tree.nodes[0] ?? null;
  }, [rootNode, selectedId, tree]);

  React.useEffect(() => {
    if (!tree) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => {
      if (current === PROJECT_ROOT_NODE_ID) return current;
      if (current && findContextNode(tree, current)) return current;
      return PROJECT_ROOT_NODE_ID;
    });
  }, [tree]);

  const selectedProvider = providerChoices.includes(provider)
    ? provider
    : (providerChoices[0] ?? 'local');
  const selectedProviderMeta = CONTEXT_PROVIDER_OPTIONS[selectedProvider];

  const selectMap = React.useCallback(
    async (mapId: string) => {
      try {
        const state = await selectPersistedContextMap(projectId, mapId);
        if (!applyPersistenceState(state)) return false;
      } catch (error) {
        toast.error(
          'Could not select Context map',
          error instanceof Error ? error.message : 'Unknown persistence error',
        );
        return false;
      }
      setSelectedId(PROJECT_ROOT_NODE_ID);
      return true;
    },
    [applyPersistenceState, projectId],
  );

  const openFocusedMap = React.useCallback(
    async (mapId: string) => {
      if (!(await selectMap(mapId))) return;
      setCenterMode('graph');
      setFocusedMap(true);
    },
    [selectMap],
  );

  React.useEffect(() => {
    if (!focusedMap) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusedMap(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focusedMap]);

  const deleteMap = React.useCallback(
    async (mapId: string) => {
      const record = maps.find((map) => map.id === mapId);
      if (!record || record.status === 'deleted') return;
      const confirmed = window.confirm(
        `Do you confirm to delete the context map '${record.name}'?`,
      );
      if (!confirmed) return;
      try {
        const state = await deletePersistedContextMap(projectId, mapId);
        if (!applyPersistenceState(state)) return;
        setSelectedId(state.selectedMapId ? PROJECT_ROOT_NODE_ID : null);
        toast.info('Context map tagged Deleted', record.name);
      } catch (error) {
        toast.error(
          'Could not delete Context map',
          error instanceof Error ? error.message : 'Unknown persistence error',
        );
      }
    },
    [applyPersistenceState, maps, projectId],
  );

  const openFolderPicker = async () => {
    const picked = await chooseProjectFolder({
      title: 'Choose project folder',
      initialPath: rootDraft.trim() || undefined,
    });
    if (!picked) return;
    setRootDraft(picked);
    setStoredProjectRoot(projectId, picked);
    toast.success('Project folder selected', picked);
  };

  const openFilePicker = async () => {
    const [picked] = await chooseProjectFiles(false, {
      title: 'Choose a file for this Context map',
      initialPath: rootDraft.trim() || undefined,
    });
    if (!picked) return;
    const containingFolder = parentDirectory(picked);
    setRootDraft(containingFolder);
    setStoredProjectRoot(projectId, containingFolder);
    setStatus(
      `Selected ${basename(picked)}. Create Map will securely index its containing folder.`,
    );
    toast.success('Context file selected', basename(picked));
  };

  const loadGitHubRepositories = React.useCallback(async () => {
    const installationId = githubInstallationId.trim();
    if (!accountId) {
      setGithubError('Sign in before connecting a GitHub repository.');
      return;
    }
    if (!/^[1-9]\d{0,15}$/u.test(installationId)) {
      setGithubError('Enter the numeric installation ID from the VibeSpace GitHub App setup.');
      return;
    }
    setGithubBusy(true);
    setGithubError('');
    try {
      const executor = createSupabaseGitHubContextServerExecutor(
        () => resolveAccountIdentity(useAuthStore.getState())?.accountId ?? null,
      );
      const result = await executor.execute(accountId, {
        operation: 'list_repositories',
        installationId,
        page: 1,
      });
      if (result.operation !== 'list_repositories')
        throw new Error('github_context_response_invalid');
      setGithubRepositories(result.repositories);
      setStatus(
        result.repositories.length
          ? `Choose one of ${result.repositories.length} read-only GitHub repositories.`
          : 'This GitHub App installation has no accessible repositories.',
      );
    } catch (error) {
      setGithubRepositories([]);
      setGithubError(
        error instanceof Error
          ? error.message
          : 'The read-only GitHub repository list is unavailable.',
      );
    } finally {
      setGithubBusy(false);
    }
  }, [accountId, githubInstallationId]);

  const createGitHubMap = React.useCallback(
    async (repository: GitHubContextServerRepository) => {
      const installationId = githubInstallationId.trim();
      if (!accountId || githubBusy) return;
      if (activeMapCount >= MAX_ACTIVE_CONTEXT_MAPS) {
        toast.warning(
          'Active Context map limit reached',
          `Delete an active map first. Jarvis keeps up to ${MAX_ACTIVE_CONTEXT_MAPS} active maps per project.`,
        );
        return;
      }
      setGithubBusy(true);
      setGithubError('');
      setStatus(`Reading ${repository.fullName} at ${repository.defaultBranch}...`);
      try {
        const executor = createSupabaseGitHubContextServerExecutor(
          () => resolveAccountIdentity(useAuthStore.getState())?.accountId ?? null,
        );
        const result = await executor.execute(accountId, {
          operation: 'read_tree',
          installationId,
          repositoryId: repository.id,
          ref: repository.defaultBranch,
        });
        if (result.operation !== 'read_tree') throw new Error('github_context_response_invalid');
        const generated = buildGitHubProjectContextTree({ projectId, repository, result });
        const persisted = await savePersistedContextTree(generated, {
          name: `${repository.fullName} Context Map`,
          source: {
            kind: 'github_repository',
            label: repository.fullName,
            branchRef: repository.defaultBranch,
            github: {
              installationId,
              owner: repository.owner,
              repository: repository.name,
              resolvedCommitSha: result.sha,
              visibility: repository.private ? 'private' : 'public',
            },
          },
        });
        if (!applyPersistenceState(persisted)) return;
        setSelectedId(PROJECT_ROOT_NODE_ID);
        setCenterMode('graph');
        setGithubPickerOpen(false);
        setStatus(
          `${repository.fullName} mapped at ${result.sha.slice(0, 12)}${
            result.truncated ? ' (GitHub returned a partial tree).' : '.'
          }`,
        );
        toast.success('GitHub Context map ready', repository.fullName);
      } catch (error) {
        setGithubError(
          error instanceof Error ? error.message : 'The GitHub Context map could not be created.',
        );
        setStatus('GitHub Context map creation failed.');
      } finally {
        setGithubBusy(false);
      }
    },
    [accountId, activeMapCount, applyPersistenceState, githubBusy, githubInstallationId, projectId],
  );

  const rememberRoot = () => {
    const clean = rootDraft.trim();
    if (!clean) return;
    setStoredProjectRoot(projectId, clean);
    toast.success('Project folder saved', clean);
  };

  const makeSkillTree = React.useCallback(async () => {
    const rootDir = rootDraft.trim();
    if (!rootDir) {
      toast.warning('Choose a project folder', 'Context needs a root folder to scan.');
      return;
    }
    if (activeMapCount >= MAX_ACTIVE_CONTEXT_MAPS) {
      toast.warning(
        'Active Context map limit reached',
        `Delete an active map first. Jarvis keeps up to ${MAX_ACTIVE_CONTEXT_MAPS} active maps per project.`,
      );
      return;
    }

    const activeProvider = providerChoices.includes(provider)
      ? provider
      : (providerChoices[0] ?? 'local');
    const apiKey = activeProvider === 'local' ? undefined : apiKeys[activeProvider]?.trim();
    if (activeProvider !== 'local' && !apiKey) {
      toast.warning(
        'Provider key missing',
        `Add a ${CONTEXT_PROVIDER_OPTIONS[activeProvider].label} key first.`,
      );
      return;
    }

    generationAbortRef.current?.abort('superseded');
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setStructuralPreview(null);
    setGenerating(true);
    setStatus('Starting Context map creation...');
    try {
      setStoredProjectRoot(projectId, rootDir);
      const generated = await generateProjectContextTree({
        projectId,
        rootDir,
        provider: activeProvider,
        apiKey,
        onProgress: setStatus,
        signal: controller.signal,
        onStructuralMap: (preview) => {
          const auth = useAuthStore.getState();
          if (
            controller.signal.aborted ||
            resolveAccountIdentity(auth)?.accountId !== accountId ||
            (auth.projectId ?? null) !== (projectId ?? null)
          ) {
            return;
          }
          setStructuralPreview(preview);
          setSelectedId(PROJECT_ROOT_NODE_ID);
        },
      });
      const persistenceAuth = useAuthStore.getState();
      if (
        controller.signal.aborted ||
        generationAbortRef.current !== controller ||
        resolveAccountIdentity(persistenceAuth)?.accountId !== accountId ||
        (persistenceAuth.projectId ?? null) !== (projectId ?? null)
      ) {
        setStructuralPreview(null);
        return;
      }
      const persisted = await savePersistedContextTree(generated);
      const persistedMap = persisted.maps.find(
        (map) => map.id === persisted.selectedMapId && map.status === 'active',
      );
      if (!persistedMap) throw new Error('context_search_index_snapshot_invalid');
      setStatus(`Indexing ${generated.fileCount} Context files...`);
      try {
        await contextSearchIndexPopulation.populateCreatedMap(
          persisted.accountId,
          persistedMap,
          controller.signal,
        );
      } catch (indexError) {
        await deletePersistedContextMap(projectId, persistedMap.id).catch(() => undefined);
        throw indexError;
      }
      const indexedAuth = useAuthStore.getState();
      if (
        controller.signal.aborted ||
        generationAbortRef.current !== controller ||
        resolveAccountIdentity(indexedAuth)?.accountId !== accountId ||
        (indexedAuth.projectId ?? null) !== (projectId ?? null)
      ) {
        setStructuralPreview(null);
        return;
      }
      if (!applyPersistenceState(persisted)) return;
      setStructuralPreview(null);
      setSelectedId(PROJECT_ROOT_NODE_ID);
      setMapFlash(true);
      window.setTimeout(() => setMapFlash(false), 1250);
      const contextBody = `${generated.fileCount} files mapped with ${shortModel(generated.model)}.`;
      const notifyState = useUIStore.getState();
      if (!notifyState.notificationMaster || !notifyState.doneNotifications.contextMaps) {
        toast.success('Context map ready', contextBody);
      }
      void notifyDone('contextMaps', 'Context map ready', contextBody);
    } catch (err) {
      if (controller.signal.aborted) {
        if (generationAbortRef.current === controller) {
          setStructuralPreview(null);
          setStatus('Generation cancelled.');
        }
        return;
      }
      setStructuralPreview(null);
      const auth = useAuthStore.getState();
      if (
        resolveAccountIdentity(auth)?.accountId !== accountId ||
        (auth.projectId ?? null) !== (projectId ?? null)
      ) {
        return;
      }
      toast.error(
        'Context map creation failed',
        err instanceof Error ? err.message : 'Unknown error',
      );
      setStatus('Generation failed.');
    } finally {
      const auth = useAuthStore.getState();
      if (
        generationAbortRef.current === controller &&
        resolveAccountIdentity(auth)?.accountId === accountId &&
        (auth.projectId ?? null) === (projectId ?? null)
      ) {
        generationAbortRef.current = null;
        setGenerating(false);
      }
    }
  }, [
    activeMapCount,
    accountId,
    apiKeys,
    applyPersistenceState,
    projectId,
    provider,
    providerChoices,
    rootDraft,
  ]);

  React.useEffect(() => {
    const onCreateMap = () => void makeSkillTree();
    window.addEventListener('jarvis:context:create-map', onCreateMap);
    return () => window.removeEventListener('jarvis:context:create-map', onCreateMap);
  }, [makeSkillTree]);

  const selectWorkspaceSection = React.useCallback((next: ContextWorkspaceSectionId) => {
    setWorkspaceSection(next);
    if (next === 'maps' || next === 'workspaces') setCenterMode('graph');
    if (next === 'sources' || next === 'views' || next === 'templates') {
      setCenterMode('structured');
    }
    if (next === 'notes') setCenterMode('note');
  }, []);

  const openSourceCard = React.useCallback(
    (kind: ContextSourceCard['kind']) => {
      setWorkspaceSection('sources');
      if (kind === 'local_folder') {
        void openFolderPicker();
        return;
      }
      if (kind === 'local_file') {
        void openFilePicker();
        return;
      }
      setStatus(
        'GitHub repository selection stays here. Connect the read-only GitHub App if no repositories are available.',
      );
      setGithubPickerOpen(true);
    },
    [openFolderPicker],
  );

  if (focusedMap && tree && rootNode && selected) {
    return (
      <div
        data-monochrome-route="context"
        data-sakura-route="context"
        data-context-focused-map
        className="h-full min-h-0 w-full overflow-hidden bg-background p-3"
      >
        <ContextMapWorkspace
          accountId={accountId}
          tree={tree}
          rootNode={rootNode}
          selected={selected}
          selectedId={selected.id}
          onSelect={setSelectedId}
          flash={mapFlash}
          mode="graph"
          onModeChange={setCenterMode}
          inspectorTab={inspectorTab}
          onInspectorTabChange={setInspectorTab}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          map={selectedMap}
          githubBadge={githubBadge}
          jarvisUi={jarvisUi}
          focused
          onExitFocus={() => setFocusedMap(false)}
        />
      </div>
    );
  }

  return (
    <div
      data-monochrome-route="context"
      data-sakura-route="context"
      data-sakura-intensity="standard"
      className="relative flex h-full min-h-0 w-full overflow-hidden bg-background [html[data-theme=monochrome]_&]:font-sans"
    >
      <div className="pointer-events-none absolute inset-0 opacity-70 [html[data-theme=monochrome]_&]:hidden">
        <div className="absolute left-[-12rem] top-[-12rem] h-[32rem] w-[32rem] rounded-full bg-accent-copper/10 blur-3xl" />
        <div className="absolute bottom-[-16rem] right-[-14rem] h-[34rem] w-[34rem] rounded-full bg-accent-honey/10 blur-3xl" />
      </div>

      <aside
        data-monochrome-surface="context-tree"
        data-sakura-surface="context-tree"
        className="relative z-10 flex w-[340px] shrink-0 flex-col border-r border-border bg-panel/85 backdrop-blur xl:w-[400px] [html[data-theme=monochrome]_&]:w-[304px] [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:backdrop-blur-none"
      >
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-accent-copper/30 bg-accent-copper/10 px-2 py-1 text-metadata uppercase tracking-wide text-accent-copper">
                <BrainCircuit className="h-3.5 w-3.5" /> Context
              </div>
              <h1 className="mt-2 font-display text-2xl font-semibold text-foreground">
                Project Context Map
              </h1>
              <p className="text-secondary text-muted-foreground">
                Create a cozy draggable map for every AI chat and terminal.
              </p>
            </div>
            <Button
              variant="accent"
              size="sm"
              onClick={() => setWorkspaceSection('sources')}
              aria-label="Create Context map"
              className="gap-1.5"
            >
              <Sparkles className="h-4 w-4" />
              Create map
            </Button>
          </div>

          <ContextWorkspaceNavigation active={workspaceSection} onSelect={selectWorkspaceSection} />

          {workspaceSection === 'sources' ? (
            <div className="space-y-2">
              <ContextSourceCards
                cards={sourceCards}
                selectedMap={selectedMap}
                githubBadge={githubBadge}
                onOpen={openSourceCard}
              />
              {githubPickerOpen ? (
                <GitHubRepositoryPicker
                  installationId={githubInstallationId}
                  onInstallationIdChange={setGithubInstallationId}
                  repositories={githubRepositories}
                  busy={githubBusy}
                  error={githubError}
                  onLoad={() => void loadGitHubRepositories()}
                  onChoose={(repository) => void createGitHubMap(repository)}
                  onClose={() => setGithubPickerOpen(false)}
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-border bg-paper-soft p-2.5 shadow-soft [html[data-theme=monochrome]_&]:shadow-none">
              <label
                htmlFor="context-project-folder"
                className="flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground"
              >
                <FolderOpen className="h-3.5 w-3.5 text-accent-honey" /> Project folder
              </label>
              <div className="flex gap-1.5">
                <Input
                  id="context-project-folder"
                  value={rootDraft}
                  onChange={(e) => setRootDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') rememberRoot();
                  }}
                  placeholder="C:\\Users\\you\\project or /home/you/project"
                  className="font-mono text-metadata"
                />
                <Button size="sm" variant="secondary" onClick={() => void openFolderPicker()}>
                  Choose
                </Button>
              </div>
              <label className="block space-y-1">
                <span className="text-metadata uppercase tracking-wide text-muted-foreground">
                  Map model provider
                </span>
                <select
                  value={selectedProvider}
                  onChange={(e) => setProvider(e.target.value as ContextGenerationProvider)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-metadata text-foreground shadow-soft outline-none transition-colors focus:border-accent-copper focus:ring-1 focus:ring-ring [html[data-theme=monochrome]_&]:shadow-none"
                >
                  {providerChoices.map((choice) => (
                    <option key={choice} value={choice}>
                      {CONTEXT_PROVIDER_OPTIONS[choice].label} -{' '}
                      {CONTEXT_PROVIDER_OPTIONS[choice].model}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={rememberRoot}
                  disabled={!rootDraft.trim()}
                >
                  Save Root
                </Button>
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() => void makeSkillTree()}
                  disabled={generating || !rootDraft.trim()}
                  className="ml-auto gap-1"
                >
                  {generating ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  Create Map
                </Button>
              </div>
              <p className="text-metadata text-muted-foreground">
                {selectedProvider === 'local'
                  ? 'Local fallback is available. Saved cloud keys appear here automatically.'
                  : `${selectedProviderMeta.label} key detected. Jarvis will send sampled project files to ${selectedProviderMeta.shortLabel}.`}
              </p>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Stat label="Files" value={tree ? String(tree.fileCount) : '-'} />
            <Stat label="Nodes" value={tree ? String(flatNodes.length + 1) : '-'} />
            <Stat
              label="Model"
              value={tree ? shortModel(tree.model) : selectedProviderMeta.shortLabel}
            />
          </div>
          <ContextMapList
            maps={maps}
            selectedMapId={selectedMap?.id ?? null}
            activeMapCount={activeMapCount}
            onSelect={openFocusedMap}
            onDelete={deleteMap}
          />
          <NightlySecondBrainPanel />
          <p className="min-h-4 text-metadata text-muted-foreground">{status}</p>

          {tree && selected ? (
            <SelectedContextCard
              tree={tree}
              node={selected}
              onSelectRoot={() => setSelectedId(PROJECT_ROOT_NODE_ID)}
            />
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-hidden">
          {!tree ? (
            <EmptyTree />
          ) : (
            <div className="space-y-1.5">
              <ContextTreeBranch
                tree={tree}
                node={rootNode ?? makeProjectRootNode(tree)}
                depth={0}
                selectedId={selected?.id ?? null}
                onSelect={setSelectedId}
              />
            </div>
          )}
        </div>
      </aside>

      <main
        data-monochrome-surface="context-workspace"
        data-sakura-surface="context-workspace"
        className="relative z-10 flex min-w-0 flex-1 flex-col p-4 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:p-2"
      >
        {!tree || !rootNode || !selected ? (
          <NoContextHero
            onGenerate={() => void makeSkillTree()}
            disabled={generating || !rootDraft.trim()}
            sourceCards={sourceCards}
            onOpenSource={openSourceCard}
          />
        ) : (
          <ContextMapWorkspace
            accountId={accountId}
            tree={tree}
            rootNode={rootNode}
            selected={selected}
            selectedId={selected.id}
            onSelect={setSelectedId}
            flash={mapFlash}
            mode={centerMode}
            onModeChange={setCenterMode}
            inspectorTab={inspectorTab}
            onInspectorTabChange={setInspectorTab}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            map={selectedMap}
            githubBadge={githubBadge}
            jarvisUi={jarvisUi}
            focused={false}
            onExitFocus={() => setFocusedMap(false)}
          />
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-paper px-2.5 py-2 shadow-soft [html[data-theme=monochrome]_&]:shadow-none">
      <div className="text-metadata uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

function handleContextTabKeyDown<T extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  tabs: readonly Readonly<{ id: T }>[],
  activeId: T,
  onChange: (id: T) => void,
) {
  const currentIndex = tabs.findIndex((item) => item.id === activeId);
  if (currentIndex < 0) return;
  const nextIndex = contextTabKeyTarget(currentIndex, event.key, tabs.length);
  if (nextIndex === null) return;
  const nextId = tabs[nextIndex]?.id;
  if (!nextId) return;
  event.preventDefault();
  onChange(nextId);
  event.currentTarget
    .closest('[role="tablist"]')
    ?.querySelector<HTMLButtonElement>(`[data-context-tab-id="${nextId}"]`)
    ?.focus();
}

function ContextWorkspaceNavigation({
  active,
  onSelect,
}: {
  active: ContextWorkspaceSectionId;
  onSelect: (section: ContextWorkspaceSectionId) => void;
}) {
  const icons: Record<ContextWorkspaceSectionId, React.ComponentType<{ className?: string }>> = {
    maps: Layers3,
    sources: Database,
    notes: NotebookPen,
    views: TableProperties,
    templates: LayoutTemplate,
    workspaces: Boxes,
  };
  return (
    <nav aria-label="Context workspace" className="grid grid-cols-3 gap-1.5">
      {CONTEXT_WORKSPACE_SECTIONS.map((section) => {
        const Icon = icons[section.id];
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            aria-current={active === section.id ? 'page' : undefined}
            className={cn(
              'flex min-w-0 flex-col items-center gap-1 rounded-xl border px-2 py-2 text-metadata transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [html[data-theme=monochrome]_&]:shadow-none',
              active === section.id
                ? 'border-accent-copper/45 bg-accent-copper/10 text-accent-copper shadow-soft'
                : 'border-border bg-paper text-muted-foreground hover:border-accent-copper/30 hover:text-foreground',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="truncate">{section.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function GitHubRepositoryPicker({
  installationId,
  onInstallationIdChange,
  repositories,
  busy,
  error,
  onLoad,
  onChoose,
  onClose,
}: {
  installationId: string;
  onInstallationIdChange: (value: string) => void;
  repositories: readonly GitHubContextServerRepository[];
  busy: boolean;
  error: string;
  onLoad: () => void;
  onChoose: (repository: GitHubContextServerRepository) => void;
  onClose: () => void;
}) {
  return (
    <section
      className="rounded-xl border border-accent-copper/30 bg-paper p-3 shadow-soft"
      aria-label="Choose GitHub repository"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-secondary font-semibold text-foreground">Read-only GitHub Context</h3>
          <p className="mt-0.5 text-metadata text-muted-foreground">
            VibeSpace reads repository metadata and files through its GitHub App. It never asks for
            a personal access token.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Close
        </Button>
      </div>
      <label
        htmlFor="context-github-installation-id"
        className="mt-3 block text-metadata font-medium text-foreground"
      >
        GitHub App installation ID
      </label>
      <div className="mt-1 flex gap-2">
        <Input
          id="context-github-installation-id"
          inputMode="numeric"
          autoComplete="off"
          value={installationId}
          onChange={(event) => onInstallationIdChange(event.target.value.replace(/\D/gu, ''))}
          placeholder="Example: 12345678"
          disabled={busy}
        />
        <Button size="sm" variant="secondary" onClick={onLoad} disabled={busy}>
          {busy ? 'Connecting…' : 'Load repositories'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-metadata text-destructive">
          {error}
        </p>
      ) : null}
      {repositories.length ? (
        <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto" aria-label="GitHub repositories">
          {repositories.map((repository) => (
            <li
              key={repository.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-paper-soft px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="truncate font-mono text-secondary text-foreground">
                  {repository.fullName}
                </div>
                <div className="text-metadata text-muted-foreground">
                  {repository.private ? 'Private' : 'Public'} · {repository.defaultBranch}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onChoose(repository)}
              >
                Create map
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ContextSourceCards({
  cards,
  selectedMap,
  githubBadge,
  onOpen,
}: {
  cards: readonly ContextSourceCard[];
  selectedMap: ContextMapRecord | null;
  githubBadge: ContextGitHubMapBadge | null;
  onOpen: (kind: ContextSourceCard['kind']) => void;
}) {
  const icons: Record<ContextSourceCard['kind'], React.ComponentType<{ className?: string }>> = {
    local_folder: FolderOpen,
    local_file: FileText,
    github_repository: Github,
  };
  return (
    <section className="space-y-2" aria-label="Context sources">
      {cards.map((card) => {
        const Icon = icons[card.kind];
        return (
          <article
            key={card.kind}
            className="rounded-xl border border-border bg-paper-soft p-2.5 shadow-soft"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent-copper/10 text-accent-copper">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-secondary font-semibold text-foreground">{card.label}</h3>
                <span className="text-metadata uppercase tracking-wide text-accent-copper">
                  {card.state}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onOpen(card.kind)}>
                {card.state === 'connect' ? 'Connect' : card.state === 'choose' ? 'Choose' : 'Open'}
              </Button>
            </div>
            <div className="mt-2 space-y-1 text-metadata text-muted-foreground">
              <p className="flex gap-1.5">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-sage" />
                {card.permission}
              </p>
              <p className="pl-5">{card.privacy}</p>
            </div>
          </article>
        );
      })}
      {selectedMap?.sourceType === 'github_repository' ? (
        <GitHubMapIdentity map={selectedMap} badge={githubBadge} />
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-paper p-3 text-metadata text-muted-foreground">
          Select an indexed GitHub map to see its exact owner/repository, branch, commit,
          visibility, sync time, and stale state.
        </div>
      )}
    </section>
  );
}

function GitHubMapIdentity({
  map,
  badge,
}: {
  map: ContextMapRecord;
  badge: ContextGitHubMapBadge | null;
}) {
  if (!badge) {
    return (
      <div className="rounded-xl border border-accent-honey/35 bg-accent-honey/10 p-3 text-metadata text-muted-foreground">
        This legacy GitHub map does not contain a complete verified identity. Refresh it before
        VibeSpace displays repository, commit, or visibility details.
      </div>
    );
  }
  return (
    <section className="rounded-xl border border-accent-copper/30 bg-paper p-3 shadow-soft">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-secondary font-semibold text-foreground">
            {badge.repository}
          </div>
          <div className="truncate font-mono text-metadata text-muted-foreground">
            {badge.branch} @ {badge.shortSha}
          </div>
        </div>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            badge.stale
              ? 'border-accent-honey/45 bg-accent-honey/10 text-accent-honey'
              : map.sourceStatus && map.sourceStatus !== 'ready'
                ? 'border-destructive/35 bg-destructive/10 text-destructive'
                : 'border-accent-sage/45 bg-accent-sage/10 text-accent-sage',
          )}
        >
          {badge.stale ? 'Stale' : (map.sourceStatus ?? 'Ready')}
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-metadata">
        <MetaRow label="Visibility" value={badge.visibility} />
        <MetaRow label="Last sync" value={formatDate(badge.lastSyncAt)} />
      </dl>
    </section>
  );
}

function EmptyTree() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-paper-soft p-4 text-secondary text-muted-foreground">
      No Context map yet. Pick a project root, then press Create Map.
    </div>
  );
}

function ContextMapList({
  maps,
  selectedMapId,
  activeMapCount,
  onSelect,
  onDelete,
}: {
  maps: ContextMapRecord[];
  selectedMapId: string | null;
  activeMapCount: number;
  onSelect: (mapId: string) => void;
  onDelete: (mapId: string) => void;
}) {
  if (maps.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-paper-soft p-2.5 shadow-soft">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
          <Layers3 className="h-3.5 w-3.5 text-accent-copper" /> Context maps
        </div>
        <span className="rounded-full border border-border bg-paper px-2 py-0.5 text-metadata text-muted-foreground">
          {activeMapCount}/{MAX_ACTIVE_CONTEXT_MAPS} active
        </span>
      </div>
      <div className="space-y-1">
        {maps.slice(0, 8).map((map) => {
          const selected = map.id === selectedMapId;
          const deleted = map.status === 'deleted';
          const mapFilePath = map.filePath ?? contextMapFilePath(map.rootDir);
          return (
            <div
              key={map.id}
              draggable={!deleted}
              onDragStart={(event) => {
                if (deleted) return;
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('application/x-jarvis-file', mapFilePath);
                event.dataTransfer.setData('text/plain', mapFilePath);
              }}
              onMouseDown={(event) => {
                if (event.button === 2 && !deleted) {
                  event.stopPropagation();
                  startRightClickDrag(event, 'file', { path: mapFilePath });
                }
              }}
              className={cn(
                'group flex w-full items-center gap-1 rounded-lg border transition-all',
                selected
                  ? 'border-accent-copper/45 bg-accent-copper/10 shadow-soft'
                  : 'border-transparent hover:border-border hover:bg-paper',
                deleted && 'opacity-70',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(map.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-secondary font-medium text-foreground">
                    {map.name}
                  </span>
                  <span className="block truncate font-mono text-metadata text-muted-foreground">
                    {map.tree.fileCount} files - {mapFilePath}
                  </span>
                </span>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    deleted
                      ? 'border-muted-foreground/25 bg-muted text-muted-foreground'
                      : 'border-accent-copper/35 bg-accent-copper/10 text-accent-copper',
                  )}
                >
                  {deleted ? 'Deleted' : 'Active'}
                </span>
              </button>
              {!deleted ? (
                <button
                  type="button"
                  onClick={() => onDelete(map.id)}
                  className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
                  aria-label={`Delete ${map.name}`}
                  title="Tag this Context map as Deleted"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NoContextHero({
  onGenerate,
  disabled,
  sourceCards,
  onOpenSource,
}: {
  onGenerate: () => void;
  disabled: boolean;
  sourceCards: readonly ContextSourceCard[];
  onOpenSource: (kind: ContextSourceCard['kind']) => void;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto [html[data-theme=warm]_&]:items-start [html[data-theme=warm]_&]:p-2">
      <div
        data-warm-surface="context-hero"
        className="relative max-w-2xl overflow-hidden rounded-3xl border border-accent-copper/25 bg-panel/90 p-8 shadow-[0_24px_80px_hsl(var(--accent-copper)/0.16)] backdrop-blur [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none [html[data-theme=warm]_&]:w-full [html[data-theme=warm]_&]:max-w-3xl [html[data-theme=warm]_&]:p-6 [html[data-theme=warm]_&]:pb-40"
      >
        <div
          data-warm-decoration="context-legacy-glow"
          className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,hsl(var(--accent-copper)/0.18),transparent_34%),radial-gradient(circle_at_80%_80%,hsl(var(--accent-amber)/0.14),transparent_32%)] [html[data-theme=monochrome]_&]:bg-none [html[data-theme=warm]_&]:hidden"
        />
        <img
          src="/assets/themes/warm/context/context-valley-v2.webp"
          alt=""
          aria-hidden="true"
          draggable={false}
          className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-64 w-full object-cover object-bottom [html[data-theme=warm]_&]:block"
        />
        <div className="relative space-y-5 [html[data-theme=warm]_&]:space-y-4 [html[data-theme=warm]_&]:text-center">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-copper/40 bg-accent-copper/15 text-accent-copper shadow-soft [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=warm]_&]:mx-auto">
            <Network className="h-7 w-7" />
          </div>
          <div>
            <div className="eyebrow">Context power layer</div>
            <h2 className="mt-2 font-display text-4xl font-semibold leading-tight text-foreground [html[data-theme=warm]_&]:text-[28px] [html[data-theme=warm]_&]:leading-[1.12]">
              Turn this project into an interactive AI context map.
            </h2>
          </div>
          <p className="text-body text-muted-foreground [html[data-theme=warm]_&]:mx-auto [html[data-theme=warm]_&]:max-w-xl">
            Jarvis scans the project, uses your selected saved provider key when available, and
            builds a warm string map that every AI prompt can use before deciding which files
            matter.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FeaturePill icon={<GitBranch className="h-4 w-4" />} text="String map" />
            <FeaturePill icon={<MousePointer2 className="h-4 w-4" />} text="Left-click inspect" />
            <FeaturePill icon={<Move className="h-4 w-4" />} text="Right-click pan" />
          </div>
          <div className="grid gap-2 sm:grid-cols-3" aria-label="Start from a Context source">
            {sourceCards.map((card) => (
              <button
                key={card.kind}
                type="button"
                onClick={() => onOpenSource(card.kind)}
                data-warm-surface="context-source-card"
                data-warm-source={card.kind}
                className="rounded-xl border border-border bg-paper-soft p-3 text-left transition-colors hover:border-accent-copper/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [html[data-theme=warm]_&]:flex [html[data-theme=warm]_&]:min-h-[165px] [html[data-theme=warm]_&]:flex-col"
              >
                <span className="block text-secondary font-semibold text-foreground">
                  {card.label}
                </span>
                <span className="mt-1 block text-metadata text-muted-foreground">
                  {card.kind === 'local_folder'
                    ? 'Choose a folder, select the local model, then create a map.'
                    : card.kind === 'local_file'
                      ? 'Choose a file here, then create a map from its containing folder.'
                      : 'Check the read-only GitHub App here, then choose an accessible repository.'}
                </span>
                <img
                  src={WARM_CONTEXT_SOURCE_ART[card.kind]}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  className="pointer-events-none mt-auto hidden h-20 w-full object-contain pt-2 [html[data-theme=warm]_&]:block"
                />
              </button>
            ))}
          </div>
          <Button
            variant="accent"
            size="lg"
            onClick={onGenerate}
            disabled={disabled}
            data-warm-action="context-create"
            className="gap-2 [html[data-theme=warm]_&]:mx-auto"
          >
            <Sparkles className="h-4 w-4" /> Create Context Map
          </Button>
        </div>
      </div>
    </div>
  );
}

function FeaturePill({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-paper-soft px-3 py-2 text-secondary text-foreground">
      <span className="text-accent-copper">{icon}</span>
      {text}
    </div>
  );
}

function SelectedContextCard({
  tree,
  node,
  onSelectRoot,
}: {
  tree: ProjectContextTree;
  node: ContextTreeNode;
  onSelectRoot: () => void;
}) {
  const onDragStart = useContextDrag(tree, node);
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onMouseDown={(e) => {
        if (e.button === 2) {
          e.stopPropagation();
          startRightClickDrag(e, 'context', { node, tree });
        }
      }}
      className="rounded-2xl border border-accent-copper/25 bg-paper p-3 shadow-soft"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-ui-strong text-foreground">
          <Zap className="h-4 w-4 text-accent-copper" />
          <span className="truncate">Drag Selected Context</span>
        </div>
        <Button size="sm" variant="ghost" onClick={onSelectRoot}>
          Root
        </Button>
      </div>
      <div className="truncate font-medium text-foreground">{node.title}</div>
      <p className="mt-1 line-clamp-3 text-metadata text-muted-foreground">{node.summary}</p>
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-metadata text-muted-foreground">
        <span>{formatBytes(node.sizeBytes)}</span>
        <span className="truncate text-right">{node.children?.length ?? 0} links</span>
      </div>
    </div>
  );
}

function ContextTreeBranch({
  tree,
  node,
  depth,
  selectedId,
  onSelect,
}: {
  tree: ProjectContextTree;
  node: ContextTreeNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(depth < 2);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const active = selectedId === node.id;
  const onDragStart = useContextDrag(tree, node);
  return (
    <div>
      <div
        className={cn(
          'group flex min-w-0 items-center gap-1 rounded-lg py-1 pr-2 transition-all',
          'hover:bg-muted focus-within:ring-1 focus-within:ring-ring',
          active && 'bg-accent-copper/10 text-foreground ring-1 ring-accent-copper/40 shadow-soft',
        )}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((cur) => !cur);
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-paper-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={open ? 'Collapse Context branch' : 'Expand Context branch'}
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}
        <button
          type="button"
          draggable
          onDragStart={onDragStart}
          onMouseDown={(e) => {
            if (e.button === 2) {
              e.stopPropagation();
              startRightClickDrag(e, 'context', { node, tree });
            }
          }}
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left focus-visible:outline-none"
          title={node.summary}
        >
          {node.kind === 'file' ? (
            <FileText className="h-4 w-4 shrink-0 text-accent-honey" />
          ) : (
            <Network className="h-4 w-4 shrink-0 text-accent-copper" />
          )}
          <span className="min-w-0 flex-1 truncate text-secondary text-foreground">
            {node.title}
          </span>
          {node.importance && (
            <span className="text-metadata text-muted-foreground">{node.importance}</span>
          )}
        </button>
      </div>
      {open &&
        hasChildren &&
        node.children!.map((child) => (
          <ContextTreeBranch
            key={child.id}
            tree={tree}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function ContextMapWorkspace({
  accountId,
  tree,
  rootNode,
  selected,
  selectedId,
  onSelect,
  flash,
  mode,
  onModeChange,
  inspectorTab,
  onInspectorTabChange,
  searchQuery,
  onSearchQueryChange,
  map,
  githubBadge,
  jarvisUi,
  focused,
  onExitFocus,
}: {
  accountId: string | null;
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  selected: ContextTreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
  flash: boolean;
  mode: ContextCenterModeId;
  onModeChange: (mode: ContextCenterModeId) => void;
  inspectorTab: ContextInspectorTabId;
  onInspectorTabChange: (tab: ContextInspectorTabId) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  map: ContextMapRecord | null;
  githubBadge: ContextGitHubMapBadge | null;
  jarvisUi: ContextJarvisUi;
  focused: boolean;
  onExitFocus: () => void;
}) {
  const flatNodes = React.useMemo(() => flattenContextNodes(tree.nodes), [tree]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 [html[data-theme=monochrome]_&]:gap-2">
      <header
        data-monochrome-surface="context-mode-bar"
        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-panel/90 p-2 shadow-soft backdrop-blur [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none"
      >
        {focused ? (
          <>
            <div className="flex min-w-0 items-center gap-3">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={onExitFocus}
                className="shrink-0 gap-1.5"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </Button>
              <div className="min-w-0">
                <h1 className="truncate font-display text-xl font-semibold text-foreground">
                  {map?.name ?? tree.summary}
                </h1>
                <p className="flex flex-wrap items-center gap-x-3 text-metadata text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Move className="h-3.5 w-3.5 text-accent-copper" />
                    Drag to orbit · Shift-drag to pan
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MousePointer2 className="h-3.5 w-3.5 text-accent-honey" />
                    Select a node to inspect details, links, and backlinks
                  </span>
                  <span>Esc closes focused view</span>
                </p>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Context center mode">
            {CONTEXT_CENTER_MODES.map((item) => (
              <button
                key={item.id}
                id={`context-center-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={mode === item.id}
                aria-controls="context-center-panel"
                data-context-tab-id={item.id}
                tabIndex={mode === item.id ? 0 : -1}
                onClick={() => onModeChange(item.id)}
                onKeyDown={(event) =>
                  handleContextTabKeyDown(event, CONTEXT_CENTER_MODES, mode, onModeChange)
                }
                className={cn(
                  'rounded-xl px-3 py-2 text-secondary font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  mode === item.id
                    ? 'bg-accent-copper/12 text-accent-copper shadow-soft'
                    : 'text-muted-foreground hover:bg-paper-soft hover:text-foreground',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {jarvisUi.visible ? (
          <button
            type="button"
            onClick={() => onInspectorTabChange('jarvis_activity')}
            className="inline-flex items-center gap-2 rounded-full border border-accent-honey/40 bg-accent-honey/10 px-3 py-1.5 text-metadata font-semibold text-accent-honey focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {jarvisUi.chip}
          </button>
        ) : null}
      </header>
      <div
        className={cn(
          'min-h-0 flex-1 gap-4',
          focused ? 'relative' : 'grid xl:grid-cols-[minmax(0,1fr)_400px]',
        )}
      >
        <section
          id="context-center-panel"
          role="tabpanel"
          aria-labelledby={`context-center-tab-${mode}`}
          className={cn(
            'relative min-h-0 overflow-hidden rounded-3xl border border-border bg-panel/80 shadow-soft backdrop-blur [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none',
            focused && 'h-full',
          )}
          data-jarvis-suppress-context-menu={focused || mode === 'graph' ? true : undefined}
        >
          {focused || mode === 'graph' ? (
            <>
              {!focused ? (
                <div className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-paper/90 p-2 shadow-soft backdrop-blur">
                  <div className="flex items-center gap-2 px-2 text-metadata text-muted-foreground">
                    <Move className="h-3.5 w-3.5 text-accent-copper" /> Drag to orbit · Shift-drag
                    to pan
                  </div>
                  <div className="flex items-center gap-2 px-2 text-metadata text-muted-foreground">
                    <MousePointer2 className="h-3.5 w-3.5 text-accent-honey" /> Left-click nodes or
                    strings
                  </div>
                </div>
              ) : null}
              <ContextGalaxyWorkspace
                accountId={accountId}
                projectId={tree.projectId}
                mapId={map?.id ?? `context:${tree.rootDir}`}
                tree={tree}
                rootNode={rootNode}
                selectedId={selectedId}
                highlightedNodeIds={jarvisUi.highlightedNodeIds}
                onSelect={onSelect}
                flash={flash}
              />
            </>
          ) : mode === 'note' ? (
            map && accountId ? (
              <ContextWorkspaceNote accountId={accountId} map={map} selected={selected} />
            ) : (
              <ContextModeEmpty
                icon={<NotebookPen className="h-6 w-6" />}
                title={map ? 'Sign in before writing a note' : 'Save the map before writing a note'}
                body={
                  map
                    ? 'Workspace notes are isolated to the signed-in app profile.'
                    : 'The structural preview is still being generated. The local note editor becomes available after this map is persisted.'
                }
              />
            )
          ) : mode === 'structured' ? (
            <ContextStructuredView
              tree={tree}
              rootNode={rootNode}
              nodes={flatNodes}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : (
            <ContextSearchView
              nodes={flatNodes}
              query={searchQuery}
              onQueryChange={onSearchQueryChange}
              onSelect={onSelect}
            />
          )}
        </section>
        {focused ? (
          <div className="absolute bottom-4 left-4 z-30 h-[min(42%,390px)] w-[min(520px,calc(100%-2rem))]">
            <ContextInspector
              tree={tree}
              map={map}
              node={selected}
              onSelect={onSelect}
              tab={inspectorTab}
              onTabChange={onInspectorTabChange}
              githubBadge={githubBadge}
              jarvisUi={jarvisUi}
              compact
            />
          </div>
        ) : (
          <ContextInspector
            tree={tree}
            map={map}
            node={selected}
            onSelect={onSelect}
            tab={inspectorTab}
            onTabChange={onInspectorTabChange}
            githubBadge={githubBadge}
            jarvisUi={jarvisUi}
            compact={false}
          />
        )}
      </div>
    </div>
  );
}

const MAX_CONTEXT_NOTE_CHARS = 20_000;

function ContextWorkspaceNote({
  accountId,
  map,
  selected,
}: {
  accountId: string;
  map: ContextMapRecord;
  selected: ContextTreeNode;
}) {
  const storageKey = React.useMemo(
    () => contextWorkspaceNoteStorageKey(accountId, map.projectId, map.id),
    [accountId, map.id, map.projectId],
  );
  const [draft, setDraft] = React.useState('');
  const [savedDraft, setSavedDraft] = React.useState('');

  React.useEffect(() => {
    let stored = '';
    try {
      const candidate = window.localStorage.getItem(storageKey) ?? '';
      if (candidate.length <= MAX_CONTEXT_NOTE_CHARS) stored = candidate;
    } catch {
      // The editor remains usable when this profile blocks local storage.
    }
    setDraft(stored);
    setSavedDraft(stored);
  }, [storageKey]);

  const save = () => {
    try {
      window.localStorage.setItem(storageKey, draft);
      setSavedDraft(draft);
      toast.success('Workspace note saved locally', map.name);
    } catch (error) {
      toast.error(
        'Could not save workspace note',
        error instanceof Error ? error.message : 'This app profile denied local storage.',
      );
    }
  };

  const appendSelection = () => {
    const excerpt = `## ${selected.title}\n\n${selected.summary}`.slice(0, MAX_CONTEXT_NOTE_CHARS);
    setDraft((current) =>
      `${current}${current ? '\n\n' : ''}${excerpt}`.slice(0, MAX_CONTEXT_NOTE_CHARS),
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Local workspace note</div>
          <h2 className="mt-1 font-display text-3xl font-semibold text-foreground">{map.name}</h2>
          <p className="text-secondary text-muted-foreground">
            Saved only in this app-data profile. It does not modify source files or sync to a
            provider.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={appendSelection}>
            Add selected summary
          </Button>
          <Button size="sm" variant="accent" onClick={save} disabled={draft === savedDraft}>
            Save note
          </Button>
        </div>
      </div>
      <textarea
        value={draft}
        maxLength={MAX_CONTEXT_NOTE_CHARS}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Context workspace note"
        placeholder="Capture decisions, questions, and links for this Context map…"
        className="min-h-0 flex-1 resize-none rounded-2xl border border-border bg-paper p-5 font-mono text-secondary leading-relaxed text-foreground shadow-inner outline-none transition-colors placeholder:text-muted-foreground focus:border-accent-copper focus:ring-2 focus:ring-ring"
      />
      <div className="mt-2 flex justify-between text-metadata text-muted-foreground">
        <span>{draft === savedDraft ? 'Saved locally' : 'Unsaved changes'}</span>
        <span>
          {draft.length.toLocaleString()} / {MAX_CONTEXT_NOTE_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

function ContextStructuredView({
  tree,
  rootNode,
  nodes,
  selectedId,
  onSelect,
}: {
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  nodes: readonly ContextTreeNode[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const visible = [rootNode, ...nodes].slice(0, 500);
  return (
    <div className="flex h-full min-h-0 flex-col p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <div className="eyebrow">Structured view</div>
          <h2 className="mt-1 font-display text-3xl font-semibold text-foreground">
            {tree.summary}
          </h2>
        </div>
        <span className="rounded-full border border-border bg-paper px-3 py-1 text-metadata text-muted-foreground">
          {(nodes.length + 1).toLocaleString()} nodes
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-paper p-2 scrollbar-hidden">
        {visible.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => onSelect(node.id)}
            className={cn(
              'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              selectedId === node.id
                ? 'bg-accent-copper/10 text-foreground'
                : 'hover:bg-paper-soft',
            )}
          >
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-secondary font-medium text-foreground">
                {node.kind === 'file' ? (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
                ) : (
                  <Network className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
                )}
                <span className="truncate">{node.title}</span>
              </span>
              <span className="mt-0.5 block truncate text-metadata text-muted-foreground">
                {node.path ?? node.summary}
              </span>
            </span>
            <span className="self-center font-mono text-metadata text-muted-foreground">
              {node.kind}
            </span>
          </button>
        ))}
      </div>
      {visible.length < nodes.length + 1 ? (
        <p className="mt-2 text-metadata text-muted-foreground">
          Showing the first 500 nodes for a responsive overview. Use Search for the complete map.
        </p>
      ) : null}
    </div>
  );
}

function ContextSearchView({
  nodes,
  query,
  onQueryChange,
  onSelect,
}: {
  nodes: readonly ContextTreeNode[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
}) {
  const normalized = query.trim().toLocaleLowerCase();
  const results = React.useMemo(() => searchContextNodes(nodes, normalized), [nodes, normalized]);
  return (
    <div className="flex h-full min-h-0 flex-col p-5">
      <div>
        <div className="eyebrow">Search this Context map</div>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value.slice(0, 500))}
            placeholder="Search titles, summaries, paths, and tags"
            className="pl-9"
            autoFocus
          />
        </div>
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-paper p-2 scrollbar-hidden">
        {!normalized ? (
          <ContextModeEmpty
            icon={<FileSearch className="h-6 w-6" />}
            title="Search the complete map"
            body="Enter a title, path, tag, or phrase. Results stay local and selecting one opens it in the inspector."
          />
        ) : results.length === 0 ? (
          <ContextModeEmpty
            icon={<Search className="h-6 w-6" />}
            title="No matching Context"
            body="Try a shorter phrase, filename, directory, or tag. Source content is not sent anywhere by this search."
          />
        ) : (
          <div className="space-y-1">
            {results.map(({ node, reason }) => (
              <button
                key={node.id}
                type="button"
                onClick={() => onSelect(node.id)}
                className="w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-paper-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block text-secondary font-semibold text-foreground">
                  {node.title}
                </span>
                <span className="mt-0.5 block line-clamp-2 text-metadata text-muted-foreground">
                  {node.path ?? node.summary}
                </span>
                <span className="mt-1 block text-[10px] uppercase tracking-wide text-accent-copper">
                  Matched {reason}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {normalized ? (
        <p className="mt-2 text-metadata text-muted-foreground">
          {results.length.toLocaleString()} result{results.length === 1 ? '' : 's'}
          {results.length === 200 ? ' shown (200-result safety limit)' : ''}
        </p>
      ) : null}
    </div>
  );
}

function ContextModeEmpty({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex h-full min-h-56 items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-copper/10 text-accent-copper">
          {icon}
        </span>
        <h3 className="mt-3 font-display text-2xl font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-secondary text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function ContextGalaxyWorkspace({
  accountId,
  projectId,
  mapId,
  tree,
  rootNode,
  selectedId,
  highlightedNodeIds,
  onSelect,
  flash,
}: {
  accountId: string | null;
  projectId: string | null;
  mapId: string;
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  selectedId: string;
  highlightedNodeIds: readonly string[];
  onSelect: (id: string) => void;
  flash: boolean;
}) {
  const galaxy = React.useMemo(
    () => contextTreeToGalaxyData({ ...tree, nodes: [rootNode] }),
    [rootNode, tree],
  );
  React.useEffect(() => {
    if (!accountId) return;
    return publishContextGalaxySnapshot({
      accountId,
      projectId,
      mapId,
      nodes: galaxy.nodes,
      edges: galaxy.edges,
      selectedId,
      activityNodeIds: highlightedNodeIds,
    });
  }, [accountId, galaxy, highlightedNodeIds, mapId, projectId, selectedId]);

  return (
    <div className="relative h-full min-h-[28rem] w-full overflow-hidden">
      <ContextGalaxy
        nodes={galaxy.nodes}
        edges={galaxy.edges}
        selectedId={selectedId}
        activityNodeIds={highlightedNodeIds}
        onSelect={onSelect}
        className="absolute inset-0 min-h-0 rounded-none border-0"
      />
      {flash ? (
        <div className="context-map-birth pointer-events-none absolute inset-0 z-30" />
      ) : null}
    </div>
  );
}

function ContextMapCanvas({
  tree,
  rootNode,
  selectedId,
  highlightedNodeIds,
  onSelect,
  flash,
}: {
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  selectedId: string;
  highlightedNodeIds: readonly string[];
  onSelect: (id: string) => void;
  flash: boolean;
}) {
  const highlightedIds = React.useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const largeMap = React.useMemo(() => hasMoreThanContextGraphNodes(rootNode, 1_000), [rootNode]);
  const immediateMap = React.useMemo(
    () => (largeMap ? buildContextMapRoot(rootNode) : buildContextMap(rootNode)),
    [largeMap, rootNode],
  );
  const [baseMap, setBaseMap] = React.useState<ContextMapLayout>(immediateMap);
  const [mapBuildError, setMapBuildError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setBaseMap(immediateMap);
    setMapBuildError(null);
    if (!largeMap) return;
    const controller = new AbortController();
    void buildContextMapCooperatively(rootNode, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setBaseMap(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMapBuildError(
            'This Context map exceeds the safe interactive graph limit. The project root remains available.',
          );
        }
      });
    return () => controller.abort();
  }, [immediateMap, largeMap, rootNode]);
  const [workerMap, setWorkerMap] = React.useState<ContextMapLayout | null>(null);
  const layoutCoordinator = React.useMemo(
    () => createGraphLayoutCoordinator(createContextGraphLayoutWorker),
    [],
  );
  React.useEffect(() => () => layoutCoordinator.dispose(), [layoutCoordinator]);
  React.useEffect(() => {
    setWorkerMap(null);
    if (baseMap.nodes.length <= 1_000) return;
    let active = true;
    const yieldControl = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    void (async () => {
      const parentByNode = new Map<string, string>();
      for (let offset = 0; offset < baseMap.edges.length; offset += 500) {
        if (!active) return;
        for (const edge of baseMap.edges.slice(offset, offset + 500)) {
          parentByNode.set(edge.to, edge.from);
        }
        await yieldControl();
      }
      const orderByDepth = new Map<number, number>();
      const layoutNodes = [];
      for (let offset = 0; offset < baseMap.nodes.length; offset += 500) {
        if (!active) return;
        for (const node of baseMap.nodes.slice(offset, offset + 500)) {
          const order = orderByDepth.get(node.depth) ?? 0;
          orderByDepth.set(node.depth, order + 1);
          layoutNodes.push({
            id: node.id,
            parentId: node.depth === 0 ? null : (parentByNode.get(node.id) ?? null),
            depth: node.depth,
            order,
            radius: node.r,
          });
        }
        await yieldControl();
      }
      const result = await layoutCoordinator.layout({
        width: MAP_WIDTH,
        height: MAP_HEIGHT,
        nodes: layoutNodes,
      });
      if (!active) return;
      const positions = new Map<string, { x: number; y: number }>();
      for (let offset = 0; offset < result.nodes.length; offset += 500) {
        for (const node of result.nodes.slice(offset, offset + 500)) {
          positions.set(node.id, node);
        }
        await yieldControl();
        if (!active) return;
      }
      const nodes: PositionedContextNode[] = [];
      const byId = new Map<string, PositionedContextNode>();
      for (let offset = 0; offset < baseMap.nodes.length; offset += 500) {
        for (const node of baseMap.nodes.slice(offset, offset + 500)) {
          const position = positions.get(node.id);
          const positioned = position ? { ...node, x: position.x, y: position.y } : node;
          nodes.push(positioned);
          byId.set(positioned.id, positioned);
        }
        await yieldControl();
        if (!active) return;
      }
      if (active) {
        setWorkerMap({
          nodes,
          edges: baseMap.edges,
          byId,
          edgeById: baseMap.edgeById,
        });
      }
    })().catch(() => {
      if (active) setWorkerMap(null);
    });
    return () => {
      active = false;
    };
  }, [baseMap, layoutCoordinator]);
  const map = workerMap ?? baseMap;
  const [view, setView] = React.useState(DEFAULT_VIEW);
  const [panning, setPanning] = React.useState(false);
  const dragRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startView: MapView;
  } | null>(null);
  const [performanceIndex, setPerformanceIndex] = React.useState(
    () =>
      new ContextGraphPerformanceIndex({
        nodes: immediateMap.nodes.map((node) => ({
          id: node.id,
          x: node.x,
          y: node.y,
          radius: node.r,
        })),
        edges: immediateMap.edges.map((edge) => ({
          id: edge.id,
          sourceId: edge.from,
          targetId: edge.to,
        })),
        cellSize: 320,
      }),
  );
  React.useEffect(() => {
    const controller = new AbortController();
    if (map.nodes.length <= 1_000) {
      setPerformanceIndex(
        new ContextGraphPerformanceIndex({
          nodes: map.nodes.map((node) => ({
            id: node.id,
            x: node.x,
            y: node.y,
            radius: node.r,
          })),
          edges: map.edges.map((edge) => ({
            id: edge.id,
            sourceId: edge.from,
            targetId: edge.to,
          })),
          cellSize: 320,
        }),
      );
      return () => controller.abort();
    }
    void buildContextGraphPerformanceIndexCooperatively(
      { nodes: map.nodes, edges: map.edges, cellSize: 320 },
      {
        signal: controller.signal,
        mapNode: (node) => ({ id: node.id, x: node.x, y: node.y, radius: node.r }),
        mapEdge: (edge) => ({ id: edge.id, sourceId: edge.from, targetId: edge.to }),
      },
    )
      .then((next) => {
        if (!controller.signal.aborted) setPerformanceIndex(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setMapBuildError(
            'The large Context map could not be indexed safely. The last complete view remains available.',
          );
        }
      });
    return () => controller.abort();
  }, [map]);
  const visibleGraph = React.useMemo(
    () => performanceIndex.query(view, 220),
    [performanceIndex, view],
  );
  const visibleNodes = React.useMemo(
    () => visibleGraph.nodes.map(({ id }) => map.byId.get(id)!).filter(Boolean),
    [map, visibleGraph.nodes],
  );
  const visibleEdges = React.useMemo(
    () => visibleGraph.edges.map(({ id }) => map.edgeById.get(id)!).filter(Boolean),
    [map.edgeById, visibleGraph.edges],
  );
  const [webGlUnavailable, setWebGlUnavailable] = React.useState(false);
  const handleWebGlFailure = React.useCallback(() => setWebGlUnavailable(true), []);
  const renderer = React.useMemo(() => {
    const capabilities = detectGraphRendererCapabilities();
    return selectGraphRenderer({
      totalNodes: map.nodes.length,
      totalEdges: map.edges.length,
      canvas2d: capabilities.canvas2d,
      webgl2: capabilities.webgl2 && !webGlUnavailable,
    });
  }, [map.edges.length, map.nodes.length, webGlUnavailable]);
  const suppressContextMenu = React.useCallback((durationMs = 900) => {
    document.body.dataset.jarvisSuppressContextMenuUntil = String(Date.now() + durationMs);
  }, []);

  const recenter = React.useCallback(() => setView(DEFAULT_VIEW), []);

  React.useEffect(() => {
    recenter();
  }, [recenter, rootNode.id, rootNode.modifiedAt]);

  React.useEffect(() => {
    const onRecenter = () => recenter();
    window.addEventListener('jarvis:context:recenter-map', onRecenter);
    return () => window.removeEventListener('jarvis:context:recenter-map', onRecenter);
  }, [recenter]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 2) return;
    event.preventDefault();
    suppressContextMenu();
    document.body.classList.add('jarvis-context-map-right-dragging');
    setPanning(true);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startView: view,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = drag.startView.width / Math.max(1, rect.width);
    const scaleY = drag.startView.height / Math.max(1, rect.height);
    setView(
      clampView({
        ...drag.startView,
        x: drag.startView.x - (event.clientX - drag.startX) * scaleX,
        y: drag.startView.y - (event.clientY - drag.startY) * scaleY,
      }),
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    suppressContextMenu();
    document.body.classList.remove('jarvis-context-map-right-dragging');
    setPanning(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  React.useEffect(() => {
    return () => {
      document.body.classList.remove('jarvis-context-map-right-dragging');
    };
  }, []);

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const nextScale = event.deltaY > 0 ? 1.12 : 0.88;
    const nextWidth = Math.max(650, Math.min(MAP_WIDTH, view.width * nextScale));
    const nextHeight = Math.max(430, Math.min(MAP_HEIGHT, view.height * nextScale));
    const px = (event.clientX - rect.left) / Math.max(1, rect.width);
    const py = (event.clientY - rect.top) / Math.max(1, rect.height);
    const worldX = view.x + px * view.width;
    const worldY = view.y + py * view.height;
    setView(
      clampView({
        x: worldX - px * nextWidth,
        y: worldY - py * nextHeight,
        width: nextWidth,
        height: nextHeight,
      }),
    );
  };

  return (
    <div
      className={cn(
        'relative h-full w-full select-none overflow-hidden',
        panning ? 'cursor-grabbing' : 'cursor-default',
      )}
      data-jarvis-suppress-context-menu
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <button
        type="button"
        onClick={recenter}
        className="absolute right-4 top-4 z-20 inline-flex items-center gap-2 rounded-2xl border border-accent-copper/35 bg-paper/90 px-3 py-2 text-secondary text-accent-copper shadow-soft backdrop-blur transition-all hover:-translate-y-0.5 hover:bg-accent-copper/10"
      >
        <LocateFixed className="h-4 w-4" /> Center Map
      </button>
      {mapBuildError ? (
        <div
          role="alert"
          className="absolute left-4 top-20 z-20 max-w-md rounded-2xl border border-destructive/35 bg-paper/95 px-4 py-3 text-secondary text-destructive shadow-soft backdrop-blur"
        >
          {mapBuildError}
        </div>
      ) : null}
      {visibleGraph.truncated && !mapBuildError ? (
        <div
          role="status"
          className="absolute bottom-4 left-4 z-20 rounded-xl border border-border bg-paper/90 px-3 py-2 text-metadata text-muted-foreground shadow-soft backdrop-blur"
        >
          Showing a bounded visible subset. Zoom in to inspect more nodes and links.
        </div>
      ) : null}
      {renderer === 'svg' ? (
        <svg
          className="h-full w-full"
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
          role="img"
          aria-label="Interactive Jarvis Context map"
        >
          <defs>
            <filter id="context-node-glow" x="-40%" y="-40%" width="180%" height="180%">
              <feDropShadow
                dx="0"
                dy="8"
                stdDeviation="10"
                floodColor="hsl(var(--accent-copper))"
                floodOpacity="0.18"
              />
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="black" floodOpacity="0.24" />
            </filter>
            <radialGradient id="context-root-fill" cx="36%" cy="28%" r="74%">
              <stop offset="0%" stopColor="hsl(var(--cream) / 0.26)" />
              <stop offset="48%" stopColor="hsl(var(--accent-copper) / 0.28)" />
              <stop offset="100%" stopColor="hsl(var(--paper-soft))" />
            </radialGradient>
            <radialGradient id="context-file-fill" cx="34%" cy="24%" r="78%">
              <stop offset="0%" stopColor="hsl(var(--honey) / 0.28)" />
              <stop offset="100%" stopColor="hsl(var(--paper-soft))" />
            </radialGradient>
            <pattern id="context-grid" width="90" height="90" patternUnits="userSpaceOnUse">
              <path
                d="M 90 0 L 0 0 0 90"
                fill="none"
                stroke="hsl(var(--border) / 0.22)"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect
            x="0"
            y="0"
            width={MAP_WIDTH}
            height={MAP_HEIGHT}
            fill="hsl(var(--background) / 0.74)"
          />
          <rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#context-grid)" />
          <circle
            cx={MAP_CENTER.x}
            cy={MAP_CENTER.y}
            r="1680"
            fill="hsl(var(--accent-copper) / 0.05)"
          />
          <circle
            cx={MAP_CENTER.x}
            cy={MAP_CENTER.y}
            r="1160"
            fill="none"
            stroke="hsl(var(--accent-amber) / 0.16)"
            strokeDasharray="18 22"
            strokeWidth="3"
          />

          {visibleEdges.map((edge) => {
            const from = map.byId.get(edge.from);
            const to = map.byId.get(edge.to);
            if (!from || !to) return null;
            const active = selectedId === edge.to;
            const path = edgePath(from, to);
            const labelPoint = edgeLabelPoint(from, to);
            return (
              <g key={edge.id}>
                <path
                  d={path}
                  fill="none"
                  stroke={
                    active
                      ? 'hsl(var(--accent-amber) / 0.9)'
                      : 'hsl(var(--muted-foreground) / 0.42)'
                  }
                  strokeWidth={active ? 4 : 2.4}
                  strokeLinecap="round"
                />
                <path
                  d={path}
                  fill="none"
                  stroke="transparent"
                  strokeWidth="24"
                  strokeLinecap="round"
                  className="cursor-pointer"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(edge.to);
                  }}
                />
                {edge.depth <= 1 ? (
                  <text
                    x={labelPoint.x}
                    y={labelPoint.y}
                    textAnchor="middle"
                    className="pointer-events-none fill-muted-foreground font-mono text-[22px]"
                  >
                    {edge.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          {visibleNodes.map((node) => (
            <MapNodeView
              key={node.id}
              tree={tree}
              node={node}
              active={selectedId === node.id}
              highlighted={highlightedIds.has(node.id)}
              onSelect={onSelect}
            />
          ))}
        </svg>
      ) : (
        <ContextMapRasterCanvas
          key={renderer}
          mode={renderer}
          tree={tree}
          map={map}
          nodes={visibleNodes}
          edges={visibleEdges}
          view={view}
          selectedId={selectedId}
          highlightedIds={highlightedIds}
          onSelect={onSelect}
          onWebGlFailure={handleWebGlFailure}
        />
      )}
      {flash ? (
        <div className="context-map-birth pointer-events-none absolute inset-0 z-30" />
      ) : null}
    </div>
  );
}

let graphRendererCapabilitiesCache: { canvas2d: boolean; webgl2: boolean } | undefined;

function detectGraphRendererCapabilities(): { canvas2d: boolean; webgl2: boolean } {
  if (graphRendererCapabilitiesCache) return graphRendererCapabilitiesCache;
  if (typeof document === 'undefined') return { canvas2d: false, webgl2: false };
  try {
    const webgl = document.createElement('canvas').getContext('webgl2');
    graphRendererCapabilitiesCache = {
      canvas2d: Boolean(document.createElement('canvas').getContext('2d')),
      webgl2: Boolean(webgl),
    };
    webgl?.getExtension('WEBGL_lose_context')?.loseContext();
    return graphRendererCapabilitiesCache;
  } catch {
    graphRendererCapabilitiesCache = { canvas2d: false, webgl2: false };
    return graphRendererCapabilitiesCache;
  }
}

function ContextMapRasterCanvas({
  mode,
  tree,
  map,
  nodes,
  edges,
  view,
  selectedId,
  highlightedIds,
  onSelect,
  onWebGlFailure,
}: {
  mode: 'canvas' | 'webgl';
  tree: ProjectContextTree;
  map: ContextMapLayout;
  nodes: PositionedContextNode[];
  edges: ContextMapEdge[];
  view: MapView;
  selectedId: string;
  highlightedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onWebGlFailure: () => void;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const announcementId = React.useId();
  const [canvasSizeVersion, setCanvasSizeVersion] = React.useState(0);
  const hitNodes = React.useMemo(
    () => nodes.map((node) => ({ id: node.id, x: node.x, y: node.y, radius: node.r })),
    [nodes],
  );
  const hitEdges = React.useMemo(
    () => edges.map((edge) => ({ id: edge.id, sourceId: edge.from, targetId: edge.to })),
    [edges],
  );
  const hitNodeById = React.useMemo(
    () => new Map(hitNodes.map((node) => [node.id, node])),
    [hitNodes],
  );
  const selectedVisibleNode = React.useMemo(
    () => nodes.find((node) => node.id === selectedId) ?? null,
    [nodes, selectedId],
  );
  const hitAtClientPoint = React.useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const worldX = view.x + ((clientX - rect.left) / Math.max(1, rect.width)) * view.width;
      const worldY = view.y + ((clientY - rect.top) / Math.max(1, rect.height)) * view.height;
      return hitTestContextGraph({ x: worldX, y: worldY }, hitNodes, hitEdges, hitNodeById);
    },
    [hitEdges, hitNodeById, hitNodes, view],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => setCanvasSizeVersion((value) => value + 1));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    return () => {
      if (canvas) releaseContextMapWebGl(canvas);
    };
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || mode !== 'webgl') return;
    const onContextLost = (event: Event) => {
      event.preventDefault();
      releaseContextMapWebGl(canvas);
      onWebGlFailure();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    return () => canvas.removeEventListener('webglcontextlost', onContextLost);
  }, [mode, onWebGlFailure]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = Math.max(1, Math.round(canvas.clientWidth * window.devicePixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * window.devicePixelRatio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    if (mode === 'webgl') {
      if (!drawContextMapWebGl(canvas, map, nodes, edges, view, selectedId, highlightedIds)) {
        onWebGlFailure();
      }
    } else {
      drawContextMapCanvas2d(canvas, map, nodes, edges, view, selectedId, highlightedIds);
    }
  }, [
    canvasSizeVersion,
    edges,
    highlightedIds,
    map,
    mode,
    nodes,
    onWebGlFailure,
    selectedId,
    view,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        role="application"
        tabIndex={0}
        aria-describedby={announcementId}
        aria-label={`Interactive Jarvis Context map (${mode} renderer). Use arrow keys to move between visible nodes, Enter to select, or the adjacent Context inspector for the full tree.`}
        data-context-graph-renderer={mode}
        onClick={(event) => {
          const hit = hitAtClientPoint(event.clientX, event.clientY);
          if (hit?.kind === 'node') onSelect(hit.id);
          if (hit?.kind === 'edge') onSelect(hit.targetId);
        }}
        onPointerDown={(event) => {
          if (event.button !== 2) return;
          const hit = hitAtClientPoint(event.clientX, event.clientY);
          if (hit?.kind === 'node') {
            event.stopPropagation();
          }
        }}
        onMouseDown={(event) => {
          if (event.button !== 2) return;
          const hit = hitAtClientPoint(event.clientX, event.clientY);
          if (hit?.kind !== 'node') return;
          const contextNode =
            findContextNode(tree, hit.id) ??
            (hit.id === PROJECT_ROOT_NODE_ID ? makeProjectRootNode(tree) : null);
          if (!contextNode) return;
          event.preventDefault();
          event.stopPropagation();
          startRightClickDrag(event, 'context', { node: contextNode, tree });
        }}
        onKeyDown={(event) => {
          if (nodes.length === 0) return;
          const current = nodes.findIndex((node) => node.id === selectedId);
          let next = current < 0 ? 0 : current;
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = (next + 1) % nodes.length;
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = (next - 1 + nodes.length) % nodes.length;
          } else if (event.key === 'Home') {
            next = 0;
          } else if (event.key === 'End') {
            next = nodes.length - 1;
          } else if (event.key === 'Enter' || event.key === ' ') {
            if (current >= 0) onSelect(nodes[current]!.id);
            event.preventDefault();
            return;
          } else {
            return;
          }
          event.preventDefault();
          onSelect(nodes[next]!.id);
        }}
      />
      <span id={announcementId} className="sr-only" aria-live="polite" aria-atomic="true">
        {selectedVisibleNode
          ? `Selected ${selectedVisibleNode.title}, ${selectedVisibleNode.kind} node. ${nodes.length.toLocaleString()} nodes are visible.`
          : `No visible node selected. ${nodes.length.toLocaleString()} nodes are visible.`}
      </span>
    </>
  );
}

function themeHsl(token: string, alpha: number): string {
  const channels = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return channels ? `hsl(${channels} / ${alpha})` : `rgb(128 128 128 / ${alpha})`;
}

function drawContextMapCanvas2d(
  canvas: HTMLCanvasElement,
  map: ContextMapLayout,
  nodes: PositionedContextNode[],
  edges: ContextMapEdge[],
  view: MapView,
  selectedId: string,
  highlightedIds: ReadonlySet<string>,
) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const scaleX = canvas.width / view.width;
  const scaleY = canvas.height / view.height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = themeHsl('--background', 0.92);
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(scaleX, 0, 0, scaleY, -view.x * scaleX, -view.y * scaleY);
  context.lineCap = 'round';
  for (const edge of edges) {
    const from = map.byId.get(edge.from);
    const to = map.byId.get(edge.to);
    if (!from || !to) continue;
    const active = selectedId === edge.to;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const curve = Math.min(155, distance * 0.18);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.quadraticCurveTo(
      (from.x + to.x) / 2 - (dy / distance) * curve,
      (from.y + to.y) / 2 + (dx / distance) * curve,
      to.x,
      to.y,
    );
    context.strokeStyle = active
      ? themeHsl('--accent-amber', 0.9)
      : themeHsl('--muted-foreground', 0.42);
    context.lineWidth = active ? 4 : 2.4;
    context.stroke();
  }
  for (const node of nodes) {
    const active = selectedId === node.id;
    const highlighted = highlightedIds.has(node.id);
    if (highlighted && !active) {
      context.beginPath();
      context.arc(node.x, node.y, node.r + 10, 0, Math.PI * 2);
      context.strokeStyle = themeHsl('--accent-honey', 0.9);
      context.lineWidth = 7;
      context.stroke();
    }
    context.beginPath();
    context.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    context.fillStyle =
      node.kind === 'root'
        ? themeHsl('--accent-copper', 0.34)
        : node.kind === 'file'
          ? themeHsl('--honey', 0.3)
          : themeHsl('--paper-soft', 1);
    context.fill();
    context.strokeStyle = active
      ? themeHsl('--accent-amber', 1)
      : highlighted
        ? themeHsl('--accent-honey', 1)
        : themeHsl('--accent-copper', 0.68);
    context.lineWidth = active ? 5 : highlighted ? 4 : 2.5;
    context.stroke();
    if (nodes.length <= 250) {
      context.fillStyle = themeHsl('--foreground', 0.92);
      context.font = `${Math.max(16, Math.min(24, node.r * 0.28))}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(node.title.slice(0, 24), node.x, node.y, node.r * 1.65);
    }
  }
}

interface ContextMapWebGlResources {
  gl: WebGL2RenderingContext;
  vertex: WebGLShader;
  fragment: WebGLShader;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  positionLocation: number;
  sizeLocation: number;
  colorLocation: WebGLUniformLocation;
  pointsLocation: WebGLUniformLocation;
  edgeVertices: Float32Array;
  nodeVertices: Float32Array;
  edgeWorldPoints: Float64Array;
  selectedVertex: Float32Array;
}

const contextMapWebGlResources = new WeakMap<HTMLCanvasElement, ContextMapWebGlResources>();

function releaseContextMapWebGl(canvas: HTMLCanvasElement): void {
  const resources = contextMapWebGlResources.get(canvas);
  if (!resources) return;
  resources.gl.deleteBuffer(resources.buffer);
  resources.gl.deleteProgram(resources.program);
  resources.gl.deleteShader(resources.vertex);
  resources.gl.deleteShader(resources.fragment);
  contextMapWebGlResources.delete(canvas);
}

function acquireContextMapWebGl(canvas: HTMLCanvasElement): ContextMapWebGlResources | null {
  const cached = contextMapWebGlResources.get(canvas);
  if (cached && !cached.gl.isContextLost()) return cached;
  if (cached) releaseContextMapWebGl(canvas);
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true });
  if (!gl) return null;
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  const cleanup = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
  };
  if (!vertex || !fragment || !program || !buffer) {
    cleanup();
    return null;
  }
  gl.shaderSource(
    vertex,
    `#version 300 es
      in vec2 a_position;
      in float a_size;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        gl_PointSize = a_size;
      }`,
  );
  gl.shaderSource(
    fragment,
    `#version 300 es
      precision mediump float;
      uniform vec4 u_color;
      uniform bool u_points;
      out vec4 outColor;
      void main() {
        if (u_points && distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
        outColor = u_color;
      }`,
  );
  gl.compileShader(vertex);
  gl.compileShader(fragment);
  if (
    !gl.getShaderParameter(vertex, gl.COMPILE_STATUS) ||
    !gl.getShaderParameter(fragment, gl.COMPILE_STATUS)
  ) {
    cleanup();
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const sizeLocation = gl.getAttribLocation(program, 'a_size');
  const colorLocation = gl.getUniformLocation(program, 'u_color');
  const pointsLocation = gl.getUniformLocation(program, 'u_points');
  if (
    !gl.getProgramParameter(program, gl.LINK_STATUS) ||
    positionLocation < 0 ||
    sizeLocation < 0 ||
    !colorLocation ||
    !pointsLocation
  ) {
    cleanup();
    return null;
  }
  const resources = {
    gl,
    vertex,
    fragment,
    program,
    buffer,
    positionLocation,
    sizeLocation,
    colorLocation,
    pointsLocation,
    edgeVertices: new Float32Array(0),
    nodeVertices: new Float32Array(0),
    edgeWorldPoints: new Float64Array(34),
    selectedVertex: new Float32Array(3),
  };
  contextMapWebGlResources.set(canvas, resources);
  return resources;
}

function ensureContextMapFloatCapacity(current: Float32Array, required: number): Float32Array {
  if (current.length >= required) return current;
  let capacity = Math.max(256, current.length);
  while (capacity < required) capacity *= 2;
  return new Float32Array(capacity);
}

function drawContextMapWebGl(
  canvas: HTMLCanvasElement,
  map: ContextMapLayout,
  nodes: PositionedContextNode[],
  edges: ContextMapEdge[],
  view: MapView,
  selectedId: string,
  highlightedIds: ReadonlySet<string>,
): boolean {
  const resources = acquireContextMapWebGl(canvas);
  if (!resources) return false;
  const { gl, program, buffer, positionLocation, sizeLocation, colorLocation, pointsLocation } =
    resources;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 12, 0);
  gl.enableVertexAttribArray(sizeLocation);
  gl.vertexAttribPointer(sizeLocation, 1, gl.FLOAT, false, 12, 8);
  resources.edgeVertices = ensureContextMapFloatCapacity(
    resources.edgeVertices,
    edges.length * 16 * 6,
  );
  let edgeOffset = 0;
  for (const edge of edges) {
    const from = map.byId.get(edge.from);
    const to = map.byId.get(edge.to);
    if (!from || !to) continue;
    writeContextGraphEdgePoints(from, to, resources.edgeWorldPoints);
    for (let pointOffset = 2; pointOffset < resources.edgeWorldPoints.length; pointOffset += 2) {
      resources.edgeVertices[edgeOffset++] =
        ((resources.edgeWorldPoints[pointOffset - 2]! - view.x) / view.width) * 2 - 1;
      resources.edgeVertices[edgeOffset++] =
        1 - ((resources.edgeWorldPoints[pointOffset - 1]! - view.y) / view.height) * 2;
      resources.edgeVertices[edgeOffset++] = 1;
      resources.edgeVertices[edgeOffset++] =
        ((resources.edgeWorldPoints[pointOffset]! - view.x) / view.width) * 2 - 1;
      resources.edgeVertices[edgeOffset++] =
        1 - ((resources.edgeWorldPoints[pointOffset + 1]! - view.y) / view.height) * 2;
      resources.edgeVertices[edgeOffset++] = 1;
    }
  }
  gl.bufferData(gl.ARRAY_BUFFER, resources.edgeVertices.subarray(0, edgeOffset), gl.DYNAMIC_DRAW);
  gl.uniform4f(colorLocation, 0.62, 0.48, 0.38, 0.46);
  gl.uniform1i(pointsLocation, 0);
  gl.drawArrays(gl.LINES, 0, edgeOffset / 3);
  resources.nodeVertices = ensureContextMapFloatCapacity(resources.nodeVertices, nodes.length * 3);
  let nodeOffset = 0;
  for (const node of nodes) {
    resources.nodeVertices[nodeOffset++] = ((node.x - view.x) / view.width) * 2 - 1;
    resources.nodeVertices[nodeOffset++] = 1 - ((node.y - view.y) / view.height) * 2;
    resources.nodeVertices[nodeOffset++] = Math.max(3, (node.r * 2 * canvas.width) / view.width);
  }
  gl.bufferData(gl.ARRAY_BUFFER, resources.nodeVertices.subarray(0, nodeOffset), gl.DYNAMIC_DRAW);
  gl.uniform4f(colorLocation, 0.72, 0.42, 0.2, 0.88);
  gl.uniform1i(pointsLocation, 1);
  gl.drawArrays(gl.POINTS, 0, nodeOffset / 3);
  let highlightedOffset = 0;
  for (const node of nodes) {
    if (!highlightedIds.has(node.id) || node.id === selectedId) continue;
    resources.nodeVertices[highlightedOffset++] = ((node.x - view.x) / view.width) * 2 - 1;
    resources.nodeVertices[highlightedOffset++] = 1 - ((node.y - view.y) / view.height) * 2;
    resources.nodeVertices[highlightedOffset++] = Math.max(
      5,
      (node.r * 2.2 * canvas.width) / view.width,
    );
  }
  if (highlightedOffset > 0) {
    gl.bufferData(
      gl.ARRAY_BUFFER,
      resources.nodeVertices.subarray(0, highlightedOffset),
      gl.DYNAMIC_DRAW,
    );
    gl.uniform4f(colorLocation, 0.93, 0.62, 0.24, 1);
    gl.drawArrays(gl.POINTS, 0, highlightedOffset / 3);
  }
  const selected = nodes.find((node) => node.id === selectedId);
  if (selected) {
    resources.selectedVertex[0] = ((selected.x - view.x) / view.width) * 2 - 1;
    resources.selectedVertex[1] = 1 - ((selected.y - view.y) / view.height) * 2;
    resources.selectedVertex[2] = Math.max(5, (selected.r * 2.2 * canvas.width) / view.width);
    gl.bufferData(gl.ARRAY_BUFFER, resources.selectedVertex, gl.DYNAMIC_DRAW);
    gl.uniform4f(colorLocation, 0.95, 0.65, 0.2, 1);
    gl.drawArrays(gl.POINTS, 0, 1);
  }
  return true;
}

function MapNodeView({
  tree,
  node,
  active,
  highlighted,
  onSelect,
}: {
  tree: ProjectContextTree;
  node: PositionedContextNode;
  active: boolean;
  highlighted: boolean;
  onSelect: (id: string) => void;
}) {
  const lines = splitLabel(node.title, node.kind === 'file' ? 15 : 18);
  const fill =
    node.kind === 'root'
      ? 'url(#context-root-fill)'
      : node.kind === 'file'
        ? 'url(#context-file-fill)'
        : 'hsl(var(--paper-soft))';
  const stroke = active
    ? 'hsl(var(--accent-amber))'
    : highlighted
      ? 'hsl(var(--accent-honey))'
      : node.kind === 'file'
        ? 'hsl(var(--accent-amber) / 0.68)'
        : 'hsl(var(--accent-copper) / 0.62)';
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      className="cursor-pointer"
      filter="url(#context-node-glow)"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      onMouseDown={(e) => {
        if (e.button === 2) {
          e.stopPropagation();
          startRightClickDrag(e, 'context', { node, tree });
        }
      }}
    >
      {active || highlighted ? (
        <circle
          r={node.r + 12}
          fill="none"
          stroke={active ? 'hsl(var(--accent-amber) / 0.42)' : 'hsl(var(--accent-honey) / 0.58)'}
          strokeWidth={active ? 8 : 6}
        />
      ) : null}
      <circle
        r={node.r}
        fill={fill}
        stroke={stroke}
        strokeWidth={active ? 5 : highlighted ? 4 : 3}
      />
      <circle
        cx={-node.r * 0.32}
        cy={-node.r * 0.32}
        r={Math.max(8, node.r * 0.12)}
        fill="hsl(var(--cream) / 0.22)"
      />
      <text
        textAnchor="middle"
        className="pointer-events-none fill-foreground font-sans text-[24px] font-semibold"
      >
        {lines.map((line, index) => (
          <tspan
            key={line + index}
            x="0"
            dy={index === 0 ? (lines.length === 1 ? '0.32em' : '-0.08em') : '1.08em'}
          >
            {line}
          </tspan>
        ))}
      </text>
      <text
        y={node.r + 28}
        textAnchor="middle"
        className="pointer-events-none fill-muted-foreground font-mono text-[19px] uppercase tracking-[0.2em]"
      >
        {node.kind}
      </text>
    </g>
  );
}

function ContextInspector({
  tree,
  map,
  node,
  onSelect,
  tab,
  onTabChange,
  githubBadge,
  jarvisUi,
  compact,
}: {
  tree: ProjectContextTree;
  map: ContextMapRecord | null;
  node: ContextTreeNode;
  onSelect: (id: string) => void;
  tab: ContextInspectorTabId;
  onTabChange: (tab: ContextInspectorTabId) => void;
  githubBadge: ContextGitHubMapBadge | null;
  jarvisUi: ContextJarvisUi;
  compact: boolean;
}) {
  const onDragStart = useContextDrag(tree, node);
  const [packOpen, setPackOpen] = React.useState(false);
  const backlinks = React.useMemo(() => contextNodeBacklinks(tree, node.id), [node.id, tree]);
  const jarvisNodes = React.useMemo(
    () =>
      jarvisUi.highlightedNodeIds.flatMap((id) => {
        const match =
          id === PROJECT_ROOT_NODE_ID ? makeProjectRootNode(tree) : findContextNode(tree, id);
        return match ? [match] : [];
      }),
    [jarvisUi.highlightedNodeIds, tree],
  );
  React.useEffect(() => setPackOpen(false), [jarvisUi.retrievalPackId]);
  const tabIcons: Record<ContextInspectorTabId, React.ComponentType<{ className?: string }>> = {
    details: Sparkles,
    links: Link2,
    backlinks: GitBranch,
    properties: TableProperties,
    sources: Database,
    jarvis_activity: BrainCircuit,
    history: History,
  };

  let content: React.ReactNode;
  if (tab === 'details') {
    content = (
      <section className="rounded-2xl border border-border bg-paper p-4 shadow-soft">
        <div className="mb-2 flex items-center gap-2 text-ui-strong text-foreground">
          <Sparkles className="h-4 w-4 text-accent-copper" /> Summary
        </div>
        <p className="whitespace-pre-wrap text-body leading-relaxed text-muted-foreground">
          {node.summary || 'This node has no generated summary yet. Refresh the map to enrich it.'}
        </p>
      </section>
    );
  } else if (tab === 'links') {
    content = (
      <ContextInspectorNodeList
        title="Outgoing links"
        empty="This node has no child links. Select another node or inspect Backlinks."
        nodes={node.children ?? []}
        onSelect={onSelect}
      />
    );
  } else if (tab === 'backlinks') {
    content = (
      <ContextInspectorNodeList
        title="Backlinks"
        empty="No parent or referencing node is recorded for this map root."
        nodes={backlinks}
        onSelect={onSelect}
      />
    );
  } else if (tab === 'properties') {
    content = (
      <section className="rounded-2xl border border-border bg-paper-soft p-4 shadow-soft">
        <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
          <TableProperties className="h-4 w-4 text-accent-honey" /> Properties
        </div>
        <dl className="space-y-2 text-secondary">
          <MetaRow label="Kind" value={node.kind} />
          <MetaRow label="Size" value={formatBytes(node.sizeBytes)} />
          <MetaRow label="Created" value={formatDate(node.createdAt)} />
          <MetaRow label="Modified" value={formatDate(node.modifiedAt)} />
          <MetaRow label="Children" value={String(node.children?.length ?? 0)} />
          <MetaRow label="Importance" value={String(node.importance ?? 'Not scored')} />
        </dl>
        {node.tags?.length ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border bg-paper px-2 py-0.5 text-metadata text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-metadata text-muted-foreground">No tags recorded.</p>
        )}
      </section>
    );
  } else if (tab === 'sources') {
    content = (
      <div className="space-y-3">
        <section className="rounded-2xl border border-border bg-paper p-4 shadow-soft">
          <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
            <Database className="h-4 w-4 text-accent-copper" /> Source provenance
          </div>
          <dl className="space-y-2 text-secondary">
            <MetaRow label="Type" value={map?.sourceType ?? 'local_folder'} />
            <MetaRow label="Source" value={map?.sourceLabel ?? tree.rootDir} />
            <MetaRow label="Root" value={map?.rootDir || tree.rootDir || 'Remote repository'} />
            <MetaRow label="Node path" value={node.path ?? 'Map root'} />
            <MetaRow label="Status" value={map?.sourceStatus ?? 'preview'} />
          </dl>
        </section>
        {map?.sourceType === 'github_repository' ? (
          <GitHubMapIdentity map={map} badge={githubBadge} />
        ) : (
          <p className="rounded-xl border border-border bg-paper-soft p-3 text-metadata text-muted-foreground">
            This is a local source. VibeSpace indexes it locally unless you explicitly choose a
            cloud model for map generation.
          </p>
        )}
      </div>
    );
  } else if (tab === 'jarvis_activity') {
    content = jarvisUi.visible ? (
      <section className="rounded-2xl border border-accent-honey/35 bg-paper p-4 shadow-soft">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 text-ui-strong text-accent-honey">
              <Sparkles className="h-4 w-4" /> {jarvisUi.chip}
            </div>
            <p className="mt-1 text-secondary text-muted-foreground">
              {jarvisUi.sourceCount.toLocaleString()} source
              {jarvisUi.sourceCount === 1 ? '' : 's'} in this retrieval pack.
            </p>
          </div>
          <Button size="sm" variant="accent" onClick={() => setPackOpen((open) => !open)}>
            {packOpen ? 'Close pack' : 'Open retrieval pack'}
          </Button>
        </div>
        {packOpen ? (
          <div className="mt-4 space-y-2">
            <div className="font-mono text-metadata text-muted-foreground">
              Pack {jarvisUi.retrievalPackId}
            </div>
            {jarvisNodes.length ? (
              jarvisNodes.map((source) => (
                <button
                  key={source.id}
                  type="button"
                  onClick={() => onSelect(source.id)}
                  className="w-full rounded-xl border border-accent-honey/25 bg-accent-honey/5 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block text-secondary font-semibold text-foreground">
                    {source.title}
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-metadata text-muted-foreground">
                    {source.path ?? source.summary}
                  </span>
                </button>
              ))
            ) : (
              <p className="text-metadata text-muted-foreground">
                The retrieval pack is real, but none of its highlighted node IDs belong to the
                currently selected map.
              </p>
            )}
          </div>
        ) : null}
      </section>
    ) : (
      <ContextModeEmpty
        icon={<BrainCircuit className="h-6 w-6" />}
        title="JARVIS is not using Context"
        body="When a retrieval run supplies a validated pack, this tab shows its source count and highlights only the real nodes it used."
      />
    );
  } else {
    content = (
      <section className="rounded-2xl border border-border bg-paper p-4 shadow-soft">
        <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
          <Clock3 className="h-4 w-4 text-accent-copper" /> History
        </div>
        <dl className="space-y-2 text-secondary">
          <MetaRow label="Map created" value={formatDate(map?.createdAt)} />
          <MetaRow label="Map updated" value={formatDate(map?.updatedAt)} />
          <MetaRow label="Last indexed" value={formatDate(map?.lastIndexedAt)} />
          <MetaRow label="Generated" value={formatDate(tree.generatedAt)} />
          <MetaRow label="Model" value={tree.model} />
        </dl>
      </section>
    );
  }

  return (
    <aside
      data-monochrome-surface="context-inspector"
      data-sakura-surface="context-inspector"
      className={cn(
        'h-full min-h-0 overflow-hidden rounded-3xl border border-border bg-panel/90 shadow-soft backdrop-blur [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none',
        compact && 'bg-panel/95',
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className={cn('border-b border-border', compact ? 'p-2.5' : 'p-4')}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="eyebrow">{node.kind} node</div>
              <h2
                className={cn(
                  'mt-1 truncate font-display font-semibold text-foreground',
                  compact ? 'text-xl' : 'text-3xl',
                )}
              >
                {node.title}
              </h2>
              {node.path && (
                <p className="mt-1 truncate font-mono text-metadata text-accent-copper">
                  {node.path}
                </p>
              )}
            </div>
            <button
              type="button"
              draggable
              onDragStart={onDragStart}
              onMouseDown={(e) => {
                if (e.button === 2) {
                  e.stopPropagation();
                  startRightClickDrag(e, 'context', { node, tree });
                }
              }}
              className="group inline-flex shrink-0 items-center gap-2 rounded-2xl border border-accent-copper/35 bg-accent-copper/10 px-3 py-2 text-secondary text-accent-copper shadow-soft transition-all hover:-translate-y-0.5 hover:bg-accent-copper/15"
            >
              <Zap className="h-4 w-4 transition-transform group-hover:scale-110" /> Drag
            </button>
          </div>
        </header>

        <div
          className={cn(
            'grid gap-1 border-b border-border bg-paper-soft/70 p-2',
            compact ? 'grid-cols-4' : 'grid-cols-2',
          )}
          role="tablist"
          aria-label="Context inspector"
        >
          {CONTEXT_INSPECTOR_TABS.map((item) => {
            const Icon = tabIcons[item.id];
            return (
              <button
                key={item.id}
                id={`context-inspector-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                aria-controls="context-inspector-panel"
                data-context-tab-id={item.id}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => onTabChange(item.id)}
                onKeyDown={(event) =>
                  handleContextTabKeyDown(event, CONTEXT_INSPECTOR_TABS, tab, onTabChange)
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-metadata transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === item.id
                    ? 'bg-accent-copper/10 font-semibold text-accent-copper'
                    : 'text-muted-foreground hover:bg-paper hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </div>

        <div
          id="context-inspector-panel"
          role="tabpanel"
          aria-labelledby={`context-inspector-tab-${tab}`}
          className={cn(
            'min-h-0 flex-1 overflow-y-auto scrollbar-hidden',
            compact ? 'p-2.5' : 'p-4',
          )}
        >
          {content}
        </div>
      </div>
    </aside>
  );
}

function ContextInspectorNodeList({
  title,
  empty,
  nodes,
  onSelect,
}: {
  title: string;
  empty: string;
  nodes: readonly ContextTreeNode[];
  onSelect: (id: string) => void;
}) {
  return (
    <section className="rounded-2xl border border-border bg-paper p-4 shadow-soft">
      <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
        <Link2 className="h-4 w-4 text-accent-copper" /> {title}
      </div>
      {nodes.length ? (
        <div className="space-y-2">
          {nodes.slice(0, 100).map((linked) => (
            <button
              key={linked.id}
              type="button"
              onClick={() => onSelect(linked.id)}
              className="w-full rounded-xl border border-border bg-paper-soft p-3 text-left transition-colors hover:border-accent-copper/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block truncate text-secondary font-medium text-foreground">
                {linked.title}
              </span>
              <span className="mt-1 block line-clamp-2 text-metadata text-muted-foreground">
                {linked.path ?? linked.summary}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-secondary text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function contextNodeBacklinks(
  tree: ProjectContextTree,
  nodeId: string,
): readonly ContextTreeNode[] {
  const root = makeProjectRootNode(tree);
  const matches: ContextTreeNode[] = [];
  const visit = (candidate: ContextTreeNode) => {
    if (candidate.children?.some((child) => child.id === nodeId)) matches.push(candidate);
    candidate.children?.forEach(visit);
  };
  visit(root);
  return matches;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[82px_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function useContextDrag(tree: ProjectContextTree, node: ContextTreeNode) {
  return React.useCallback(
    (e: React.DragEvent) => {
      const attachment = nodeToAttachment(tree, node);
      const filePath =
        contextNodeFilePath(tree, node) || (node.kind === 'root' ? attachment.path : undefined);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData(CONTEXT_MIME, serializeContextAttachment(attachment));
      if (filePath) {
        e.dataTransfer.setData('text/plain', filePath);
        e.dataTransfer.setData('application/x-jarvis-file', filePath);
      } else {
        e.dataTransfer.setData('text/plain', formatContextAttachmentForTerminal(attachment));
      }
    },
    [node, tree],
  );
}

interface PositionedContextNode {
  id: string;
  title: string;
  kind: ContextTreeNode['kind'];
  x: number;
  y: number;
  r: number;
  depth: number;
  path?: string;
}

interface ContextMapEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  depth: number;
}

interface ContextMapLayout {
  nodes: PositionedContextNode[];
  edges: ContextMapEdge[];
  byId: Map<string, PositionedContextNode>;
  edgeById: Map<string, ContextMapEdge>;
}

interface MapView {
  x: number;
  y: number;
  width: number;
  height: number;
}

function buildContextMapRoot(rootNode: ContextTreeNode): ContextMapLayout {
  const node: PositionedContextNode = {
    id: rootNode.id,
    title: rootNode.title,
    kind: rootNode.kind,
    x: MAP_CENTER.x,
    y: MAP_CENTER.y,
    r: nodeRadius(rootNode, 0),
    depth: 0,
    path: rootNode.path,
  };
  return {
    nodes: [node],
    edges: [],
    byId: new Map([[node.id, node]]),
    edgeById: new Map(),
  };
}

async function buildContextMapCooperatively(
  rootNode: ContextTreeNode,
  signal: AbortSignal,
): Promise<ContextMapLayout> {
  const initial = buildContextMapRoot(rootNode);
  const nodes = [...initial.nodes];
  const byId = new Map(initial.byId);
  const edges: ContextMapEdge[] = [];
  const edgeById = new Map<string, ContextMapEdge>();
  interface ChildCursor {
    parent: ContextTreeNode;
    parentX: number;
    parentY: number;
    parentAngle: number;
    depth: number;
    index: number;
  }
  const queue: ChildCursor[] = rootNode.children?.length
    ? [
        {
          parent: rootNode,
          parentX: MAP_CENTER.x,
          parentY: MAP_CENTER.y,
          parentAngle: 0,
          depth: 1,
          index: 0,
        },
      ]
    : [];
  let cursor = 0;
  let workSinceYield = 0;
  while (cursor < queue.length) {
    if (signal.aborted) throw new Error('context_map_layout_aborted');
    const task = queue[cursor++]!;
    const children = task.parent.children ?? [];
    const child = children[task.index];
    if (!child || task.depth > 4) continue;
    if (
      nodes.length >= MAX_CONTEXT_MAP_LAYOUT_NODES ||
      edges.length >= MAX_CONTEXT_MAP_LAYOUT_EDGES
    ) {
      throw new Error('context_map_layout_limit');
    }
    let angle: number;
    let radius: number;
    if (task.depth === 1) {
      angle = -Math.PI / 2 + (Math.PI * 2 * task.index) / Math.max(1, children.length);
      radius = Math.max(960, Math.min(1680, 860 + children.length * 36));
    } else {
      const spread = task.depth === 2 ? Math.PI * 1.18 : Math.PI * 0.92;
      const ring = Math.floor(task.index / 14);
      const slot = task.index % 14;
      const slots = Math.min(children.length - ring * 14, 14);
      angle = task.parentAngle - spread / 2 + spread * ((slot + 0.5) / Math.max(1, slots));
      radius =
        Math.max(340, 610 - task.depth * 62) + Math.min(children.length, 24) * 9 + ring * 240;
    }
    const x = clampNumber(task.parentX + Math.cos(angle) * radius, 220, MAP_WIDTH - 220);
    const y = clampNumber(task.parentY + Math.sin(angle) * radius, 220, MAP_HEIGHT - 220);
    const positioned: PositionedContextNode = {
      id: child.id,
      title: child.title,
      kind: child.kind,
      x,
      y,
      r: nodeRadius(child, task.depth),
      depth: task.depth,
      path: child.path,
    };
    nodes.push(positioned);
    byId.set(positioned.id, positioned);
    const edge = {
      id: `${task.parent.id}-${child.id}`,
      from: task.parent.id,
      to: child.id,
      label: child.tags?.[0] ?? child.kind,
      depth: task.depth - 1,
    };
    edges.push(edge);
    edgeById.set(edge.id, edge);
    if (task.index + 1 < children.length) {
      queue.push({ ...task, index: task.index + 1 });
    }
    if (child.children?.length && task.depth < 4) {
      queue.push({
        parent: child,
        parentX: x,
        parentY: y,
        parentAngle: angle,
        depth: task.depth + 1,
        index: 0,
      });
    }
    workSinceYield += 1;
    if (workSinceYield >= 300) {
      workSinceYield = 0;
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  if (signal.aborted) throw new Error('context_map_layout_aborted');
  return { nodes, edges, byId, edgeById };
}

function buildContextMap(rootNode: ContextTreeNode): ContextMapLayout {
  const nodes: PositionedContextNode[] = [];
  const edges: ContextMapEdge[] = [];
  const pushNode = (node: ContextTreeNode, x: number, y: number, depth: number) => {
    nodes.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      x,
      y,
      r: nodeRadius(node, depth),
      depth,
      path: node.path,
    });
  };

  pushNode(rootNode, MAP_CENTER.x, MAP_CENTER.y, 0);
  const firstLevel = rootNode.children ?? [];
  const firstRadius = Math.max(960, Math.min(1680, 860 + firstLevel.length * 36));
  firstLevel.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, firstLevel.length);
    const x = MAP_CENTER.x + Math.cos(angle) * firstRadius;
    const y = MAP_CENTER.y + Math.sin(angle) * firstRadius;
    pushNode(node, x, y, 1);
    edges.push({
      id: `${rootNode.id}-${node.id}`,
      from: rootNode.id,
      to: node.id,
      label: node.tags?.[0] ?? node.kind,
      depth: 0,
    });
    placeChildren(node, x, y, angle, 2, pushNode, edges);
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { nodes, edges, byId, edgeById: new Map(edges.map((edge) => [edge.id, edge])) };
}

function placeChildren(
  parent: ContextTreeNode,
  parentX: number,
  parentY: number,
  parentAngle: number,
  depth: number,
  pushNode: (node: ContextTreeNode, x: number, y: number, depth: number) => void,
  edges: ContextMapEdge[],
) {
  const children = parent.children ?? [];
  if (children.length === 0 || depth > 4) return;
  const spread = depth === 2 ? Math.PI * 1.18 : Math.PI * 0.92;
  const baseRadius = Math.max(340, 610 - depth * 62) + Math.min(children.length, 24) * 9;
  children.forEach((child, index) => {
    const ring = Math.floor(index / 14);
    const slot = index % 14;
    const slots = Math.min(children.length - ring * 14, 14);
    const angle = parentAngle - spread / 2 + spread * ((slot + 0.5) / Math.max(1, slots));
    const radius = baseRadius + ring * 240;
    const x = clampNumber(parentX + Math.cos(angle) * radius, 220, MAP_WIDTH - 220);
    const y = clampNumber(parentY + Math.sin(angle) * radius, 220, MAP_HEIGHT - 220);
    pushNode(child, x, y, depth);
    edges.push({
      id: `${parent.id}-${child.id}`,
      from: parent.id,
      to: child.id,
      label: child.tags?.[0] ?? child.kind,
      depth: depth - 1,
    });
    placeChildren(child, x, y, angle, depth + 1, pushNode, edges);
  });
}

function nodeRadius(node: ContextTreeNode, depth: number): number {
  if (node.kind === 'root') return 104;
  if (node.kind === 'file') return 54;
  if (depth <= 1) return 78;
  return 62;
}

function edgePath(from: PositionedContextNode, to: PositionedContextNode): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const curve = Math.min(155, distance * 0.18);
  const cx = (from.x + to.x) / 2 - (dy / distance) * curve;
  const cy = (from.y + to.y) / 2 + (dx / distance) * curve;
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
}

function edgeLabelPoint(
  from: PositionedContextNode,
  to: PositionedContextNode,
): { x: number; y: number } {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

function makeProjectRootNode(tree: ProjectContextTree): ContextTreeNode {
  return {
    id: PROJECT_ROOT_NODE_ID,
    title: rootTitle(tree.rootDir),
    kind: 'root',
    summary: tree.summary,
    path: tree.rootDir,
    tags: ['project', 'context-map'],
    importance: 5,
    sizeBytes: tree.totalBytes,
    createdAt: tree.generatedAt,
    modifiedAt: tree.generatedAt,
    children: tree.nodes,
  };
}

function getProviderChoices(apiKeys: ProviderKeys): ContextGenerationProvider[] {
  const configured = CLOUD_CONTEXT_PROVIDERS.filter((id) => Boolean(apiKeys[id]?.trim()));
  return ['local', ...configured];
}

function pickDefaultProvider(
  choices: ContextGenerationProvider[],
  defaultProvider: ProviderId,
): ContextGenerationProvider {
  if (choices.includes(defaultProvider as ContextGenerationProvider))
    return defaultProvider as ContextGenerationProvider;
  const firstCloud = choices.find((choice) => choice !== 'local');
  return firstCloud ?? 'local';
}

function centeredView(width: number, height: number): MapView {
  return clampView({ x: MAP_CENTER.x - width / 2, y: MAP_CENTER.y - height / 2, width, height });
}

function clampView(view: MapView): MapView {
  const width = Math.max(650, Math.min(MAP_WIDTH, view.width));
  const height = Math.max(430, Math.min(MAP_HEIGHT, view.height));
  return {
    x: clampNumber(view.x, 0, MAP_WIDTH - width),
    y: clampNumber(view.y, 0, MAP_HEIGHT - height),
    width,
    height,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDate(value: number | undefined): string {
  return typeof value === 'number' ? formatUserDateTime(value) : '-';
}

function rootTitle(rootDir: string): string {
  const normalized = rootDir.replace(/[\\/]$/g, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || 'Project Context';
}

function parentDirectory(path: string): string {
  const normalized = path.trim().replace(/[\\/]$/g, '');
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : normalized;
}

function splitLabel(label: string, maxChars: number): string[] {
  const clean = label.trim();
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === 2) break;
  }
  if (current && lines.length < 2) lines.push(current);
  const out = lines
    .slice(0, 2)
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}...` : line));
  return out.length ? out : [`${clean.slice(0, maxChars - 1)}...`];
}

function shortModel(model: string): string {
  if (model.includes('google') || model.includes('gemini')) return 'Gemini';
  if (model.includes('groq') || model.includes('llama')) return 'Groq';
  if (model.includes('openai') || model.includes('gpt')) return 'OpenAI';
  if (model.includes('anthropic') || model.includes('claude')) return 'Claude';
  if (model.includes('fallback')) return 'Local';
  return model;
}

export default ContextPage;
