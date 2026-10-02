import * as React from 'react';
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { listDirectory, describeFsError, type FsEntry } from '@/lib/fs';
import { useAuthStore } from '@/stores/auth';
import {
  basename,
  chooseProjectFolder,
  getStoredProjectRoot,
  isPopularTextFile,
  setStoredProjectRoot,
} from '@/features/files/projectFiles';
import { useWorkbenchStore } from './store';
import type { WorkbenchPanel } from './types';

interface FilesPanelProps {
  panel: WorkbenchPanel;
  onUpdate: (patch: Partial<WorkbenchPanel>) => void;
}

const MAX_CHILDREN = 200;

function TreeNode({
  entry,
  rootDir,
  depth,
  onOpenFile,
}: {
  entry: FsEntry;
  rootDir: string;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  const loadChildren = async () => {
    if (!entry.isDir || children.length > 0) return;
    setLoading(true);
    const result = await listDirectory(entry.path, { root: rootDir });
    setLoading(false);
    if (!result.ok) {
      toast.error('Could not open folder', describeFsError(result.error));
      return;
    }
    setChildren(result.entries.slice(0, MAX_CHILDREN));
  };

  const toggle = async () => {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next) await loadChildren();
  };

  return (
    <div>
      <button
        type="button"
        className="workbench-files-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => void toggle()}
      >
        {entry.isDir ? (
          open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />
        ) : (
          <FileText aria-hidden="true" />
        )}
        <span>{entry.name}</span>
        {entry.isDir ? (
          <ChevronRight
            className={open ? 'workbench-files-chevron open' : 'workbench-files-chevron'}
            aria-hidden="true"
          />
        ) : null}
        {loading ? <span className="workbench-files-muted">…</span> : null}
      </button>
      {open
        ? children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              rootDir={rootDir}
              depth={depth + 1}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
}

/**
 * Project files tree. `onUpdate` is stored in a ref; loads only re-run when
 * the project id / explicit refresh / root-changed event fires — never from
 * writing cwd back into panel settings.
 */
export function FilesPanel({ panel, onUpdate }: FilesPanelProps) {
  const activeProjectId = useAuthStore((state) => state.projectId);
  const independent = panel.settings.filesRootScope === 'panel';
  const projectId = independent ? null : activeProjectId;
  const scopeKey = `${independent ? 'panel' : 'project'}:${projectId ?? ''}`;
  const openFileInEditor = useWorkbenchStore((state) => state.openFileInEditor);
  const [rootDir, setRootDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [pathDraft, setPathDraft] = React.useState(() => getStoredProjectRoot(projectId));
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const onUpdateRef = React.useRef(onUpdate);
  const rootRequestRef = React.useRef(0);
  const scopeRef = React.useRef(scopeKey);
  scopeRef.current = scopeKey;
  const loadedProjectRef = React.useRef(projectId);
  const statusRef = React.useRef(panel.status);
  const cwdRef = React.useRef(panel.settings.cwd);
  onUpdateRef.current = onUpdate;
  statusRef.current = panel.status;
  cwdRef.current = panel.settings.cwd;

  const publishStatus = React.useCallback((status: WorkbenchPanel['status'], cwd?: string) => {
    const nextCwd = cwd ?? cwdRef.current;
    const statusChanged = statusRef.current !== status;
    const cwdChanged = nextCwd != null && cwdRef.current !== nextCwd;
    if (!statusChanged && !cwdChanged) return;
    statusRef.current = status;
    if (nextCwd != null) cwdRef.current = nextCwd;
    onUpdateRef.current({
      status,
      ...(cwdChanged ? { settings: { cwd: nextCwd } } : {}),
    });
  }, []);

  const loadRoot = React.useCallback(
    async (path: string) => {
      const request = ++rootRequestRef.current;
      const current = () => request === rootRequestRef.current && scopeRef.current === scopeKey;
      if (!path.trim()) {
        setEntries([]);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await listDirectory(path.trim(), { root: path.trim() });
        if (!current()) return;
        if (!result.ok) {
          setEntries([]);
          setError(describeFsError(result.error));
          publishStatus('error');
          return;
        }
        setRootDir(result.path);
        setPathDraft(result.path);
        setEntries(result.entries.slice(0, MAX_CHILDREN));
        // The root-changed event is also observed by this panel. Do not emit
        // it again for an unchanged root after every directory listing.
        if (!independent && getStoredProjectRoot(projectId) !== result.path) {
          setStoredProjectRoot(projectId, result.path);
        }
        publishStatus('ready', result.path);
      } catch (cause) {
        if (!current()) return;
        setEntries([]);
        setError(cause instanceof Error ? cause.message : 'Could not list directory.');
        publishStatus('error');
      } finally {
        if (current()) setLoading(false);
      }
    },
    [projectId, independent, scopeKey, publishStatus],
  );

  React.useEffect(() => {
    const switchedProject = !independent && loadedProjectRef.current !== projectId;
    const next = switchedProject ? getStoredProjectRoot(projectId) :
      panel.settings.cwd || getStoredProjectRoot(projectId);
    loadedProjectRef.current = projectId;
    setRootDir(next);
    setPathDraft(next);
    setEntries([]);
    void loadRoot(next);
    return () => {
      rootRequestRef.current += 1;
    };
    // Only re-bind when project changes; cwd in settings is optional seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRoot, projectId]);

  React.useEffect(() => {
    if (independent) return;
    const onRootChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if ((detail?.projectId ?? null) !== (projectId ?? null)) return;
      const next = detail?.path ?? getStoredProjectRoot(projectId);
      setRootDir(next);
      setPathDraft(next);
      void loadRoot(next);
    };
    window.addEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
    return () =>
      window.removeEventListener('jarvis:files:root-changed', onRootChanged as EventListener);
  }, [loadRoot, projectId, independent]);

  const onOpenFile = (path: string) => {
    if (!isPopularTextFile(path)) {
      toast.info(
        'Binary or unsupported type',
        'Open text-based project files in the Workbench editor.',
      );
      return;
    }
    const id = openFileInEditor(path, rootDir);
    if (id) {
      publishStatus('ready');
      toast.success('Opened in editor', basename(path));
    }
  };

  const chooseRoot = async () => {
    const picked = await chooseProjectFolder();
    if (scopeRef.current !== scopeKey) return;
    if (!picked) {
      toast.info(
        'Desktop app required',
        'Folder picking needs the native VibeSpace shell, or set a path from Files.',
      );
      return;
    }
    await loadRoot(picked);
  };

  return (
    <div
      className="workbench-files"
      data-testid="workbench-files-panel"
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="workbench-files-toolbar">
        <strong title={rootDir || 'No project folder'}>
          {rootDir ? basename(rootDir) || rootDir : 'No project folder'}
        </strong>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh files"
          onClick={() => rootDir && void loadRoot(rootDir)}
        >
          <RefreshCw />
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void chooseRoot()}>
          Choose folder
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={independent}
          title="Keep this panel's folder separate from the project folder"
          onClick={() => onUpdateRef.current({
            settings: {
              ...panel.settings,
              filesRootScope: independent ? 'project' : 'panel',
              cwd: independent ? getStoredProjectRoot(activeProjectId) : rootDir,
            },
          })}
        >
          Independent folder
        </Button>
      </div>
      <form
        className="workbench-files-path"
        onSubmit={(event) => {
          event.preventDefault();
          void loadRoot(pathDraft);
        }}
      >
        <label htmlFor={`workbench-files-path-${panel.id}`} className="sr-only">
          Project folder path
        </label>
        <input
          id={`workbench-files-path-${panel.id}`}
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          placeholder="Absolute project folder path"
          spellCheck={false}
        />
        <Button type="submit" size="sm" disabled={!pathDraft.trim() || loading}>
          Open path
        </Button>
      </form>
      {loading ? <p className="workbench-files-muted">Loading…</p> : null}
      {error ? (
        <div className="workbench-panel-empty" role="alert">
          <strong>Could not load project files</strong>
          <span>{error}</span>
          <span>Paste an absolute folder path above (desktop shell required for native browse).</span>
        </div>
      ) : null}
      {!loading && !error && !rootDir ? (
        <div className="workbench-panel-empty">
          <strong>No project folder</strong>
          <span>
            Choose a folder or paste an absolute path. Listing uses the same secure FS bridge as the
            Files page.
          </span>
          <Button type="button" size="sm" onClick={() => void chooseRoot()}>
            Choose folder
          </Button>
        </div>
      ) : null}
      {!loading && !error && rootDir ? (
        <div className="workbench-files-tree" role="tree" aria-label="Project files">
          {entries.length === 0 ? (
            <p className="workbench-files-muted">This folder is empty.</p>
          ) : (
            entries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                rootDir={rootDir}
                depth={0}
                onOpenFile={onOpenFile}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
