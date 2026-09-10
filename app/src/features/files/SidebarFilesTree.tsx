import * as React from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeFsError, type FsEntry } from '@/lib/fs';
import { listExplorerDirectory as listDirectory } from './fileExplorerDirectory';
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
  const [error, setError] = React.useState('');
  const [visibleEntries, setVisibleEntries] = React.useState(MAX_CHILDREN);
  const requestRef = React.useRef(0);

  const loadRoot = React.useCallback(async (path: string) => {
    const request = ++requestRef.current;
    setEntries([]);
    setError('');
    setVisibleEntries(MAX_CHILDREN);
    if (!path) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const result = await listDirectory(path, { root: path });
    if (request !== requestRef.current) return;
    setLoading(false);
    if (result.ok) setEntries(result.entries);
    else setError(describeFsError(result.error));
  }, []);

  React.useEffect(() => {
    const next = getStoredProjectRoot(projectId);
    setRootDir(next);
    setEntries([]);
    void loadRoot(next);
    return () => {
      requestRef.current += 1;
    };
  }, [loadRoot, projectId]);

  React.useEffect(() => {
    const onRootChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      const next = detail?.path ?? getStoredProjectRoot(projectId);
      setRootDir(next);
      setEntries([]);
      void loadRoot(next);
    };
    window.addEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
    return () =>
      window.removeEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
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
          active
            ? 'bg-muted text-foreground ring-inset ring-1 ring-accent-copper/40'
            : 'text-muted-foreground',
        )}
        title={rootDir}
      >
        <FolderOpen className="h-3.5 w-3.5 text-accent-honey" />
        <span className="min-w-0 flex-1 truncate font-mono">{basename(rootDir)}</span>
        {loading && <RefreshCw className="h-3 w-3 animate-spin" />}
      </button>
      {error ? (
        <div role="alert">
          {error}
          <button type="button" onClick={() => void loadRoot(rootDir)}>
            Retry folder
          </button>
        </div>
      ) : null}
      {entries.slice(0, visibleEntries).map((entry) => (
        <SidebarFileNode
          key={entry.path}
          entry={entry}
          depth={0}
          rootDir={rootDir}
          projectId={projectId}
          onOpenFiles={onOpenFiles}
        />
      ))}
      {entries.length > visibleEntries ? (
        <button type="button" onClick={() => setVisibleEntries((n) => n + MAX_CHILDREN)}>
          Show more files ({entries.length - visibleEntries})
        </button>
      ) : null}
    </div>
  );
}

function SidebarFileNode({
  entry,
  depth,
  rootDir,
  projectId,
  onOpenFiles,
}: {
  entry: FsEntry;
  depth: number;
  rootDir: string;
  projectId: string | null;
  onOpenFiles: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<FsEntry[]>([]);
  const [visibleChildren, setVisibleChildren] = React.useState(MAX_CHILDREN);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const loadChildren = async () => {
    if (!entry.isDir || children.length > 0) return;
    setLoading(true);
    const result = await listDirectory(entry.path, { root: rootDir });
    setLoading(false);
    if (result.ok) {
      setChildren(result.entries);
      setError('');
    } else setError(describeFsError(result.error));
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
            open ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-accent-honey" />
            )
          ) : (
            <FileText
              className={cn(
                'h-3.5 w-3.5 shrink-0',
                isPopularTextFile(entry.path) ? 'text-accent-copper' : 'text-muted-foreground',
              )}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      {open && error ? (
        <div role="alert">
          {error}
          <button type="button" onClick={() => void loadChildren()}>
            Retry folder
          </button>
        </div>
      ) : null}
      {open &&
        children
          .slice(0, visibleChildren)
          .map((child) => (
            <SidebarFileNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              rootDir={rootDir}
              projectId={projectId}
              onOpenFiles={onOpenFiles}
            />
          ))}
      {open && children.length > visibleChildren ? (
        <button type="button" onClick={() => setVisibleChildren((n) => n + MAX_CHILDREN)}>
          Show more files ({children.length - visibleChildren})
        </button>
      ) : null}
    </div>
  );
}

export default SidebarFilesTree;
