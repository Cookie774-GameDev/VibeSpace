import * as React from 'react';
import {
  BrainCircuit,
  ChevronRight,
  CircleDot,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  LocateFixed,
  Layers3,
  MousePointer2,
  Move,
  Network,
  RefreshCw,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button, Input, toast } from '@/components/ui';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { cn } from '@/lib/utils';
import { notifyDone } from '@/lib/notifications';
import type { ProviderId } from '@/types';
import {
  basename,
  chooseProjectFolder,
  getStoredProjectRoot,
  setStoredProjectRoot,
} from '@/features/files/projectFiles';
import { startRightClickDrag } from '@/lib/rightClickDrag';
import {
  CONTEXT_MIME,
  MAX_ACTIVE_CONTEXT_MAPS,
  CONTEXT_PROVIDER_OPTIONS,
  contextMapFilePath,
  contextNodeFilePath,
  deleteStoredContextMap,
  findContextFileNodeByPath,
  findContextNode,
  flattenContextNodes,
  formatContextAttachmentForTerminal,
  generateProjectContextTree,
  getStoredContextSelectedFile,
  loadSelectedContextMap,
  loadStoredContextMaps,
  nodeToAttachment,
  selectStoredContextMap,
  serializeContextAttachment,
  type ContextMapRecord,
  type ContextGenerationProvider,
  type ContextTreeNode,
  type ProjectContextTree,
} from './tree';

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
const DEFAULT_VIEW = centeredView(3000, 2100);

type ProviderKeys = Partial<Record<ProviderId, string>>;

export function ContextPage() {
  const projectId = useAuthStore((s) => s.projectId);
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const setRoute = useUIStore((s) => s.setRoute);
  const [rootDraft, setRootDraft] = React.useState(() => getStoredProjectRoot(projectId));
  const [maps, setMaps] = React.useState<ContextMapRecord[]>(() => loadStoredContextMaps(projectId));
  const [selectedMapId, setSelectedMapId] = React.useState<string | null>(() => loadSelectedContextMap(projectId)?.id ?? null);
  const [selectedId, setSelectedId] = React.useState<string | null>(() => loadSelectedContextMap(projectId) ? PROJECT_ROOT_NODE_ID : null);
  const [provider, setProvider] = React.useState<ContextGenerationProvider>('local');
  const [generating, setGenerating] = React.useState(false);
  const [mapFlash, setMapFlash] = React.useState(false);
  const [status, setStatus] = React.useState('Ready.');

  const providerChoices = React.useMemo(() => getProviderChoices(apiKeys), [apiKeys]);
  const providerChoiceKey = providerChoices.join('|');

  React.useEffect(() => {
    setProvider((current) => {
      if (providerChoices.includes(current)) return current;
      return pickDefaultProvider(providerChoices, defaultProvider);
    });
  }, [defaultProvider, providerChoiceKey, providerChoices]);

  React.useEffect(() => {
    setRootDraft(getStoredProjectRoot(projectId));
    const nextMaps = loadStoredContextMaps(projectId);
    const nextSelected = loadSelectedContextMap(projectId);
    setMaps(nextMaps);
    setSelectedMapId(nextSelected?.id ?? null);
    setSelectedId(nextSelected ? PROJECT_ROOT_NODE_ID : null);
  }, [projectId]);

  React.useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; mapId?: string | null }>).detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      const nextMaps = loadStoredContextMaps(projectId);
      const nextSelected = detail?.mapId
        ? nextMaps.find((map) => map.id === detail.mapId) ?? loadSelectedContextMap(projectId)
        : loadSelectedContextMap(projectId);
      setMaps(nextMaps);
      setSelectedMapId(nextSelected?.id ?? null);
      setSelectedId((cur) => cur ?? (nextSelected ? PROJECT_ROOT_NODE_ID : null));
    };
    window.addEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
    return () => window.removeEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
  }, [projectId]);

  const selectedMap = React.useMemo(() => (
    maps.find((map) => map.id === selectedMapId)
    ?? maps.find((map) => map.status === 'active')
    ?? maps[0]
    ?? null
  ), [maps, selectedMapId]);
  const tree = selectedMap?.tree ?? null;
  const activeMapCount = React.useMemo(() => maps.filter((map) => map.status === 'active').length, [maps]);
  const lastAppliedFileRef = React.useRef('');

  const selectFilePath = React.useCallback((path: string, notify = true): boolean => {
    const clean = path.trim();
    if (!clean) return false;
    const targetMap = maps.find((map) => findContextFileNodeByPath(map.tree, clean));
    const targetNode = targetMap ? findContextFileNodeByPath(targetMap.tree, clean) : null;
    if (!targetMap || !targetNode) {
      if (notify) toast.info('File not found in Context maps', clean);
      return false;
    }
    if (targetMap.id !== selectedMapId) {
      selectStoredContextMap(projectId, targetMap.id);
      setMaps(loadStoredContextMaps(projectId));
      setSelectedMapId(targetMap.id);
    }
    setSelectedId(targetNode.id);
    setStatus(`Selected ${basename(clean)} in ${targetMap.name}.`);
    return true;
  }, [maps, projectId, selectedMapId]);

  React.useEffect(() => {
    const stored = getStoredContextSelectedFile(projectId);
    if (!stored || stored === lastAppliedFileRef.current) return;
    if (selectFilePath(stored, false)) lastAppliedFileRef.current = stored;
  }, [projectId, selectFilePath]);

  React.useEffect(() => {
    const onSelectFile = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if (!detail?.path) return;
      if ((detail.projectId ?? null) !== (projectId ?? null)) return;
      if (selectFilePath(detail.path)) lastAppliedFileRef.current = detail.path;
    };
    window.addEventListener('jarvis:context:select-file', onSelectFile as EventListener);
    return () => window.removeEventListener('jarvis:context:select-file', onSelectFile as EventListener);
  }, [projectId, selectFilePath]);

  const rootNode = React.useMemo(() => tree ? makeProjectRootNode(tree) : null, [tree]);
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

  const selectedProvider = providerChoices.includes(provider) ? provider : providerChoices[0] ?? 'local';
  const selectedProviderMeta = CONTEXT_PROVIDER_OPTIONS[selectedProvider];

  const selectMap = React.useCallback((mapId: string) => {
    const record = selectStoredContextMap(projectId, mapId);
    if (!record) return;
    setMaps(loadStoredContextMaps(projectId));
    setSelectedMapId(record.id);
    setSelectedId(PROJECT_ROOT_NODE_ID);
  }, [projectId]);

  const deleteMap = React.useCallback((mapId: string) => {
    const record = maps.find((map) => map.id === mapId);
    if (!record || record.status === 'deleted') return;
    const confirmed = window.confirm(`Do you confirm to delete the context map '${record.name}'?`);
    if (!confirmed) return;
    const deleted = deleteStoredContextMap(projectId, mapId);
    if (!deleted) return;
    setMaps(loadStoredContextMaps(projectId));
    setSelectedMapId(deleted.id);
    setSelectedId(PROJECT_ROOT_NODE_ID);
    toast.info('Context map tagged Deleted', deleted.name);
  }, [maps, projectId]);

  const openFolderPicker = async () => {
    const picked = await chooseProjectFolder();
    if (!picked) {
      toast.info('Use the path field', 'Native folder picking is available in the desktop app.');
      return;
    }
    setRootDraft(picked);
    setStoredProjectRoot(projectId, picked);
  };

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
      toast.warning('Active Context map limit reached', `Delete an active map first. Jarvis keeps up to ${MAX_ACTIVE_CONTEXT_MAPS} active maps per project.`);
      return;
    }

    const activeProvider = providerChoices.includes(provider) ? provider : providerChoices[0] ?? 'local';
    const apiKey = activeProvider === 'local' ? undefined : apiKeys[activeProvider]?.trim();
    if (activeProvider !== 'local' && !apiKey) {
      toast.warning('Provider key missing', `Add a ${CONTEXT_PROVIDER_OPTIONS[activeProvider].label} key first.`);
      return;
    }

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
      });
      const nextMaps = loadStoredContextMaps(projectId);
      const nextSelected = loadSelectedContextMap(projectId);
      setMaps(nextMaps);
      setSelectedMapId(nextSelected?.id ?? null);
      setSelectedId(PROJECT_ROOT_NODE_ID);
      setMapFlash(true);
      window.setTimeout(() => setMapFlash(false), 1250);
      toast.success('Context map ready', `${generated.fileCount} files mapped with ${shortModel(generated.model)}.`);
      void notifyDone('contextMaps', 'Context map ready', `${generated.fileCount} files mapped with ${shortModel(generated.model)}.`);
    } catch (err) {
      toast.error('Context map creation failed', err instanceof Error ? err.message : 'Unknown error');
      setStatus('Generation failed.');
    } finally {
      setGenerating(false);
    }
  }, [activeMapCount, apiKeys, projectId, provider, providerChoices, rootDraft]);

  React.useEffect(() => {
    const onCreateMap = () => void makeSkillTree();
    window.addEventListener('jarvis:context:create-map', onCreateMap);
    return () => window.removeEventListener('jarvis:context:create-map', onCreateMap);
  }, [makeSkillTree]);

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <div className="absolute left-[-12rem] top-[-12rem] h-[32rem] w-[32rem] rounded-full bg-accent-copper/10 blur-3xl" />
        <div className="absolute bottom-[-16rem] right-[-14rem] h-[34rem] w-[34rem] rounded-full bg-accent-honey/10 blur-3xl" />
      </div>

      <aside className="relative z-10 flex w-[340px] shrink-0 flex-col border-r border-border bg-panel/85 backdrop-blur xl:w-[400px]">
        <div className="space-y-3 border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-accent-copper/30 bg-accent-copper/10 px-2 py-1 text-metadata uppercase tracking-wide text-accent-copper">
                <BrainCircuit className="h-3.5 w-3.5" /> Context
              </div>
              <h1 className="mt-2 font-display text-2xl font-semibold text-foreground">Project Context Map</h1>
              <p className="text-secondary text-muted-foreground">
                Create a cozy draggable map for every AI chat and terminal.
              </p>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setRoute('files')} aria-label="Open Files page">
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-paper-soft p-2.5 shadow-soft">
            <div className="flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
              <FolderOpen className="h-3.5 w-3.5 text-accent-honey" /> Project folder
            </div>
            <div className="flex gap-1.5">
              <Input
                value={rootDraft}
                onChange={(e) => setRootDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') rememberRoot(); }}
                placeholder="C:\\Users\\you\\project or /home/you/project"
                className="font-mono text-metadata"
              />
              <Button size="sm" variant="secondary" onClick={() => void openFolderPicker()}>Choose</Button>
            </div>
            <label className="block space-y-1">
              <span className="text-metadata uppercase tracking-wide text-muted-foreground">Map model provider</span>
              <select
                value={selectedProvider}
                onChange={(e) => setProvider(e.target.value as ContextGenerationProvider)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-metadata text-foreground shadow-soft outline-none transition-colors focus:border-accent-copper focus:ring-1 focus:ring-ring"
              >
                {providerChoices.map((choice) => (
                  <option key={choice} value={choice}>
                    {CONTEXT_PROVIDER_OPTIONS[choice].label} - {CONTEXT_PROVIDER_OPTIONS[choice].model}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={rememberRoot} disabled={!rootDraft.trim()}>
                Save Root
              </Button>
              <Button
                size="sm"
                variant="accent"
                onClick={() => void makeSkillTree()}
                disabled={generating || !rootDraft.trim()}
                className="ml-auto gap-1"
              >
                {generating ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Create Map
              </Button>
            </div>
            <p className="text-metadata text-muted-foreground">
              {selectedProvider === 'local'
                ? 'Local fallback is available. Saved cloud keys appear here automatically.'
                : `${selectedProviderMeta.label} key detected. Jarvis will send sampled project files to ${selectedProviderMeta.shortLabel}.`}
            </p>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Stat label="Files" value={tree ? String(tree.fileCount) : '-'} />
            <Stat label="Nodes" value={tree ? String(flatNodes.length + 1) : '-'} />
            <Stat label="Model" value={tree ? shortModel(tree.model) : selectedProviderMeta.shortLabel} />
          </div>
          <ContextMapList
            maps={maps}
            selectedMapId={selectedMap?.id ?? null}
            activeMapCount={activeMapCount}
            onSelect={selectMap}
            onDelete={deleteMap}
          />
          <p className="min-h-4 text-metadata text-muted-foreground">{status}</p>

          {tree && selected ? (
            <SelectedContextCard tree={tree} node={selected} onSelectRoot={() => setSelectedId(PROJECT_ROOT_NODE_ID)} />
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

      <main className="relative z-10 flex min-w-0 flex-1 flex-col p-4">
        {!tree || !rootNode || !selected ? (
          <NoContextHero onGenerate={() => void makeSkillTree()} disabled={generating || !rootDraft.trim()} />
        ) : (
          <ContextMapWorkspace
            tree={tree}
            rootNode={rootNode}
            selected={selected}
            selectedId={selected.id}
            onSelect={setSelectedId}
            flash={mapFlash}
          />
        )}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-paper px-2.5 py-2 shadow-soft">
      <div className="text-metadata uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-sm text-foreground">{value}</div>
    </div>
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
                selected ? 'border-accent-copper/45 bg-accent-copper/10 shadow-soft' : 'border-transparent hover:border-border hover:bg-paper',
                deleted && 'opacity-70',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(map.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-secondary font-medium text-foreground">{map.name}</span>
                  <span className="block truncate font-mono text-metadata text-muted-foreground">
                    {map.tree.fileCount} files - {mapFilePath}
                  </span>
                </span>
                <span className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  deleted
                    ? 'border-muted-foreground/25 bg-muted text-muted-foreground'
                    : 'border-accent-copper/35 bg-accent-copper/10 text-accent-copper',
                )}>
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

function NoContextHero({ onGenerate, disabled }: { onGenerate: () => void; disabled: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="relative max-w-2xl rounded-3xl border border-accent-copper/25 bg-panel/90 p-8 shadow-[0_24px_80px_hsl(var(--accent-copper)/0.16)] backdrop-blur">
        <div className="absolute inset-0 rounded-3xl bg-[radial-gradient(circle_at_30%_20%,hsl(var(--accent-copper)/0.18),transparent_34%),radial-gradient(circle_at_80%_80%,hsl(var(--accent-amber)/0.14),transparent_32%)]" />
        <div className="relative space-y-5">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-accent-copper/40 bg-accent-copper/15 text-accent-copper shadow-soft">
            <Network className="h-7 w-7" />
          </div>
          <div>
            <div className="eyebrow">Context power layer</div>
            <h2 className="mt-2 font-display text-4xl font-semibold leading-tight text-foreground">
              Turn this project into an interactive AI context map.
            </h2>
          </div>
          <p className="text-body text-muted-foreground">
            Jarvis scans the project, uses your selected saved provider key when available, and builds a warm string map that every AI prompt can use before deciding which files matter.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <FeaturePill icon={<GitBranch className="h-4 w-4" />} text="String map" />
            <FeaturePill icon={<MousePointer2 className="h-4 w-4" />} text="Left-click inspect" />
            <FeaturePill icon={<Move className="h-4 w-4" />} text="Right-click pan" />
          </div>
          <Button variant="accent" size="lg" onClick={onGenerate} disabled={disabled} className="gap-2">
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
        <Button size="sm" variant="ghost" onClick={onSelectRoot}>Root</Button>
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
          {node.kind === 'file' ? <FileText className="h-4 w-4 shrink-0 text-accent-honey" /> : <Network className="h-4 w-4 shrink-0 text-accent-copper" />}
          <span className="min-w-0 flex-1 truncate text-secondary text-foreground">{node.title}</span>
          {node.importance && <span className="text-metadata text-muted-foreground">{node.importance}</span>}
        </button>
      </div>
      {open && hasChildren && node.children!.map((child) => (
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
  tree,
  rootNode,
  selected,
  selectedId,
  onSelect,
  flash,
}: {
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  selected: ContextTreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
  flash: boolean;
}) {
  return (
    <div className="grid h-full min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <section
        className="relative min-h-0 overflow-hidden rounded-3xl border border-border bg-panel/80 shadow-soft backdrop-blur"
        data-jarvis-suppress-context-menu
      >
        <div className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-paper/90 p-2 shadow-soft backdrop-blur">
          <div className="flex items-center gap-2 px-2 text-metadata text-muted-foreground">
            <Move className="h-3.5 w-3.5 text-accent-copper" /> Right-click drag
          </div>
          <div className="flex items-center gap-2 px-2 text-metadata text-muted-foreground">
            <MousePointer2 className="h-3.5 w-3.5 text-accent-honey" /> Left-click nodes or strings
          </div>
        </div>
        <ContextMapCanvas tree={tree} rootNode={rootNode} selectedId={selectedId} onSelect={onSelect} flash={flash} />
      </section>
      <ContextInspector tree={tree} node={selected} onSelect={onSelect} />
    </div>
  );
}

function ContextMapCanvas({
  tree,
  rootNode,
  selectedId,
  onSelect,
  flash,
}: {
  tree: ProjectContextTree;
  rootNode: ContextTreeNode;
  selectedId: string;
  onSelect: (id: string) => void;
  flash: boolean;
}) {
  const map = React.useMemo(() => buildContextMap(rootNode), [rootNode]);
  const [view, setView] = React.useState(DEFAULT_VIEW);
  const [panning, setPanning] = React.useState(false);
  const dragRef = React.useRef<{ pointerId: number; startX: number; startY: number; startView: MapView } | null>(null);

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
    setView(clampView({
      ...drag.startView,
      x: drag.startView.x - (event.clientX - drag.startX) * scaleX,
      y: drag.startView.y - (event.clientY - drag.startY) * scaleY,
    }));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setPanning(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

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
    setView(clampView({
      x: worldX - px * nextWidth,
      y: worldY - py * nextHeight,
      width: nextWidth,
      height: nextHeight,
    }));
  };

  return (
    <div
      className={cn('relative h-full w-full select-none overflow-hidden', panning ? 'cursor-grabbing' : 'cursor-default')}
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
      <svg
        className="h-full w-full"
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        role="img"
        aria-label="Interactive Jarvis Context map"
      >
        <defs>
          <filter id="context-node-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feDropShadow dx="0" dy="8" stdDeviation="10" floodColor="hsl(var(--accent-copper))" floodOpacity="0.18" />
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
            <path d="M 90 0 L 0 0 0 90" fill="none" stroke="hsl(var(--border) / 0.22)" strokeWidth="1" />
          </pattern>
        </defs>
        <rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} fill="hsl(var(--background) / 0.74)" />
        <rect x="0" y="0" width={MAP_WIDTH} height={MAP_HEIGHT} fill="url(#context-grid)" />
        <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="1680" fill="hsl(var(--accent-copper) / 0.05)" />
        <circle cx={MAP_CENTER.x} cy={MAP_CENTER.y} r="1160" fill="none" stroke="hsl(var(--accent-amber) / 0.16)" strokeDasharray="18 22" strokeWidth="3" />

        {map.edges.map((edge) => {
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
                stroke={active ? 'hsl(var(--accent-amber) / 0.9)' : 'hsl(var(--muted-foreground) / 0.42)'}
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

        {map.nodes.map((node) => (
          <MapNodeView key={node.id} tree={tree} node={node} active={selectedId === node.id} onSelect={onSelect} />
        ))}
      </svg>
      {flash ? <div className="context-map-birth pointer-events-none absolute inset-0 z-30" /> : null}
    </div>
  );
}

function MapNodeView({
  tree,
  node,
  active,
  onSelect,
}: {
  tree: ProjectContextTree;
  node: PositionedContextNode;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const lines = splitLabel(node.title, node.kind === 'file' ? 15 : 18);
  const fill = node.kind === 'root' ? 'url(#context-root-fill)' : node.kind === 'file' ? 'url(#context-file-fill)' : 'hsl(var(--paper-soft))';
  const stroke = active ? 'hsl(var(--accent-amber))' : node.kind === 'file' ? 'hsl(var(--accent-amber) / 0.68)' : 'hsl(var(--accent-copper) / 0.62)';
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
      {active ? <circle r={node.r + 12} fill="none" stroke="hsl(var(--accent-amber) / 0.42)" strokeWidth="8" /> : null}
      <circle r={node.r} fill={fill} stroke={stroke} strokeWidth={active ? 5 : 3} />
      <circle cx={-node.r * 0.32} cy={-node.r * 0.32} r={Math.max(8, node.r * 0.12)} fill="hsl(var(--cream) / 0.22)" />
      <text textAnchor="middle" className="pointer-events-none fill-foreground font-sans text-[24px] font-semibold">
        {lines.map((line, index) => (
          <tspan key={line + index} x="0" dy={index === 0 ? (lines.length === 1 ? '0.32em' : '-0.08em') : '1.08em'}>
            {line}
          </tspan>
        ))}
      </text>
      <text y={node.r + 28} textAnchor="middle" className="pointer-events-none fill-muted-foreground font-mono text-[19px] uppercase tracking-[0.2em]">
        {node.kind}
      </text>
    </g>
  );
}

function ContextInspector({
  tree,
  node,
  onSelect,
}: {
  tree: ProjectContextTree;
  node: ContextTreeNode;
  onSelect: (id: string) => void;
}) {
  const onDragStart = useContextDrag(tree, node);
  return (
    <aside className="min-h-0 overflow-hidden rounded-3xl border border-border bg-panel/90 shadow-soft backdrop-blur">
      <div className="flex h-full min-h-0 flex-col">
        <header className="border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="eyebrow">{node.kind} node</div>
              <h2 className="mt-1 truncate font-display text-3xl font-semibold text-foreground">{node.title}</h2>
              {node.path && <p className="mt-1 truncate font-mono text-metadata text-accent-copper">{node.path}</p>}
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

        <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-hidden">
          <section className="rounded-2xl border border-border bg-paper p-4 shadow-soft">
            <div className="mb-2 flex items-center gap-2 text-ui-strong text-foreground">
              <Sparkles className="h-4 w-4 text-accent-copper" /> Summary
            </div>
            <p className="whitespace-pre-wrap text-body leading-relaxed text-muted-foreground">{node.summary}</p>
          </section>

          <section className="mt-3 rounded-2xl border border-border bg-paper-soft p-4 shadow-soft">
            <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
              <Database className="h-4 w-4 text-accent-honey" /> Context Metadata
            </div>
            <dl className="space-y-2 text-secondary">
              <MetaRow label="Size" value={formatBytes(node.sizeBytes)} />
              <MetaRow label="Created" value={formatDate(node.createdAt)} />
              <MetaRow label="Modified" value={formatDate(node.modifiedAt)} />
              <MetaRow label="Generated" value={new Date(tree.generatedAt).toLocaleString()} />
              <MetaRow label="Model" value={tree.model} />
              <MetaRow label="Children" value={String(node.children?.length ?? 0)} />
            </dl>
            {node.tags?.length ? (
              <div className="mt-4 flex flex-wrap gap-1.5">
                {node.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-border bg-paper px-2 py-0.5 text-metadata text-muted-foreground">{tag}</span>
                ))}
              </div>
            ) : null}
          </section>

          {node.children?.length ? (
            <section className="mt-3 rounded-2xl border border-border bg-paper p-4 shadow-soft">
              <div className="mb-3 flex items-center gap-2 text-ui-strong text-foreground">
                <GitBranch className="h-4 w-4 text-accent-copper" /> Linked branches
              </div>
              <div className="space-y-2">
                {node.children.slice(0, 18).map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => onSelect(child.id)}
                    className="w-full rounded-xl border border-border bg-paper-soft p-3 text-left transition-all hover:-translate-y-0.5 hover:border-accent-copper/40 hover:shadow-soft"
                  >
                    <div className="flex items-center gap-2">
                      {child.kind === 'file' ? <FileText className="h-3.5 w-3.5 text-accent-honey" /> : <CircleDot className="h-3.5 w-3.5 text-accent-copper" />}
                      <div className="min-w-0 flex-1 truncate text-secondary font-medium text-foreground">{child.title}</div>
                      <div className="text-metadata text-muted-foreground">{formatBytes(child.sizeBytes)}</div>
                    </div>
                    <p className="mt-1 line-clamp-2 text-metadata text-muted-foreground">{child.summary}</p>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[82px_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-foreground" title={value}>{value}</dd>
    </div>
  );
}

function useContextDrag(tree: ProjectContextTree, node: ContextTreeNode) {
  return React.useCallback((e: React.DragEvent) => {
    const attachment = nodeToAttachment(tree, node);
    const filePath = contextNodeFilePath(tree, node) || (node.kind === 'root' ? attachment.path : undefined);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(CONTEXT_MIME, serializeContextAttachment(attachment));
    if (filePath) {
      e.dataTransfer.setData('text/plain', filePath);
      e.dataTransfer.setData('application/x-jarvis-file', filePath);
    } else {
      e.dataTransfer.setData('text/plain', formatContextAttachmentForTerminal(attachment));
    }
  }, [node, tree]);
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
}

interface MapView {
  x: number;
  y: number;
  width: number;
  height: number;
}

function buildContextMap(rootNode: ContextTreeNode): ContextMapLayout {
  const nodes: PositionedContextNode[] = [];
  const edges: ContextMapEdge[] = [];
  const pushNode = (node: ContextTreeNode, x: number, y: number, depth: number) => {
    nodes.push({ id: node.id, title: node.title, kind: node.kind, x, y, r: nodeRadius(node, depth), depth, path: node.path });
  };

  pushNode(rootNode, MAP_CENTER.x, MAP_CENTER.y, 0);
  const firstLevel = rootNode.children ?? [];
  const firstRadius = Math.max(960, Math.min(1680, 860 + firstLevel.length * 36));
  firstLevel.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(1, firstLevel.length);
    const x = MAP_CENTER.x + Math.cos(angle) * firstRadius;
    const y = MAP_CENTER.y + Math.sin(angle) * firstRadius;
    pushNode(node, x, y, 1);
    edges.push({ id: `${rootNode.id}-${node.id}`, from: rootNode.id, to: node.id, label: node.tags?.[0] ?? node.kind, depth: 0 });
    placeChildren(node, x, y, angle, 2, pushNode, edges);
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  return { nodes, edges, byId };
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
    edges.push({ id: `${parent.id}-${child.id}`, from: parent.id, to: child.id, label: child.tags?.[0] ?? child.kind, depth: depth - 1 });
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

function edgeLabelPoint(from: PositionedContextNode, to: PositionedContextNode): { x: number; y: number } {
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

function pickDefaultProvider(choices: ContextGenerationProvider[], defaultProvider: ProviderId): ContextGenerationProvider {
  if (choices.includes(defaultProvider as ContextGenerationProvider)) return defaultProvider as ContextGenerationProvider;
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
  return typeof value === 'number' ? new Date(value).toLocaleString() : '-';
}

function rootTitle(rootDir: string): string {
  const normalized = rootDir.replace(/[\\/]$/g, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || 'Project Context';
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
  const out = lines.slice(0, 2).map((line) => line.length > maxChars ? `${line.slice(0, maxChars - 1)}...` : line);
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
