import * as React from 'react';
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { Button, Input, Textarea, toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth';
import { useAgentStore } from '@/stores/agents';
import { findProtectedJarvisAgent } from '@/lib/jarvis/identity';
import type { ProjectId } from '@/types';
import {
  createTextFile,
  describeFsError,
  listDirectory,
  readTextFile,
  writeTextFile,
  type FsEntry,
} from '@/lib/fs';
import { runAgent } from '@/lib/ai/router';
import { applyChatModelSelectionToAgent } from '@/lib/ai/modelSelection';
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
import {
  activateWorkspaceFile,
  closeWorkspaceFile,
  fileWorkspaceTabLabel,
  getFileWorkspaceState,
  openWorkspaceFile,
  patchWorkspaceTab,
  reconcileWorkspaceFile,
  setAskPanelCollapsed,
  setAskPanelDefault,
  setFilesSidebarWidth,
  useFileWorkspace,
  type FileAssistantLine,
} from './fileWorkspaceStore';
import { startRightClickDrag } from '@/lib/rightClickDrag';
import {
  askAssistantAboutLabel,
  askAssistantLabel,
  useAssistantPersonaName,
} from '@/lib/assistantPersona';
import './sakura-files.css';

function filesMiniSystemPrompt(assistantName: string): string {
  return [
    `You are ${assistantName} answering questions about a code/file selection inside the VibeSpace Files page.`,
    'Keep replies short, clear, and to the point — prefer tight bullet lines over long essays.',
    'Stay focused on the attached selection and the user question. Do not invent files that are not shown.',
  ].join(' ');
}

const MAX_TREE_CHILDREN = 500;

interface TreeNodeProps {
  entry: FsEntry;
  depth: number;
  rootDir: string;
  selectedPath: string | null;
  onOpenFile: (path: string) => void;
  onOpenDir: (path: string) => void;
}

function FileTreeNode({
  entry,
  depth,
  rootDir,
  selectedPath,
  onOpenFile,
  onOpenDir,
}: TreeNodeProps) {
  const [open, setOpen] = React.useState(false);
  const [children, setChildren] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);

  const loadChildren = async () => {
    if (!entry.isDir) return;
    if (children.length > 0) return;
    setLoading(true);
    const result = await listDirectory(entry.path, { root: rootDir });
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
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
              open && 'rotate-90',
            )}
          />
        ) : (
          <span className="h-3.5 w-3.5" />
        )}
        {entry.isDir ? (
          open ? (
            <FolderOpen className="h-4 w-4 text-accent-honey" />
          ) : (
            <Folder className="h-4 w-4 text-accent-honey" />
          )
        ) : (
          <FileText
            className={cn(
              'h-4 w-4',
              isPopularTextFile(entry.path) ? 'text-accent-copper' : 'text-muted-foreground',
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-secondary text-foreground">{entry.name}</span>
        {loading && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        {!entry.isDir && entry.size !== undefined && (
          <span className="text-metadata text-muted-foreground">
            {Math.ceil(entry.size / 1024)}k
          </span>
        )}
      </button>
      {open &&
        children.length > 0 &&
        children.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            rootDir={rootDir}
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
  const workspace = useFileWorkspace(projectId);
  const activeTab = workspace.tabs.find((tab) => tab.path === workspace.activePath) ?? null;
  const selectedPath = activeTab?.path ?? null;
  const content = activeTab?.content ?? '';
  const savedContent = activeTab?.savedContent ?? '';
  const askDraft = activeTab?.askDraft ?? '';
  const attachedSelection = activeTab?.attachedSelection ?? '';
  const miniLines = activeTab?.assistantLines ?? [];
  const assistantName = useAssistantPersonaName();
  const askLabel = askAssistantLabel(assistantName);
  const [rootDraft, setRootDraft] = React.useState(() => getStoredProjectRoot(projectId));
  const [rootDir, setRootDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [currentDir, setCurrentDir] = React.useState(() => getStoredProjectRoot(projectId));
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [newFileName, setNewFileName] = React.useState('');
  const [miniBusyPath, setMiniBusyPath] = React.useState<string | null>(null);
  const [selPopup, setSelPopup] = React.useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);
  const editorRef = React.useRef<HTMLTextAreaElement>(null);
  const miniScrollRef = React.useRef<HTMLDivElement>(null);
  const jarvisAgent = useAgentStore(
    (s) => findProtectedJarvisAgent(Object.values(s.agents)) ?? null,
  );
  const chatModelSelection = useAuthStore((s) => s.chatModelSelection);

  const dirty = content !== savedContent;
  const miniBusy = miniBusyPath === selectedPath;

  const patchActiveTab = React.useCallback(
    (patch: Parameters<typeof patchWorkspaceTab>[2]) => {
      if (selectedPath) patchWorkspaceTab(projectId, selectedPath, patch);
    },
    [projectId, selectedPath],
  );

  const loadRoot = React.useCallback(
    async (path: string) => {
      if (!path.trim()) return;
      setLoading(true);
      const clean = path.trim();
      const result = await listDirectory(clean, { root: clean });
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
      const currentWorkspace = getFileWorkspaceState(projectId);
      await Promise.all(
        currentWorkspace.tabs.map(async (tab) => {
          const refreshed = await readTextFile(tab.path, { root: clean });
          const outcome = reconcileWorkspaceFile(
            projectId,
            tab.path,
            refreshed.ok ? { ok: true, content: refreshed.content } : { ok: false },
          );
          if (outcome === 'preserved-unsaved' && !refreshed.ok) {
            toast.warning(
              'File changed outside VibeSpace',
              `${basename(tab.path)} is missing, but its unsaved buffer was preserved.`,
            );
          }
        }),
      );
    },
    [projectId],
  );

  React.useEffect(() => {
    const nextRoot = getStoredProjectRoot(projectId);
    const nextFile = getStoredOpenFile(projectId);
    setRootDraft(nextRoot);
    setRootDir(nextRoot);
    setCurrentDir(nextRoot);
    setEntries([]);
    if (nextRoot) void loadRoot(nextRoot);
    const persistedActive = getFileWorkspaceState(projectId).activePath;
    if (persistedActive) void openFile(persistedActive);
    else if (nextFile) void openFile(nextFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const openFile = async (path: string) => {
    const existing = getFileWorkspaceState(projectId).tabs.find((tab) => tab.path === path);
    if (existing?.loaded) {
      activateWorkspaceFile(projectId, path);
      setStoredOpenFile(projectId, path, false);
      return;
    }
    const result = await readTextFile(path, { root: rootDir });
    if (!result.ok) {
      toast.error('Could not read file', describeFsError(result.error));
      return;
    }
    openWorkspaceFile(projectId, path, result.content);
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
    const picked = await chooseProjectFolder({
      title: 'Choose project folder',
      initialPath: rootDraft.trim() || rootDir || undefined,
    });
    if (!picked) return;
    setRootDraft(picked);
    await loadRoot(picked);
    toast.success('Project folder selected', picked);
  };

  const saveFile = async () => {
    if (!selectedPath) return;
    const result = await writeTextFile(selectedPath, content, { root: rootDir });
    if (!result.ok) {
      toast.error('Save failed', describeFsError(result.error));
      return;
    }
    patchActiveTab({ savedContent: content });
    toast.success('Saved', basename(selectedPath));
    if (rootDir) void loadRoot(rootDir);
  };

  const createFile = async () => {
    const name = newFileName.trim();
    if (!name || !currentDir) return;
    const path = joinPath(currentDir, name);
    const result = await createTextFile(path, { root: rootDir });
    if (!result.ok) {
      toast.error('Could not create file', describeFsError(result.error));
      return;
    }
    setNewFileName('');
    if (rootDir) await loadRoot(rootDir);
    await openFile(path);
  };

  const readEditorSelection = React.useCallback((): string => {
    const el = editorRef.current;
    if (!el) return '';
    return content.slice(el.selectionStart, el.selectionEnd).trim();
  }, [content]);

  const updateSelectionPopup = React.useCallback(() => {
    const el = editorRef.current;
    if (!el) {
      setSelPopup(null);
      return;
    }
    const text = content.slice(el.selectionStart, el.selectionEnd).trim();
    if (!text || el.selectionStart === el.selectionEnd) {
      setSelPopup(null);
      return;
    }
    // Anchor a compact toolbar near the top of the editor (selection APIs
    // on <textarea> don't expose a client rect for the caret range).
    const rect = el.getBoundingClientRect();
    setSelPopup({
      text,
      top: Math.max(8, rect.top + 10),
      left: Math.min(window.innerWidth - 160, Math.max(12, rect.left + rect.width / 2 - 70)),
    });
  }, [content]);

  React.useEffect(() => {
    const hide = () => setSelPopup(null);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, []);

  React.useEffect(() => {
    const scrollHost = miniScrollRef.current;
    if (typeof scrollHost?.scrollTo === 'function') {
      scrollHost.scrollTo({
        top: scrollHost.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [miniLines, miniBusy]);

  const copySelection = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied', `${Math.min(text.length, 48)} chars`);
    } catch {
      toast.error('Copy failed', 'Clipboard is not available.');
    }
    setSelPopup(null);
  };

  /** Attach highlight into the Files mini chat only (no main Chat route). */
  const attachSelectionForAsk = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setSelPopup(null);
    patchActiveTab({
      attachedSelection: clean,
      ...(!askDraft.trim() ? { askDraft: 'Explain this selection briefly.' } : {}),
    });
  };

  const askJarvisMini = async () => {
    if (!selectedPath) return;
    const code = attachedSelection.trim() || readEditorSelection() || content.slice(0, 6000);
    const question = askDraft.trim() || 'Explain this briefly.';
    if (!code.trim()) {
      toast.warning('Nothing to ask about', 'Select text in the file or open a file first.');
      return;
    }
    if (!jarvisAgent) {
      toast.error('Jarvis not ready', 'Wait for agents to finish loading.');
      return;
    }

    const userLine = attachedSelection.trim()
      ? `${question}\n\n(Selection from ${basename(selectedPath)})`
      : question;

    const userId = `u_${Date.now().toString(36)}`;
    const assistantId = `a_${Date.now().toString(36)}`;
    const nextLines: FileAssistantLine[] = [
      ...miniLines,
      { id: userId, role: 'user', text: userLine },
      { id: assistantId, role: 'assistant', text: '' },
    ];
    patchActiveTab({ assistantLines: nextLines });
    setMiniBusyPath(selectedPath);

    const agent = applyChatModelSelectionToAgent(
      {
        ...jarvisAgent,
        system_prompt: [filesMiniSystemPrompt(assistantName), jarvisAgent.system_prompt ?? '']
          .filter(Boolean)
          .join('\n\n'),
      },
      chatModelSelection,
    );

    const payload = [
      `File: ${selectedPath}`,
      '',
      'Selection:',
      '```',
      code.slice(0, 12_000),
      '```',
      '',
      `Question: ${question}`,
    ].join('\n');

    try {
      const response = await runAgent({
        agent,
        messages: [{ role: 'user', content: payload }],
        max_output_tokens: 512,
        temperature: 0.35,
        onChunk: (chunk) => {
          if (!chunk.delta) return;
          const latest = getFileWorkspaceState(projectId).tabs.find(
            (tab) => tab.path === selectedPath,
          );
          patchWorkspaceTab(projectId, selectedPath, {
            assistantLines: (latest?.assistantLines ?? []).map((line) =>
              line.id === assistantId ? { ...line, text: line.text + chunk.delta } : line,
            ),
          });
        },
      });
      const finalText = (response.text || '').trim() || 'No response.';
      const latest = getFileWorkspaceState(projectId).tabs.find((tab) => tab.path === selectedPath);
      patchWorkspaceTab(projectId, selectedPath, {
        assistantLines: (latest?.assistantLines ?? []).map((line) =>
          line.id === assistantId ? { ...line, text: finalText } : line,
        ),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const latest = getFileWorkspaceState(projectId).tabs.find((tab) => tab.path === selectedPath);
      patchWorkspaceTab(projectId, selectedPath, {
        assistantLines: (latest?.assistantLines ?? []).map((line) =>
          line.id === assistantId ? { ...line, role: 'error', text: msg.slice(0, 280) } : line,
        ),
      });
    } finally {
      setMiniBusyPath((current) => (current === selectedPath ? null : current));
    }
  };

  const closeFileTab = (path: string) => {
    const tab = getFileWorkspaceState(projectId).tabs.find((candidate) => candidate.path === path);
    if (tab && tab.content !== tab.savedContent) {
      const confirmed = window.confirm(`Close ${basename(path)} and discard its unsaved changes?`);
      if (!confirmed) return;
    }
    closeWorkspaceFile(projectId, path);
  };

  const beginSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = workspace.sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      setFilesSidebarWidth(projectId, startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <div
      data-monochrome-route="files"
      data-sakura-route="files"
      data-sakura-intensity="quiet"
      className="flex h-full min-h-0 w-full bg-background [html[data-theme=monochrome]_&]:font-sans"
    >
      <aside
        data-monochrome-surface="files-tree"
        data-sakura-surface="files-tree"
        className="relative flex shrink-0 flex-col border-r border-border bg-panel"
        style={{ width: workspace.sidebarWidth }}
      >
        <div className="border-b border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-accent-copper" />
            <div className="text-ui-strong text-foreground">Project Files</div>
          </div>
          <div className="flex gap-1.5">
            <Input
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadRoot(rootDraft);
              }}
              aria-label="Project folder path"
              placeholder="C:\\Users\\you\\project or /home/you/project"
              className="font-mono text-metadata"
            />
            <Button size="sm" variant="secondary" onClick={() => void chooseRoot()}>
              Choose
            </Button>
            <Button size="sm" variant="accent" onClick={() => void loadRoot(rootDraft)}>
              Open
            </Button>
          </div>
          {rootDir && (
            <div className="flex items-center gap-1.5 text-metadata text-muted-foreground">
              <button
                className="hover:text-foreground"
                onClick={() => void loadRoot(dirname(rootDir))}
              >
                Up
              </button>
              <span className="truncate font-mono" title={rootDir}>
                {rootDir}
              </span>
              <button
                className="ml-auto hover:text-foreground"
                onClick={() => void loadRoot(rootDir)}
                aria-label="Refresh files"
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-1.5">
          {entries.length === 0 ? (
            <div className="p-3 text-secondary text-muted-foreground">
              Open a project folder. Folders expand in-place and files can be dragged into chat or
              terminals.
            </div>
          ) : (
            entries.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                rootDir={rootDir}
                selectedPath={selectedPath}
                onOpenFile={(path) => void openFile(path)}
                onOpenDir={setCurrentDir}
              />
            ))
          )}
        </div>

        <div className="border-t border-border p-2">
          <div className="mb-1 truncate text-metadata text-muted-foreground">
            New file in:{' '}
            <span className="font-mono">{currentDir || rootDir || 'open a folder'}</span>
          </div>
          <div className="flex gap-1.5">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFile();
              }}
              aria-label="New file name"
              placeholder="new-file.ts"
              className="font-mono text-metadata"
              disabled={!currentDir}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void createFile()}
              disabled={!currentDir || !newFileName.trim()}
              aria-label="Create file"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div
          role="separator"
          aria-label="Resize project files"
          aria-orientation="vertical"
          aria-valuemin={240}
          aria-valuemax={560}
          aria-valuenow={workspace.sidebarWidth}
          tabIndex={0}
          onPointerDown={beginSidebarResize}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            setFilesSidebarWidth(
              projectId,
              workspace.sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16),
            );
          }}
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none focus-visible:bg-accent-copper/30 focus-visible:outline-none"
        />
      </aside>

      <main
        data-monochrome-surface="files-editor"
        data-sakura-surface="files-editor"
        data-warm-state={selectedPath ? 'populated' : 'empty'}
        className="flex min-w-0 flex-1 flex-col [html[data-theme=monochrome]_&]:bg-background"
      >
        <div
          role="tablist"
          aria-label="Open project files"
          className="flex min-h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border bg-panel px-2 pt-1"
        >
          {workspace.tabs.length === 0 ? (
            <span className="self-center px-2 text-metadata text-muted-foreground">
              No open files
            </span>
          ) : (
            workspace.tabs.map((tab, index) => {
              const tabDirty = tab.content !== tab.savedContent;
              const active = tab.path === selectedPath;
              const tabLabel = fileWorkspaceTabLabel(
                tab.path,
                workspace.tabs.map((candidate) => candidate.path),
              );
              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group flex h-7 max-w-[240px] shrink-0 items-center rounded-t-md border border-b-0 px-1',
                    active
                      ? 'border-border bg-background text-foreground'
                      : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    tabIndex={active ? 0 : -1}
                    title={tab.path}
                    onClick={() => activateWorkspaceFile(projectId, tab.path)}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                      event.preventDefault();
                      const direction = event.key === 'ArrowRight' ? 1 : -1;
                      const next =
                        workspace.tabs[
                          (index + direction + workspace.tabs.length) % workspace.tabs.length
                        ];
                      if (next) activateWorkspaceFile(projectId, next.path);
                    }}
                    className="min-w-0 flex-1 truncate px-1.5 text-left text-metadata focus-visible:outline-none"
                  >
                    {tabLabel}
                    {tabDirty ? (
                      <span className="ml-1 text-accent-copper" aria-label="Unsaved">
                        ●
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tabLabel}`}
                    onClick={() => closeFileTab(tab.path)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border bg-paper-soft px-3 py-1.5 [html[data-theme=monochrome]_&]:bg-panel">
          <div className="min-w-0">
            <div className="truncate font-mono text-secondary text-foreground">
              {selectedPath ?? 'No file selected'}
            </div>
            <div className="text-metadata text-muted-foreground">
              Popular text/code formats are editable. Binary and oversized files are safely
              rejected.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selectedPath && (
              <span className="text-metadata text-muted-foreground">
                .{extension(selectedPath) || 'file'}
              </span>
            )}
            {dirty && <span className="text-metadata text-accent-copper">Unsaved</span>}
            <Button
              size="sm"
              variant="accent"
              onClick={() => void saveFile()}
              disabled={!selectedPath || !dirty}
              className="gap-1"
            >
              <Save className="h-3.5 w-3.5" /> Save
            </Button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col gap-2 p-3">
          <Textarea
            data-sakura-content="file-editor"
            ref={editorRef}
            value={content}
            onChange={(e) => patchActiveTab({ content: e.target.value })}
            onSelect={updateSelectionPopup}
            onMouseUp={updateSelectionPopup}
            onKeyUp={updateSelectionPopup}
            onBlur={() => {
              // Delay so toolbar buttons can receive the click first.
              window.setTimeout(() => setSelPopup(null), 180);
            }}
            aria-label="File contents"
            placeholder="Open a text/code file to edit it here."
            disabled={!selectedPath}
            spellCheck={false}
            className="min-h-0 flex-1 resize-none font-mono text-sm leading-5"
          />

          {/* Compact selection toolbar — Files page only */}
          {selPopup && (
            <div
              data-monochrome-surface="files-selection-tools"
              className="fixed z-50 flex items-center gap-0.5 rounded-full border border-accent-copper/40 bg-panel/95 px-1 py-0.5 shadow-lg backdrop-blur [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&]:backdrop-blur-none"
              style={{ top: selPopup.top, left: selPopup.left }}
              onMouseDown={(e) => e.preventDefault()}
            >
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent-copper/15"
                onClick={() => void copySelection(selPopup.text)}
                title="Copy"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
              <span className="h-3 w-px bg-border" aria-hidden />
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium text-accent-copper transition-colors hover:bg-accent-copper/15"
                onClick={() => attachSelectionForAsk(selPopup.text)}
                title={askAssistantAboutLabel('this selection', assistantName)}
              >
                <Sparkles className="h-3 w-3" />
                {askLabel}
              </button>
            </div>
          )}

          {/* Mini Files Jarvis panel — isolated from main Chat */}
          <div
            data-monochrome-surface="files-jarvis"
            className={cn(
              'flex shrink-0 flex-col rounded-lg border border-border bg-panel shadow-soft [html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:shadow-none',
              workspace.askCollapsed ? 'min-h-0' : 'max-h-[42%] min-h-[140px]',
            )}
          >
            <div
              className={cn(
                'flex items-center gap-2 px-2.5 py-1.5',
                !workspace.askCollapsed && 'border-b border-border',
              )}
            >
              <MessageSquare className="h-3.5 w-3.5 text-accent-copper" />
              <span className="text-metadata font-medium text-foreground">
                {askLabel} (this file)
              </span>
              <span className="text-[10px] text-muted-foreground">
                short answers · stays on Files
              </span>
              <label className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={workspace.askOpenByDefault}
                  onChange={(event) => setAskPanelDefault(projectId, event.target.checked)}
                />
                Open by default
              </label>
              {!workspace.askCollapsed && miniLines.length > 0 && (
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => patchActiveTab({ assistantLines: [] })}
                >
                  Clear
                </button>
              )}
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setAskPanelCollapsed(projectId, !workspace.askCollapsed)}
                aria-label={
                  workspace.askCollapsed
                    ? `Expand ${askLabel} file panel`
                    : `Collapse ${askLabel} file panel`
                }
                aria-expanded={!workspace.askCollapsed}
              >
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    workspace.askCollapsed && '-rotate-90',
                  )}
                />
              </button>
            </div>

            {!workspace.askCollapsed && (
              <>
                <div
                  ref={miniScrollRef}
                  className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2.5 py-2"
                >
                  {miniLines.length === 0 ? (
                    <p className="text-metadata text-muted-foreground">
                      Highlight code → <span className="text-foreground">{askLabel}</span>, then
                      send a short question.
                    </p>
                  ) : (
                    miniLines.map((line) => (
                      <div
                        key={line.id}
                        className={cn(
                          'rounded-md px-2 py-1.5 text-[12px] leading-snug whitespace-pre-wrap break-words',
                          line.role === 'user' && 'bg-muted/60 text-foreground',
                          line.role === 'assistant' &&
                            'border border-accent-copper/20 bg-accent-copper/5 text-foreground',
                          line.role === 'error' &&
                            'border border-destructive/30 bg-destructive/10 text-destructive',
                        )}
                      >
                        <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {line.role === 'user'
                            ? 'You'
                            : line.role === 'error'
                              ? 'Error'
                              : 'Jarvis'}
                        </span>
                        {line.text || (miniBusy && line.role === 'assistant' ? '…' : '')}
                      </div>
                    ))
                  )}
                </div>

                {attachedSelection ? (
                  <div className="mx-2 mb-1 flex items-start gap-1.5 rounded-md border border-accent-copper/30 bg-accent-copper/10 px-2 py-1">
                    <Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-accent-copper" />
                    <pre className="min-w-0 flex-1 overflow-hidden text-[11px] leading-snug text-foreground/90 line-clamp-3 whitespace-pre-wrap font-mono">
                      {attachedSelection.slice(0, 400)}
                      {attachedSelection.length > 400 ? '…' : ''}
                    </pre>
                    <button
                      type="button"
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => patchActiveTab({ attachedSelection: '' })}
                      aria-label="Clear attached selection"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ) : null}

                <div className="flex gap-1.5 border-t border-border p-2">
                  <Input
                    value={askDraft}
                    onChange={(e) => patchActiveTab({ askDraft: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void askJarvisMini();
                      }
                    }}
                    aria-label="Question about selected file content"
                    placeholder="Ask about the selection…"
                    disabled={miniBusy}
                    className="h-8 text-sm"
                  />
                  <Button
                    variant="accent"
                    size="sm"
                    onClick={() => void askJarvisMini()}
                    disabled={miniBusy || !selectedPath || !content.trim()}
                    className="gap-1 shrink-0"
                  >
                    {miniBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                    Send
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default FilesPage;
