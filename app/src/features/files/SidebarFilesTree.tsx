import * as React from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { listDirectory, type FsEntry } from '@/lib/fs';
import { useAuthStore } from '@/stores/auth';
import {
  basename,
  getStoredProjectRoot,
  isPopularTextFile,
  setStoredOpenFile,
} from './projectFiles';
import { startRightClickDrag } from '@/lib/rightClickDrag';

interface SidebarFilesTreeProps {
  navOpen: boolean;
  active: boolean;
  onOpenFiles: () => void;
}

const MAX_CHILDREN = 120;

export function SidebarFilesTree({ navOpen, active, onOpenFiles }: SidebarFilesTreeProps) {
  const projectId = useAuthStore((s) => s.projectId);
  const [rootDir, setRootDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  const loadRoot = React.useCallback(async (path: string) => {
    if (!path) return;
    setLoading(true);
    const result = await listDirectory(path);
    setLoading(false);
    if (result.ok) setEntries(result.entries.slice(0, MAX_CHILDREN));
  }, []);

  React.useEffect(() => {
    const next = getStoredProjectRoot(projectId);
    setRootDir(next);
    setEntries([]);
    if (next) void loadRoot(next);
  }, [loadRoot, projectId]);

  React.useEffect(() => {
    const onRootChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      const next = detail?.path ?? getStoredProjectRoot(projectId);
      setRootDir(next);
      setEntries([]);
      if (next) void loadRoot(next);
    };
    window.addEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
    return () => window.removeEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
  }, [loadRoot, projectId]);

  if (!navOpen) return null;

  if (!rootDir) {
    return (
      <button
        type="button"
        onClick={onOpenFiles}
        className={cn(
          'mx-1 rounded-lg border border-dashed border-border bg-paper-soft px-2 py-2 text-left text-metadata text-muted-foreground transition-colors',
          'hover:border-accent-copper/50 hover:text-foreground',
          active && 'border-accent-copper/50 text-foreground',
        )}
      >
        Open Files to choose a project folder.
      </button>
    );
  }

  return (
    <div className="space-y-1 px-1">
      <button
        type="button"
        onClick={onOpenFiles}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-metadata transition-colors hover:bg-muted',
          active ? 'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40' : 'text-muted-foreground',
        )}
        title={rootDir}
      >
        <FolderOpen className="h-3.5 w-3.5 text-accent-honey" />
        <span className="min-w-0 flex-1 truncate font-mono">{basename(rootDir)}</span>
        {loading && <RefreshCw className="h-3 w-3 animate-spin" />}
      </button>
      {entries.map((entry) => (
        <SidebarFileNode
          key={entry.path}
          entry={entry}
          depth={0}
          projectId={projectId}
          onOpenFiles={onOpenFiles}
        />
      ))}
    </div>
  );
}

function SidebarFileNode({
  entry,
  depth,
  projectId,
  onOpenFiles,
}: {
  entry: FsEntry;
  depth: number;
  projectId: string | null;
  onOpenFiles: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  const loadChildren = async () => {
    if (!entry.isDir || children.length > 0) return;
    setLoading(true);
    const result = await listDirectory(entry.path);
    setLoading(false);
    if (result.ok) setChildren(result.entries.slice(0, MAX_CHILDREN));
  };

  const toggleFolder = async () => {
    if (!entry.isDir) return;
    const next = !open;
    setOpen(next);
    if (next) await loadChildren();
  };

  const openEntry = async () => {
    if (entry.isDir) {
      onOpenFiles();
      return;
    }
    setStoredOpenFile(projectId, entry.path);
    onOpenFiles();
  };

  const onDragStart = (e: React.DragEvent) => {
    if (entry.isDir) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.setData('application/x-jarvis-file', entry.path);
  };

  return (
    <div>
      <div
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-secondary text-foreground transition-colors hover:bg-muted focus-within:ring-1 focus-within:ring-ring"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {entry.isDir ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void toggleFolder();
            }}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-paper-soft hover:text-foreground focus-visible:outline-none"
            aria-label={open ? 'Collapse folder' : 'Expand folder'}
          >
            <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}
        <button
          type="button"
          draggable={!entry.isDir}
          onDragStart={onDragStart}
          onMouseDown={(e) => {
            if (e.button === 2 && !entry.isDir) {
              e.stopPropagation();
              startRightClickDrag(e, 'file', { path: entry.path });
            }
          }}
          onClick={() => void openEntry()}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus-visible:outline-none"
          title={entry.path}
        >
          {entry.isDir ? (
            open ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-honey" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
          ) : (
            <FileText className={cn('h-3.5 w-3.5 shrink-0', isPopularTextFile(entry.path) ? 'text-accent-copper' : 'text-muted-foreground')} />
          )}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {open && children.map((child) => (
        <SidebarFileNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          projectId={projectId}
          onOpenFiles={onOpenFiles}
        />
      ))}
    </div>
  );
}

export default SidebarFilesTree;
