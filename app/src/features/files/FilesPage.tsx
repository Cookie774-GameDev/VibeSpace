import * as React from 'react';
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
} from 'lucide-react';
import { Button, Input, Textarea, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { chatRepo } from '@/lib/db';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { AgentId, ChatId, ProjectId, WorkspaceId } from '@/types';
import {
  createTextFile,
  describeFsError,
  listDirectory,
  readTextFile,
  writeTextFile,
  type FsEntry,
} from '@/lib/fs';
import {
  basename,
  chooseProjectFolder,
  dirname,
  extension,
  getStoredOpenFile,
  getStoredProjectRoot,
  isPopularTextFile,
  joinPath,
  setStoredOpenFile,
  setStoredProjectRoot,
} from './projectFiles';
import { startRightClickDrag } from '@/lib/rightClickDrag';

const MAX_TREE_CHILDREN = 500;

interface TreeNodeProps {
  entry: FsEntry;
  depth: number;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  onOpenDir: (path: string) => void;
}

function FileTreeNode({ entry, depth, selectedPath, onOpenFile, onOpenDir }: TreeNodeProps) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  const loadChildren = async () => {
    if (!entry.isDir) return;
    if (children.length > 0) return;
    setLoading(true);
    const result = await listDirectory(entry.path);
    setLoading(false);
    if (!result.ok) {
      toast.error('Could not open folder', describeFsError(result.error));
      return;
    }
    setChildren(result.entries.slice(0, MAX_TREE_CHILDREN));
  };

  const toggle = async () => {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !open;
    setOpen(next);
    onOpenDir(entry.path);
    if (next) await loadChildren();
  };

  const onDragStart = (e: React.DragEvent) => {
    if (entry.isDir) return;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.setData('application/x-jarvis-file', entry.path);
  };

  return (
    <div>
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
        onClick={() => void toggle()}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left transition-colors',
          'hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          selectedPath === entry.path && 'bg-muted ring-1 ring-accent-copper/40',
        )}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        {entry.isDir ? (
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-90')} />
        ) : (
          <span className="h-3.5 w-3.5" />
        )}
        {entry.isDir ? (
          open ? <FolderOpen className="h-4 w-4 text-accent-honey" /> : <Folder className="h-4 w-4 text-accent-honey" />
        ) : (
          <FileText className={cn('h-4 w-4', isPopularTextFile(entry.path) ? 'text-accent-copper' : 'text-muted-foreground')} />
        )}
        <span className="min-w-0 flex-1 truncate text-secondary text-foreground">{entry.name}</span>
        {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        {!entry.isDir && entry.size !== undefined && (
          <span className="text-metadata text-muted-foreground">{Math.ceil(entry.size / 1024)}k</span>
        )}
      </button>
      {open && children.length > 0 && children.map((child) => (
        <FileTreeNode
          key={child.path}
          entry={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onOpenFile={onOpenFile}
          onOpenDir={onOpenDir}
        />
      ))}
    </div>
  );
}

export function FilesPage() {
  const projectId = useAuthStore((s) => s.projectId) as ProjectId | null;
  const workspaceId = useAuthStore((s) => s.workspaceId) as WorkspaceId | null;
  const [rootDraft, setRootDraft] = React.useState(() => getStoredProjectRoot(projectId));
  const [rootDir, setRootDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [currentDir, setCurrentDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [selectedPath, setSelectedPath] = React.useState<string | null>(() => getStoredOpenFile(projectId) || null);
  const [content, setContent] = React.useState('');
  const [savedContent, setSavedContent] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [newFileName, setNewFileName] = React.useState('');
  const [askDraft, setAskDraft] = React.useState('Explain this code and suggest a safe edit.');
  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  const activeChatId = useUIStore((s) => s.activeChatId);
  const setActiveChat = useUIStore((s) => s.setActiveChat);
  const setRoute = useUIStore((s) => s.setRoute);

  const dirty = content !== savedContent;

  const loadRoot = React.useCallback(async (path: string) => {
    if (!path.trim()) return;
    setLoading(true);
    const result = await listDirectory(path.trim());
    setLoading(false);
    if (!result.ok) {
      toast.error('Could not open project folder', describeFsError(result.error));
      return;
    }
    setRootDir(result.path);
    setCurrentDir(result.path);
    setRootDraft(result.path);
    setEntries(result.entries);
    setStoredProjectRoot(projectId, result.path);
  }, [projectId]);

  React.useEffect(() => {
    const nextRoot = getStoredProjectRoot(projectId);
    const nextFile = getStoredOpenFile(projectId);
    setRootDraft(nextRoot);
    setRootDir(nextRoot);
    setCurrentDir(nextRoot);
    setEntries([]);
    setSelectedPath(nextFile || null);
    setContent('');
    setSavedContent('');
    if (nextRoot) void loadRoot(nextRoot);
    if (nextFile) void openFile(nextFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const openFile = async (path: string) => {
    const result = await readTextFile(path);
    if (!result.ok) {
      toast.error('Could not read file', describeFsError(result.error));
      return;
    }
    setSelectedPath(path);
    setContent(result.content);
    setSavedContent(result.content);
    setStoredOpenFile(projectId, path, false);
  };

  React.useEffect(() => {
    const onOpenPath = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; path?: string }>).detail;
      if (!detail?.path) return;
      if ((detail.projectId ?? null) !== (projectId ?? null)) return;
      setCurrentDir(dirname(detail.path));
      void openFile(detail.path);
    };
    window.addEventListener('jarvis:files:open-path', onOpenPath as EventListener);
    return () => window.removeEventListener('jarvis:files:open-path', onOpenPath as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const chooseRoot = async () => {
    const picked = await chooseProjectFolder();
    if (!picked) {
      toast.info('Use the path field', 'Native folder picking is available in the desktop app.');
      return;
    }
    setRootDraft(picked);
    await loadRoot(picked);
  };

  const saveFile = async () => {
    if (!selectedPath) return;
    const result = await writeTextFile(selectedPath, content);
    if (!result.ok) {
      toast.error('Save failed', describeFsError(result.error));
      return;
    }
    setSavedContent(content);
    toast.success('Saved', basename(selectedPath));
    if (rootDir) void loadRoot(rootDir);
  };

  const createFile = async () => {
    const name = newFileName.trim();
    if (!name || !currentDir) return;
    const path = joinPath(currentDir, name);
    const result = await createTextFile(path);
    if (!result.ok) {
      toast.error('Could not create file', describeFsError(result.error));
      return;
    }
    setNewFileName('');
    if (rootDir) await loadRoot(rootDir);
    await openFile(path);
  };

  const selectedText = () => {
    const el = editorRef.current;
    if (!el) return '';
    return content.slice(el.selectionStart, el.selectionEnd).trim();
  };

  const ensureChat = async (): Promise<ChatId | string | null> => {
    if (activeChatId) return activeChatId;
    if (!workspaceId) return null;
    const chat = await chatRepo.create({
      workspace_id: workspaceId,
      project_id: projectId ?? undefined,
      title: selectedPath ? `Ask about ${basename(selectedPath)}` : 'Files question',
      mode: 'chat',
      active_agent_ids: [] as AgentId[],
    });
    setActiveChat(chat.id);
    return chat.id;
  };

  const askJarvis = async () => {
    if (!selectedPath) return;
    const code = selectedText() || content.slice(0, 8000);
    if (!code.trim()) return;
    const chatId = await ensureChat();
    if (!chatId) {
      toast.error('No workspace yet', 'Create or load a workspace before asking Jarvis.');
      return;
    }
    setRoute('chat');
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('jarvis:files:ask', {
        detail: { path: selectedPath, prompt: askDraft.trim() || 'Review this code.', code },
      }));
    }, 80);
    toast.success('Prepared Jarvis question', basename(selectedPath));
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-background">
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-border bg-panel">
        <div className="border-b border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-accent-copper" />
            <div className="text-ui-strong text-foreground">Project Files</div>
          </div>
          <div className="flex gap-1.5">
            <Input
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadRoot(rootDraft); }}
              placeholder="C:\\Users\\you\\project or /home/you/project"
              className="font-mono text-metadata"
            />
            <Button size="sm" variant="secondary" onClick={() => void chooseRoot()}>Choose</Button>
            <Button size="sm" variant="accent" onClick={() => void loadRoot(rootDraft)}>Open</Button>
          </div>
          {rootDir && (
            <div className="flex items-center gap-1.5 text-metadata text-muted-foreground">
              <button className="hover:text-foreground" onClick={() => void loadRoot(dirname(rootDir))}>Up</button>
              <span className="truncate font-mono" title={rootDir}>{rootDir}</span>
              <button className="ml-auto hover:text-foreground" onClick={() => void loadRoot(rootDir)} aria-label="Refresh files">
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {entries.length === 0 ? (
            <div className="p-3 text-secondary text-muted-foreground">
              Open a project folder. Folders expand in-place and files can be dragged into chat or terminals.
            </div>
          ) : entries.map((entry) => (
            <FileTreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              selectedPath={selectedPath}
              onOpenFile={(path) => void openFile(path)}
              onOpenDir={setCurrentDir}
            />
          ))}
        </div>

        <div className="border-t border-border p-2">
          <div className="mb-1 truncate text-metadata text-muted-foreground">New file in: <span className="font-mono">{currentDir || rootDir || 'open a folder'}</span></div>
          <div className="flex gap-1.5">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createFile(); }}
              placeholder="new-file.ts"
              className="font-mono text-metadata"
              disabled={!currentDir}
            />
            <Button size="sm" variant="ghost" onClick={() => void createFile()} disabled={!currentDir || !newFileName.trim()}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-paper-soft px-3 py-1.5">
          <div className="min-w-0">
            <div className="truncate font-mono text-secondary text-foreground">{selectedPath ?? 'No file selected'}</div>
            <div className="text-metadata text-muted-foreground">
              Popular text/code formats are editable. Binary and oversized files are safely rejected.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selectedPath && <span className="text-metadata text-muted-foreground">.{extension(selectedPath) || 'file'}</span>}
            {dirty && <span className="text-metadata text-accent-copper">Unsaved</span>}
            <Button size="sm" variant="accent" onClick={() => void saveFile()} disabled={!selectedPath || !dirty} className="gap-1">
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Textarea
            ref={editorRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Open a text/code file to edit it here."
            spellCheck={false}
            className="min-h-0 flex-1 resize-none font-mono text-sm leading-5"
          />
          <div className="rounded-lg border border-border bg-panel p-2">
            <div className="mb-1.5 flex items-center gap-2 text-ui-strong text-foreground">
              <Sparkles className="h-4 w-4 text-accent-copper" /> Ask Jarvis About Selection
            </div>
            <div className="flex gap-2">
              <Input value={askDraft} onChange={(e) => setAskDraft(e.target.value)} placeholder="Ask for an explanation, refactor, bug fix, or edit plan" />
              <Button variant="accent" size="sm" onClick={() => void askJarvis()} disabled={!selectedPath || !content.trim()} className="gap-1 shrink-0">
                <Send className="h-3.5 w-3.5" /> Send to Jarvis
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default FilesPage;
