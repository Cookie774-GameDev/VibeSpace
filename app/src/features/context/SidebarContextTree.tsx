import * as React from 'react';
import { ChevronRight, FileText, Layers3, Network, Sparkles, Zap } from 'lucide-react';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import { startRightClickDrag } from '@/lib/rightClickDrag';
import {
  CONTEXT_MIME,
  MAX_ACTIVE_CONTEXT_MAPS,
  contextMapBackingFilePath,
  contextNodeFilePath,
  nodeToAttachment,
  serializeContextAttachment,
  formatContextAttachmentForTerminal,
  type ContextMapRecord,
  type ContextTreeNode,
  type ProjectContextTree,
} from './tree';
import {
  ensureContextPersistence,
  getActiveContextPersistenceState,
  selectPersistedContextFile,
  selectPersistedContextMap,
} from './contextPersistence';
import { requestContextNavigation } from './contextNavigation';

interface SidebarContextTreeProps {
  navOpen: boolean;
  onOpenContext: () => void;
}

export function SidebarContextTree({ navOpen, onOpenContext }: SidebarContextTreeProps) {
  const projectId = useAuthStore((s) => s.projectId);
  const accountId = useAuthStore((s) => resolveAccountIdentity(s)?.accountId ?? null);
  const [maps, setMaps] = React.useState<ContextMapRecord[]>([]);
  const [selectedMapId, setSelectedMapId] = React.useState<string | null>(null);

  const refreshMaps = React.useCallback(() => {
    const state = getActiveContextPersistenceState(projectId);
    setMaps(state ? [...state.maps] : []);
    setSelectedMapId(state?.selectedMapId ?? null);
  }, [projectId]);

  React.useEffect(() => {
    if (!accountId) {
      setMaps([]);
      setSelectedMapId(null);
      return;
    }
    let active = true;
    void ensureContextPersistence(projectId)
      .then(() => {
        if (active) refreshMaps();
      })
      .catch(() => {
        if (active) {
          setMaps([]);
          setSelectedMapId(null);
        }
      });
    return () => {
      active = false;
    };
  }, [accountId, refreshMaps]);

  React.useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; mapId?: string | null }>)
        .detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      refreshMaps();
    };
    window.addEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
    return () =>
      window.removeEventListener('jarvis:context-tree-updated', onUpdated as EventListener);
  }, [projectId, refreshMaps]);

  const selectMap = React.useCallback(
    (mapId: string) => {
      void selectPersistedContextMap(projectId, mapId)
        .then((state) => {
          const auth = useAuthStore.getState();
          if (
            resolveAccountIdentity(auth)?.accountId !== state.accountId ||
            (auth.projectId ?? null) !== state.projectId
          ) {
            return;
          }
          refreshMaps();
          onOpenContext();
          requestContextNavigation({ target: 'map', mapId });
        })
        .catch((error) =>
          toast.error(
            'Could not select Context map',
            error instanceof Error ? error.message : 'Unknown persistence error',
          ),
        );
    },
    [onOpenContext, projectId, refreshMaps],
  );

  const openOverview = React.useCallback(() => {
    onOpenContext();
    requestContextNavigation({ target: 'overview' });
  }, [onOpenContext]);

  if (!navOpen) return null;

  if (maps.length === 0) {
    return (
      <button
        type="button"
        onClick={openOverview}
        className="mx-1 rounded-lg border border-dashed border-border bg-paper-soft px-2 py-2 text-left text-metadata text-muted-foreground transition-colors hover:border-accent-copper/50 hover:text-foreground"
      >
        <span className="mb-1 flex items-center gap-1.5 text-accent-copper">
          <Sparkles className="h-3.5 w-3.5" /> Make Context map
        </span>
        Build up to {MAX_ACTIVE_CONTEXT_MAPS} active project maps for AI prompts.
      </button>
    );
  }

  const activeCount = maps.filter((map) => map.status === 'active').length;

  return (
    <div className="space-y-1 px-1">
      <button
        type="button"
        onClick={openOverview}
        className="flex w-full items-center gap-2 rounded-md bg-accent-copper/10 px-2 py-1.5 text-left text-metadata text-accent-copper transition-colors hover:bg-accent-copper/15"
      >
        <Zap className="h-3.5 w-3.5" />
        <span className="min-w-0 flex-1 truncate">
          {activeCount}/{MAX_ACTIVE_CONTEXT_MAPS} active maps
        </span>
      </button>
      {maps.slice(0, 8).map((map) => (
        <SidebarContextMap
          key={map.id}
          map={map}
          selected={map.id === selectedMapId}
          onSelectMap={selectMap}
          onOpenContext={onOpenContext}
        />
      ))}
    </div>
  );
}

function SidebarContextMap({
  map,
  selected,
  onSelectMap,
  onOpenContext,
}: {
  map: ContextMapRecord;
  selected: boolean;
  onSelectMap: (mapId: string) => void;
  onOpenContext: () => void;
}) {
  const [open, setOpen] = React.useState(selected && map.status === 'active');
  const deleted = map.status === 'deleted';
  const hasChildren = map.tree.nodes.length > 0;
  const mapFilePath = contextMapBackingFilePath(map);
  const mapLocation = mapFilePath ?? `${map.name} · Stored internally · Source ${map.rootDir}`;

  React.useEffect(() => {
    if (selected && !deleted) setOpen(true);
  }, [deleted, selected]);

  return (
    <div>
      <div
        className={cn(
          'group flex h-8 w-full items-center gap-1.5 rounded-md pr-1 text-secondary transition-colors hover:bg-muted focus-within:ring-1 focus-within:ring-ring',
          selected && 'bg-muted ring-inset ring-1 ring-accent-copper/40',
          deleted && 'opacity-70',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((cur) => !cur);
            }}
            className="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-paper-soft hover:text-foreground focus-visible:outline-none"
            aria-label={open ? 'Collapse Context map' : 'Expand Context map'}
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="ml-1 h-5 w-5 shrink-0" />
        )}
        <button
          type="button"
          draggable={!deleted && Boolean(mapFilePath)}
          onDragStart={(event) => {
            if (deleted || !mapFilePath) return;
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-jarvis-file', mapFilePath);
            event.dataTransfer.setData('text/plain', mapFilePath);
          }}
          onMouseDown={(event) => {
            if (event.button === 2 && !deleted && mapFilePath) {
              event.stopPropagation();
              startRightClickDrag(event, 'file', { path: mapFilePath });
            }
          }}
          onClick={() => onSelectMap(map.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
          title={mapLocation}
        >
          <Layers3 className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
          <span className="min-w-0 flex-1 truncate text-foreground">{map.name}</span>
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              deleted
                ? 'border-muted-foreground/25 bg-muted text-muted-foreground'
                : 'border-accent-copper/35 bg-accent-copper/10 text-accent-copper',
            )}
          >
            {deleted ? 'Deleted' : 'Active'}
          </span>
        </button>
      </div>
      {open && hasChildren ? (
        <div className="mt-0.5">
          <SidebarContextNodes
            tree={map.tree}
            nodes={map.tree.nodes}
            depth={0}
            onOpenContext={onOpenContext}
          />
        </div>
      ) : null}
    </div>
  );
}

const CONTEXT_SIBLING_PAGE_SIZE = 64;

// Mount only expanded branches and a bounded sibling page. Every remaining
// item stays reachable; rendering limits must never become hidden data limits.
function SidebarContextNodes({
  tree,
  nodes,
  depth,
  onOpenContext,
}: {
  tree: ProjectContextTree;
  nodes: readonly ContextTreeNode[];
  depth: number;
  onOpenContext: () => void;
}) {
  const [visibleCount, setVisibleCount] = React.useState(CONTEXT_SIBLING_PAGE_SIZE);
  const remaining = Math.max(0, nodes.length - visibleCount);
  return (
    <>
      {nodes.slice(0, visibleCount).map((node) => (
        <SidebarContextNode
          key={node.id}
          tree={tree}
          node={node}
          depth={depth}
          onOpenContext={onOpenContext}
        />
      ))}
      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setVisibleCount((count) => count + CONTEXT_SIBLING_PAGE_SIZE)}
          className="h-7 w-full rounded-md pr-2 text-left text-metadata text-muted-foreground hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: 14 + depth * 12 }}
        >
          Show {Math.min(CONTEXT_SIBLING_PAGE_SIZE, remaining)} more ({remaining} remaining)
        </button>
      ) : null}
    </>
  );
}

function SidebarContextNode({
  tree,
  node,
  depth,
  onOpenContext,
}: {
  tree: ProjectContextTree;
  node: ContextTreeNode;
  depth: number;
  onOpenContext: () => void;
}) {
  const [open, setOpen] = React.useState(depth < 1);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const openNode = () => {
    const filePath = contextNodeFilePath(tree, node);
    if (filePath) {
      void selectPersistedContextFile(tree.projectId, filePath).catch((error) =>
        toast.error(
          'Could not save selected Context file',
          error instanceof Error ? error.message : 'Unknown persistence error',
        ),
      );
    }
    onOpenContext();
  };
  const onDragStart = (e: React.DragEvent) => {
    const attachment = nodeToAttachment(tree, node);
    const filePath = contextNodeFilePath(tree, node);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData(CONTEXT_MIME, serializeContextAttachment(attachment));
    if (filePath) {
      e.dataTransfer.setData('application/x-jarvis-file', filePath);
      e.dataTransfer.setData('text/plain', filePath);
    } else {
      e.dataTransfer.setData('text/plain', formatContextAttachmentForTerminal(attachment));
    }
  };
  return (
    <div data-context-node-id={node.id}>
      <div
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-secondary text-foreground transition-colors',
          'hover:bg-muted focus-within:ring-1 focus-within:ring-ring',
        )}
        style={{ paddingLeft: 14 + depth * 12 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((cur) => !cur);
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-paper-soft hover:text-foreground focus-visible:outline-none"
            aria-label={open ? 'Collapse Context branch' : 'Expand Context branch'}
            aria-expanded={open}
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
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
          onClick={openNode}
          onDoubleClick={openNode}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
          title={node.summary}
        >
          {node.kind === 'file' ? (
            <FileText className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
          ) : (
            <Network className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
          )}
          <span className="min-w-0 flex-1 truncate">{node.title}</span>
        </button>
      </div>
      {open && hasChildren ? (
        <SidebarContextNodes
          tree={tree}
          nodes={node.children!}
          depth={depth + 1}
          onOpenContext={onOpenContext}
        />
      ) : null}
    </div>
  );
}

export default SidebarContextTree;
