/**
 * Themed desktop file explorer for VibeSpace.
 * OS-like places sidebar, list + media previews, mini Jarvis file search.
 */
import * as React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  Folder,
  HardDrive,
  Home,
  Image as ImageIcon,
  Loader2,
  Monitor,
  Music,
  RefreshCw,
  Search,
  Sparkles,
  File,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn, isTauri } from '@/lib/utils';
import {
  describeFsError,
  listDirectory,
  readImageFileBase64,
  readTextFileSample,
  statProjectPath,
  type FsEntry,
} from '@/lib/fs';
import { useAgentStore } from '@/stores/agents';
import { findProtectedJarvisAgent } from '@/lib/jarvis/identity';
import { useAuthStore } from '@/stores/auth';
import { buildModelPickerGroups } from '@/lib/ai/useAccessibleChatModels';
import { basename, dirname } from './projectFiles';
import { resolveExplorerPlaces, type ExplorerPlace } from './fileExplorerPlaces';
import { isImagePath, isTextPath, isVideoPath, type SearchHit } from './fileExplorerSearch';
import {
  cancelExplorerSearchJob,
  clearExplorerSearchHits,
  getExplorerSearchState,
  setExplorerSearchModel,
  setExplorerSearchPanelOpen,
  setExplorerSearchQuery,
  startExplorerSearch,
  subscribeExplorerSearch,
} from './fileExplorerSearchRuntime';
import {
  EXPLORER_AUTO_GRID_MAX_MEDIA,
  EXPLORER_PREVIEW_MAX_BYTES,
  EXPLORER_THUMB_MAX_BYTES,
  isWithinThumbBudget,
  shouldAutoGridMedia,
  shouldLoadExplorerImage,
  withExplorerImageSlot,
} from './fileExplorerMediaLimits';
import { groupEntriesByDate } from './fileExplorerDateGroups';
import { nextExplorerSelection, seedSelectionFromHits } from './fileExplorerSelection';
import {
  cancelFileExplorer,
  getActiveFileExplorer,
  resolveFileExplorer,
  subscribeFileExplorer,
  type FileExplorerMode,
  type FileExplorerSession,
} from './fileExplorerStore';

/** Max UTF-8 sample for side-pane text preview (keeps WebView light). */
const EXPLORER_TEXT_PREVIEW_BYTES = 12 * 1024;
/** Native directory reads should never strand the picker on an endless spinner. */
const EXPLORER_DIRECTORY_LOAD_TIMEOUT_MS = 4_000;
/** Places are helpful chrome, but they must not block the first useful file listing. */
const EXPLORER_PLACES_START_TIMEOUT_MS = 800;

function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = globalThis.setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve(null);
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (finished) return;
        finished = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (finished) return;
        finished = true;
        globalThis.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function imageDataUrl(mimeType: string | undefined, data: string): string {
  const mime = (mimeType && mimeType.trim()) || 'image/png';
  return `data:${mime};base64,${data}`;
}

function parentPath(path: string): string | null {
  if (!path) return null;
  const normalized = path.replace(/[\\/]+$/, '');
  const parent = dirname(normalized);
  if (!parent || parent === normalized) return null;
  if (parent === '/' || /^[A-Za-z]:\\?$/.test(parent) || /^[A-Za-z]:$/.test(parent)) {
    if (normalized === parent || normalized === `${parent}\\` || normalized === `${parent}/`) {
      return null;
    }
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`;
    return parent;
  }
  return parent;
}

function pickerStatPath(path: string): string {
  // fs_list_dir returns canonical Windows drive paths; strict stat accepts drive syntax.
  // Do not rewrite UNC/device paths or the identity returned to the picker caller.
  return path.startsWith('\\\\?\\') && /^[A-Za-z]:[\\/]/.test(path.slice(4)) ? path.slice(4) : path;
}

/** Alphabetical fallback only used when date metadata is entirely missing after grouping. */
function sortEntriesAlpha(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function matchesExtension(entry: FsEntry, extensions?: string[]): boolean {
  if (entry.isDir || !extensions?.length) return true;
  const lower = entry.name.toLowerCase();
  return extensions.some((ext) => lower.endsWith(`.${ext.toLowerCase()}`));
}

function placeIcon(icon: ExplorerPlace['icon']) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (icon) {
    case 'home':
      return <Home className={cls} />;
    case 'desktop':
      return <Monitor className={cls} />;
    case 'documents':
      return <FileText className={cls} />;
    case 'pictures':
      return <ImageIcon className={cls} />;
    case 'videos':
      return <Film className={cls} />;
    case 'downloads':
      return <Download className={cls} />;
    case 'music':
      return <Music className={cls} />;
    default:
      return <HardDrive className={cls} />;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CONTAINED_FILE_EXPLORER_SESSION: FileExplorerSession = Object.freeze({
  id: 0,
  mode: 'folder',
  title: 'Choose folder',
  initialPath: null,
  root: null,
  resolve: () => undefined,
});

/** MonoChrome-only flattening for sticky date-group headers (drops blur + solid bg). */
export const FILE_EXPLORER_MONOCHROME_STICKY_HEADER_CLASS =
  '[html[data-theme=monochrome]_&]:backdrop-blur-none [html[data-theme=monochrome]_&]:bg-background';

export function FileExplorerHost({
  runtimeEffectsEnabled = true,
}: {
  runtimeEffectsEnabled?: boolean;
} = {}) {
  const [activeSession, setActiveSession] = React.useState<FileExplorerSession | null>(() =>
    getActiveFileExplorer(),
  );

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    return subscribeFileExplorer(() => {
      setActiveSession(getActiveFileExplorer());
    });
  }, [runtimeEffectsEnabled]);

  const session = runtimeEffectsEnabled ? activeSession : CONTAINED_FILE_EXPLORER_SESSION;
  if (!session) return null;
  return (
    <FileExplorerDialog
      key={session.id}
      session={session}
      runtimeEffectsEnabled={runtimeEffectsEnabled}
    />
  );
}

function FileExplorerDialog({
  session,
  runtimeEffectsEnabled,
}: {
  session: FileExplorerSession;
  runtimeEffectsEnabled: boolean;
}) {
  const mode = session.mode;
  const constrainedRoot = session.root?.trim() || null;

  const [currentPath, setCurrentPath] = React.useState('');
  const [pathDraft, setPathDraft] = React.useState('');
  const [entries, setEntries] = React.useState<FsEntry[]>([]);
  const [loading, setLoading] = React.useState(runtimeEffectsEnabled);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [confirming, setConfirming] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
  const [statusLine, setStatusLine] = React.useState('');
  const [places, setPlaces] = React.useState<ExplorerPlace[]>([]);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [previewText, setPreviewText] = React.useState<string | null>(null);
  const [previewKind, setPreviewKind] = React.useState<
    'image' | 'video' | 'text' | 'none' | 'too_large' | 'loading' | 'error'
  >('none');
  const [viewMode, setViewMode] = React.useState<'list' | 'grid'>('grid');
  const loadRequestRef = React.useRef(0);
  const pathDraftRef = React.useRef('');
  const pathEditedRef = React.useRef(false);

  // Mini Jarvis search — module store (survives close/reopen; does not touch main Chat)
  const [searchState, setSearchState] = React.useState(() =>
    getExplorerSearchState(constrainedRoot),
  );
  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    return subscribeExplorerSearch(() => {
      setSearchState(getExplorerSearchState(constrainedRoot));
    });
  }, [runtimeEffectsEnabled, constrainedRoot]);

  const searchQuery = searchState.query;
  const searchBusy = searchState.busy;
  const searchStatus = searchState.status;
  const searchHits = React.useMemo(
    () => searchState.hits.filter((hit) => matchesExtension(hit, session.extensions)),
    [searchState.hits, session.extensions],
  );
  const searchProvider = searchState.provider;
  const searchModel = searchState.model;

  const jarvisAgent = useAgentStore(
    (s) => findProtectedJarvisAgent(Object.values(s.agents)) ?? null,
  );
  const apiKeys = useAuthStore((s) => s.apiKeys);
  const chatModelSelection = useAuthStore((s) => s.chatModelSelection);
  const offlineMode = useAuthStore((s) => s.offlineMode);
  const plan = useAuthStore((s) => s.plan);
  const defaultLocalModel = useAuthStore((s) => s.defaultLocalModel);

  const modelGroups = React.useMemo(
    () =>
      buildModelPickerGroups({
        apiKeys,
        offlineMode,
        plan,
        defaultLocalModel,
      }),
    [apiKeys, offlineMode, plan, defaultLocalModel],
  );
  const flatModels = React.useMemo(() => modelGroups.flatMap((g) => g.options), [modelGroups]);

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    if (searchProvider && searchModel) return;
    if (chatModelSelection.mode === 'single') {
      setExplorerSearchModel(chatModelSelection.providerId, chatModelSelection.modelId);
      return;
    }
    const first = flatModels[0];
    if (first) {
      setExplorerSearchModel(first.provider, first.modelId);
    }
  }, [chatModelSelection, flatModels, runtimeEffectsEnabled, searchModel, searchProvider]);

  // Keep search panel open while busy/has hits; seed selection without
  // clobbering a user click that is still among the hits.
  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    if (searchHits.length > 0 || searchBusy) {
      setExplorerSearchPanelOpen(true);
    }
    if (searchHits.length === 0) return;
    const hitPaths = searchHits.filter((h) => mode === 'folder' || !h.isDir).map((h) => h.path);
    setSelected((prev) => seedSelectionFromHits(prev, hitPaths));
  }, [runtimeEffectsEnabled, searchHits, searchBusy, mode]);

  const title =
    session.title ??
    (mode === 'folder' ? 'Choose folder' : mode === 'files' ? 'Choose files' : 'Choose file');

  const loadDir = React.useCallback(
    async (path: string) => {
      if (!runtimeEffectsEnabled) return;
      const requestId = ++loadRequestRef.current;
      const clean = path.trim();
      setSelected([]);
      setSelectionError(null);
      setEntries([]);
      setCurrentPath(clean);
      pathDraftRef.current = clean;
      setPathDraft(clean);
      setStatusLine('');
      if (!clean) {
        setError('Enter an absolute folder path.');
        setEntries([]);
        setLoading(false);
        setStatusLine('');
        return;
      }
      setLoading(true);
      setError(null);
      // Do NOT clear mini-Jarvis hits here — search is independent and must survive
      // folder navigation + dialog close/reopen.
      const listed = await resolveWithin(
        listDirectory(clean, constrainedRoot ? { root: constrainedRoot } : {}),
        EXPLORER_DIRECTORY_LOAD_TIMEOUT_MS,
      );
      if (requestId !== loadRequestRef.current) return;
      setLoading(false);
      if (!listed) {
        setEntries([]);
        setError('This folder is taking too long to load. Try Refresh or enter another path.');
        setStatusLine('');
        return;
      }
      if (!listed.ok) {
        setEntries([]);
        setError(describeFsError(listed.error));
        setStatusLine('');
        return;
      }
      // Keep raw listing order decision in the view layer: date groups for
      // normal browsing (Downloads-style), score order for search hits.
      const next = listed.entries.filter((e) => matchesExtension(e, session.extensions));
      setCurrentPath(listed.path);
      if (pathDraftRef.current === clean) {
        pathDraftRef.current = listed.path;
        setPathDraft(listed.path);
      }
      setEntries(next);
      const dirs = next.filter((e) => e.isDir).length;
      const files = next.length - dirs;
      setStatusLine(`${next.length} items · ${dirs} folders · ${files} files`);

      // Auto grid only for modest media folders. Huge Pictures dumps stay list
      // so we do not mount dozens of full-file thumbnail readers at once.
      // User can still switch to Grid manually; thumbs remain size/concurrency capped.
      const mediaCount = next.filter(
        (e) => !e.isDir && (isImagePath(e.path) || isVideoPath(e.path)),
      ).length;
      if (shouldAutoGridMedia(mediaCount)) {
        setViewMode('grid');
      } else if (mediaCount > EXPLORER_AUTO_GRID_MAX_MEDIA) {
        setViewMode('list');
      }
    },
    [constrainedRoot, runtimeEffectsEnabled, session.extensions],
  );

  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    let cancelled = false;
    const startupRequestId = loadRequestRef.current;
    const explicitStart =
      (session.initialPath && session.initialPath.trim()) || constrainedRoot || '';
    const resolvedPlaces = resolveExplorerPlaces();
    // The deadline bounds startup, not the lifetime of optional Places discovery.
    void resolvedPlaces.then(
      (nextPlaces) => {
        if (!cancelled) setPlaces(nextPlaces);
      },
      () => undefined,
    );
    const placesPromise = resolveWithin(resolvedPlaces, EXPLORER_PLACES_START_TIMEOUT_MS);

    // A known initial/root path is the useful content: start it immediately instead of
    // serially waiting on every optional OS quick-access path first.
    if (explicitStart) void loadDir(explicitStart);

    void (async () => {
      const nextPlaces = (await placesPromise) ?? [];
      if (cancelled) return;
      if (explicitStart || loadRequestRef.current !== startupRequestId) return;
      if (pathEditedRef.current) {
        setLoading(false);
        return;
      }

      const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
      const fallbackHome = isWindows ? 'C:\\Users' : isTauri ? '/' : '/home';
      const home =
        nextPlaces.find((p) => p.id === 'home')?.path ?? nextPlaces[0]?.path ?? fallbackHome;
      if (home) await loadDir(home);
      else {
        setLoading(false);
        setError('Could not resolve a starting folder.');
      }
    })();
    return () => {
      cancelled = true;
      loadRequestRef.current += 1;
    };
  }, [session.initialPath, constrainedRoot, loadDir, runtimeEffectsEnabled]);

  // Side-pane preview: images (screenshots), text samples, videos
  React.useEffect(() => {
    if (!runtimeEffectsEnabled) return;
    let cancelled = false;
    setPreviewUrl(null);
    setPreviewText(null);
    setPreviewKind('none');
    const path = selected[0];
    if (!path || selected.length !== 1) return;

    if (isVideoPath(path)) {
      setPreviewKind('video');
      return;
    }

    const size =
      entries.find((e) => e.path === path)?.size ?? searchHits.find((h) => h.path === path)?.size;
    const access = constrainedRoot ? { root: constrainedRoot } : {};
    const hitSnippet = searchHits.find((h) => h.path === path)?.snippet;

    if (isImagePath(path)) {
      if (!shouldLoadExplorerImage(size, EXPLORER_PREVIEW_MAX_BYTES)) {
        setPreviewKind('too_large');
        return;
      }
      setPreviewKind('loading');
      void (async () => {
        const img = await withExplorerImageSlot(() => readImageFileBase64(path, access));
        if (cancelled) return;
        if (!img.ok) {
          setPreviewKind(img.error.code === 'too_large' ? 'too_large' : 'error');
          setPreviewUrl(null);
          return;
        }
        if (!shouldLoadExplorerImage(img.size, EXPLORER_PREVIEW_MAX_BYTES)) {
          setPreviewKind('too_large');
          setPreviewUrl(null);
          return;
        }
        // Defensive: some IPC paths may omit mime; data URL still needs a type.
        const raw = img as { mimeType?: string; mime_type?: string; data: string };
        const mime = raw.mimeType || raw.mime_type || 'image/png';
        setPreviewUrl(imageDataUrl(mime, img.data));
        setPreviewKind('image');
      })();
      return () => {
        cancelled = true;
      };
    }

    if (isTextPath(path)) {
      setPreviewKind('loading');
      void (async () => {
        const sample = await readTextFileSample(path, EXPLORER_TEXT_PREVIEW_BYTES, access);
        if (cancelled) return;
        if (sample.ok && sample.content.trim()) {
          setPreviewText(sample.content);
          setPreviewKind('text');
          return;
        }
        // Fall back to search snippet when sample is empty or unreadable
        if (hitSnippet) {
          setPreviewText(hitSnippet);
          setPreviewKind('text');
          return;
        }
        setPreviewKind(sample.ok ? 'none' : 'error');
      })();
      return () => {
        cancelled = true;
      };
    }

    // Non-previewable type: still surface search snippet if we have one
    if (hitSnippet) {
      setPreviewText(hitSnippet);
      setPreviewKind('text');
    }
  }, [selected, constrainedRoot, entries, runtimeEffectsEnabled, searchHits]);

  const goUp = () => {
    const parent = parentPath(currentPath);
    if (parent) void loadDir(parent);
  };

  /** Select entry for highlight + side preview. Files work in all modes (incl. folder pick). */
  const selectEntry = (entry: { path: string; isDir: boolean }, multiToggle: boolean) => {
    setSelectionError(null);
    setSelected((prev) => {
      const next = nextExplorerSelection(mode, entry, prev, multiToggle);
      return next ?? prev;
    });
  };

  const confirm = async (explicitPaths?: string[]) => {
    if (!runtimeEffectsEnabled || loading || error || confirming) return;
    let paths = explicitPaths ?? selected;
    if (mode === 'folder') {
      const selectedFolder = selected.find((p) => {
        const hit = entries.find((e) => e.path === p) ?? searchHits.find((h) => h.path === p);
        return hit?.isDir || entries.some((e) => e.path === p && e.isDir);
      });
      const path = selectedFolder || currentPath;
      if (!path) return;
      paths = [path];
    }
    if (paths.length === 0) return;
    const requestId = loadRequestRef.current;
    setConfirming(true);
    setSelectionError(null);
    const checks = await resolveWithin(
      Promise.all(
        paths.map((path) => {
          const statPath = pickerStatPath(path);
          return statProjectPath(statPath, false, {
            // Native stat requires a capability root even for an unconstrained picker.
            // Keep an existing constraint; otherwise validate only the chosen item's folder.
            root: constrainedRoot
              ? pickerStatPath(constrainedRoot)
              : mode === 'folder'
                ? statPath
                : parentPath(statPath),
          });
        }),
      ),
      EXPLORER_DIRECTORY_LOAD_TIMEOUT_MS,
    );
    if (getActiveFileExplorer()?.id !== session.id) return;
    setConfirming(false);
    if (requestId !== loadRequestRef.current) return;
    const failed = checks?.find(
      (check) => !check.ok || check.kind !== (mode === 'folder' ? 'directory' : 'file'),
    );
    if (!checks || failed) {
      setSelected([]);
      setSelectionError(
        !checks
          ? 'Selection check timed out. Try again.'
          : failed && !failed.ok
            ? describeFsError(failed.error)
            : 'The selected item is no longer the expected file type.',
      );
      return;
    }
    resolveFileExplorer({ ok: true, paths: [...paths] });
  };

  const canConfirm =
    !loading &&
    !error &&
    !confirming &&
    (mode === 'folder' ? Boolean(currentPath) : selected.length > 0);

  // Hits stay listed in the explorer itself until the user clears them
  const showSearchResults = searchHits.length > 0 || searchBusy;

  const runJarvisSearch = () => {
    if (!runtimeEffectsEnabled) return;
    const raw = searchQuery.trim();
    if (!raw) return;
    const scope = currentPath || places.find((p) => p.id === 'home')?.path || places[0]?.path || '';
    void startExplorerSearch({
      query: raw,
      scopePath: scope,
      accessRoot: constrainedRoot,
      placePaths: places.map((p) => ({ id: p.id, label: p.label, path: p.path })),
      jarvisAgent,
      provider: searchProvider,
      model: searchModel,
    }).then(() => {
      // Selection is reconciled by the scoped subscription; a closed session must
      // never publish into a replacement picker after this search completes.
    });
  };

  const listSource: Array<
    FsEntry | (SearchHit & { isDir: boolean; modifiedMs?: number; createdMs?: number })
  > = showSearchResults
    ? searchHits.map((h) => ({
        name: h.name,
        path: h.path,
        isDir: h.isDir,
        size: h.size,
      }))
    : entries;

  // Date sections (Today / Yesterday / …) for normal folder browsing only.
  // Search hits stay score-ranked without date buckets.
  const dateSections = React.useMemo(() => {
    if (showSearchResults) return null;
    const sections = groupEntriesByDate(listSource);
    // If every entry lacks timestamps, fall back to a single A–Z list.
    if (sections.length === 1 && sections[0]?.id === 'unknown') {
      return null;
    }
    return sections;
  }, [listSource, showSearchResults]);

  const alphaFallback = React.useMemo(() => {
    if (showSearchResults || dateSections) return null;
    return sortEntriesAlpha(listSource as FsEntry[]);
  }, [listSource, showSearchResults, dateSections]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && runtimeEffectsEnabled) cancelFileExplorer();
      }}
    >
      <DialogContent
        data-monochrome-route="file-explorer"
        data-monochrome-surface="file-explorer-dialog"
        className={cn(
          'flex h-[min(760px,92vh)] w-[min(960px,97vw)] max-w-[960px] flex-col gap-0 overflow-hidden p-0',
          'border-accent-copper/30 bg-panel shadow-[0_28px_90px_-36px_hsl(var(--accent-copper)/0.6)]',
          '[html[data-theme=monochrome]_&]:rounded-sm [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:font-sans [html[data-theme=monochrome]_&]:shadow-none',
        )}
        hideClose={false}
      >
        <DialogHeader className="shrink-0 space-y-1 border-b border-border bg-paper-soft/90 px-5 py-3 pr-12 [html[data-theme=monochrome]_&]:space-y-0 [html[data-theme=monochrome]_&]:bg-panel [html[data-theme=monochrome]_&]:px-3 [html[data-theme=monochrome]_&]:py-2">
          <DialogTitle className="font-display text-lg text-foreground [html[data-theme=monochrome]_&]:font-mono [html[data-theme=monochrome]_&]:text-sm [html[data-theme=monochrome]_&]:uppercase [html[data-theme=monochrome]_&]:tracking-wide">
            {title}
          </DialogTitle>
          <DialogDescription className="text-secondary text-muted-foreground">
            Places · files & folders · previews · mini Jarvis search
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Places sidebar */}
          <aside
            data-monochrome-surface="file-places"
            className="flex w-[148px] shrink-0 flex-col border-r border-border bg-elevated/30 py-2 [html[data-theme=monochrome]_&]:bg-panel"
          >
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Places
            </div>
            <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
              {places.map((place) => {
                const active =
                  currentPath.replace(/[\\/]+$/, '').toLowerCase() ===
                  place.path.replace(/[\\/]+$/, '').toLowerCase();
                return (
                  <button
                    key={place.id}
                    type="button"
                    onClick={() => void loadDir(place.path)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                      'hover:bg-accent-copper/10',
                      active && 'bg-accent-copper/15 text-foreground ring-1 ring-accent-copper/35',
                      !active && 'text-muted-foreground',
                    )}
                    title={place.path}
                  >
                    {placeIcon(place.icon)}
                    <span className="truncate">{place.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {/* Toolbar */}
            <div className="flex shrink-0 items-center gap-1 border-b border-border bg-elevated/40 px-2 py-1.5 [html[data-theme=monochrome]_&]:bg-panel">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={goUp}
                title="Up"
                aria-label="Up"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={() => void loadDir(currentPath || pathDraft)}
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
              <form
                className="flex min-w-0 flex-1 gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  void loadDir(pathDraft);
                }}
              >
                <Input
                  value={pathDraft}
                  onChange={(e) => {
                    pathEditedRef.current = true;
                    pathDraftRef.current = e.target.value;
                    setPathDraft(e.target.value);
                  }}
                  className="h-8 min-w-0 flex-1 font-mono text-metadata"
                  spellCheck={false}
                  aria-label="Current path"
                />
                <Button type="submit" size="sm" variant="secondary">
                  Go
                </Button>
              </form>
              <div className="flex rounded-md border border-border p-0.5">
                <button
                  type="button"
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px]',
                    viewMode === 'list'
                      ? 'bg-accent-copper/20 text-foreground'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => setViewMode('list')}
                >
                  List
                </button>
                <button
                  type="button"
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px]',
                    viewMode === 'grid'
                      ? 'bg-accent-copper/20 text-foreground'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => setViewMode('grid')}
                >
                  Grid
                </button>
              </div>
            </div>

            {/* Open folder status — top (was at bottom) */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-paper-soft/80 px-3 py-1.5 [html[data-theme=monochrome]_&]:bg-panel">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground"
                title={currentPath}
              >
                {mode === 'folder'
                  ? `Open folder: ${basename(currentPath) || currentPath || '—'}`
                  : currentPath || '—'}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {searchBusy
                  ? `Search · ${searchHits.length} hit${searchHits.length === 1 ? '' : 's'}`
                  : searchHits.length > 0
                    ? `Search · ${searchHits.length} hit${searchHits.length === 1 ? '' : 's'}`
                    : statusLine || '—'}
              </span>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Main list / grid */}
              <div
                data-monochrome-surface="file-list"
                className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background/40 px-1.5 py-1.5 [html[data-theme=monochrome]_&]:bg-background"
              >
                {loading ? (
                  <div
                    role="status"
                    className="flex h-full min-h-[200px] items-center justify-center gap-2 text-muted-foreground"
                  >
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : error ? (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-4 text-center">
                    <HardDrive className="h-8 w-8 text-muted-foreground/60 [html[data-theme=monochrome]_&]:text-muted-foreground" />
                    <p role="alert" className="text-secondary text-destructive">
                      {error}
                    </p>
                  </div>
                ) : listSource.length === 0 ? (
                  <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-secondary text-muted-foreground">
                    {searchBusy ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin text-accent-copper" />
                        <span>{searchStatus || 'Searching…'}</span>
                        <span className="text-[10px]">
                          You can close this window — search keeps running.
                        </span>
                      </>
                    ) : showSearchResults ? (
                      'No search hits.'
                    ) : (
                      'This folder is empty.'
                    )}
                  </div>
                ) : viewMode === 'grid' ? (
                  <div className="space-y-3 p-1">
                    {(
                      dateSections ?? [
                        { id: 'all', label: '', entries: alphaFallback ?? listSource },
                      ]
                    ).map((section) => {
                      let imageOrdinal = 0;
                      return (
                        <div key={section.id}>
                          {section.label ? (
                            <div
                              className={cn(
                                'sticky top-0 z-[1] mb-1.5 bg-background/90 px-1 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur-sm',
                                FILE_EXPLORER_MONOCHROME_STICKY_HEADER_CLASS,
                              )}
                            >
                              {section.label}
                            </div>
                          ) : null}
                          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
                            {section.entries.map((entry) => {
                              const isImage = !entry.isDir && isImagePath(entry.path);
                              const thumbIndex = isImage ? imageOrdinal++ : -1;
                              const allowThumb =
                                isImage &&
                                isWithinThumbBudget(thumbIndex) &&
                                shouldLoadExplorerImage(entry.size, EXPLORER_THUMB_MAX_BYTES);
                              return (
                                <EntryTile
                                  key={entry.path}
                                  entry={entry}
                                  selected={selected.includes(entry.path)}
                                  mode={mode}
                                  constrainedRoot={constrainedRoot}
                                  allowThumb={allowThumb}
                                  hit={searchHits.find((h) => h.path === entry.path)}
                                  onOpen={() => {
                                    if (entry.isDir) {
                                      // Grid: open folder on click (same as before); also select in folder mode
                                      void loadDir(entry.path);
                                      if (mode === 'folder') selectEntry(entry, false);
                                    } else {
                                      // Files always selectable for preview (all modes, including search hits)
                                      selectEntry(entry, mode === 'files');
                                    }
                                  }}
                                  onActivate={() => {
                                    if (entry.isDir) {
                                      void loadDir(entry.path);
                                      if (mode === 'folder') selectEntry(entry, false);
                                      return;
                                    }
                                    if (mode === 'folder') {
                                      // Preview only — do not confirm a file as the project folder
                                      return;
                                    }
                                    void confirm([entry.path]);
                                  }}
                                />
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div
                    className="space-y-2"
                    role="listbox"
                    aria-label="Folder contents"
                    aria-multiselectable={mode === 'files'}
                  >
                    {(
                      dateSections ?? [
                        { id: 'all', label: '', entries: alphaFallback ?? listSource },
                      ]
                    ).map((section) => (
                      <div key={section.id}>
                        {section.label ? (
                          <div
                            className={cn(
                              'sticky top-0 z-[1] bg-background/90 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur-sm',
                              FILE_EXPLORER_MONOCHROME_STICKY_HEADER_CLASS,
                            )}
                          >
                            {section.label}
                          </div>
                        ) : null}
                        <ul role="presentation" className="space-y-0.5">
                          {section.entries.map((entry) => {
                            const isSelected = selected.includes(entry.path);
                            const hit = searchHits.find((h) => h.path === entry.path);
                            return (
                              <li key={entry.path} role="presentation">
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  onClick={() => {
                                    if (entry.isDir) {
                                      selectEntry(entry, false);
                                      return;
                                    }
                                    // Files always selectable so search hits + previews work in every mode
                                    selectEntry(entry, mode === 'files');
                                  }}
                                  onDoubleClick={() => {
                                    if (entry.isDir) {
                                      void loadDir(entry.path);
                                      if (mode === 'folder') selectEntry(entry, false);
                                      return;
                                    }
                                    if (mode === 'folder') {
                                      // Keep selection for preview; folder confirm stays on open folder
                                      selectEntry(entry, false);
                                      return;
                                    }
                                    void confirm([entry.path]);
                                  }}
                                  className={cn(
                                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
                                    'hover:bg-accent-copper/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                                    isSelected &&
                                      'bg-accent-copper/18 ring-1 ring-accent-copper/45',
                                  )}
                                >
                                  <EntryIcon entry={entry} />
                                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                    {entry.name}
                                  </span>
                                  {hit?.snippet ? (
                                    <span className="hidden max-w-[180px] truncate text-[10px] text-muted-foreground md:inline">
                                      {hit.snippet}
                                    </span>
                                  ) : null}
                                  {entry.isDir ? (
                                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 [html[data-theme=monochrome]_&]:text-muted-foreground" />
                                  ) : entry.size != null ? (
                                    <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                                      {formatSize(entry.size)}
                                    </span>
                                  ) : null}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Preview pane */}
              <div
                data-monochrome-surface="file-preview"
                className="hidden w-[200px] shrink-0 flex-col border-l border-border bg-elevated/20 p-2 md:flex [html[data-theme=monochrome]_&]:bg-panel"
              >
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Preview
                </div>
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-background/50 p-2 [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-background">
                  {previewKind === 'loading' ? (
                    <div className="flex flex-col items-center gap-2 text-metadata text-muted-foreground">
                      <Loader2 className="h-6 w-6 animate-spin" />
                      <span>Loading preview…</span>
                    </div>
                  ) : previewKind === 'image' && previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Preview"
                      className="max-h-full max-w-full rounded object-contain"
                      loading="lazy"
                      decoding="async"
                    />
                  ) : previewKind === 'text' && previewText ? (
                    <div className="flex h-full min-h-0 w-full flex-col gap-1 overflow-hidden">
                      <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                        {selected[0] ? basename(selected[0]) : 'Text'}
                      </span>
                      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded bg-background/80 p-1.5 font-mono text-[10px] leading-snug text-foreground/90 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:text-foreground">
                        {previewText}
                      </pre>
                    </div>
                  ) : previewKind === 'too_large' ? (
                    <div className="flex flex-col items-center gap-2 text-center text-metadata text-muted-foreground">
                      <ImageIcon className="h-10 w-10 text-accent-copper" />
                      <span>Image too large to preview</span>
                      <span className="font-mono text-[10px] break-all">
                        {selected[0] ? basename(selected[0]) : ''}
                      </span>
                      {(() => {
                        const size =
                          entries.find((e) => e.path === selected[0])?.size ??
                          searchHits.find((h) => h.path === selected[0])?.size;
                        return size != null ? (
                          <span className="font-mono text-[10px]">{formatSize(size)}</span>
                        ) : null;
                      })()}
                    </div>
                  ) : previewKind === 'error' ? (
                    <div className="flex flex-col items-center gap-2 text-center text-metadata text-muted-foreground">
                      <File className="h-10 w-10" />
                      <span>Could not load preview</span>
                      <span className="font-mono text-[10px] break-all">
                        {selected[0] ? basename(selected[0]) : ''}
                      </span>
                    </div>
                  ) : previewKind === 'video' ? (
                    <div className="flex flex-col items-center gap-2 text-center text-metadata text-muted-foreground">
                      <Film className="h-10 w-10 text-accent-honey" />
                      <span>Video file</span>
                      <span className="font-mono text-[10px] break-all">
                        {selected[0] ? basename(selected[0]) : ''}
                      </span>
                    </div>
                  ) : selected[0] ? (
                    <div className="flex flex-col items-center gap-2 text-center text-metadata text-muted-foreground">
                      <File className="h-10 w-10" />
                      <span className="break-all font-mono text-[11px] text-foreground">
                        {basename(selected[0])}
                      </span>
                    </div>
                  ) : (
                    <span className="text-metadata text-muted-foreground">Select a file</span>
                  )}
                </div>
              </div>
            </div>

            {/* Mini Jarvis file search — fixed at bottom (where open-folder status used to sit) */}
            <div
              data-monochrome-surface="file-search"
              className="shrink-0 border-t border-accent-copper/25 bg-paper-soft/95 px-3 py-2 [html[data-theme=monochrome]_&]:border-border-mid [html[data-theme=monochrome]_&]:bg-panel"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
                <span className="text-[11px] font-semibold text-foreground">
                  Mini Jarvis file search
                </span>
                {searchBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin text-accent-copper" />
                ) : searchHits.length > 0 ? (
                  <span className="rounded-full bg-accent-copper/20 px-1.5 py-0 text-[10px] tabular-nums text-foreground">
                    {searchHits.length}
                  </span>
                ) : null}
                <span
                  className="ml-auto hidden max-w-[45%] truncate text-[10px] text-muted-foreground sm:inline"
                  title={searchState.clueSummary || searchStatus}
                >
                  {searchBusy || searchHits.length > 0
                    ? searchStatus || searchState.clueSummary
                    : 'Searches names + text content across Home/Documents/… (not inside pictures)'}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <select
                  className="h-8 max-w-[150px] rounded-md border border-input bg-background px-2 font-mono text-[11px] text-foreground"
                  value={`${searchProvider}::${searchModel}`}
                  onChange={(e) => {
                    const [p, ...rest] = e.target.value.split('::');
                    setExplorerSearchModel(p ?? '', rest.join('::'));
                  }}
                  aria-label="Search model"
                >
                  {flatModels.length === 0 ? (
                    <option value="">No models</option>
                  ) : (
                    flatModels.map((opt) => (
                      <option key={opt.id} value={`${opt.provider}::${opt.modelId}`}>
                        {opt.label}
                      </option>
                    ))
                  )}
                </select>
                <Input
                  value={searchQuery}
                  onChange={(e) => setExplorerSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runJarvisSearch();
                  }}
                  placeholder="e.g. txt file with Deepgram API keys  ·  type:pdf in:documents invoice"
                  className="h-8 min-w-[220px] flex-1 text-sm"
                  disabled={searchBusy}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1 bg-foreground text-background hover:bg-foreground/90"
                  disabled={searchBusy || !searchQuery.trim()}
                  onClick={() => runJarvisSearch()}
                >
                  {searchBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Find
                </Button>
                {(searchHits.length > 0 || searchBusy) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      cancelExplorerSearchJob();
                      clearExplorerSearchHits();
                    }}
                  >
                    {searchBusy ? 'Stop' : 'Clear hits'}
                  </Button>
                )}
              </div>
              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                Multi-clue: file type + words inside text files (skips images). Wide scan: Home,
                Documents, Desktop, Downloads + current folder. Use{' '}
                <code className="text-foreground/80">here</code> to stay in this folder only.
                {searchState.clueSummary ? (
                  <>
                    {' '}
                    · Clues: <span className="text-foreground/85">{searchState.clueSummary}</span>
                  </>
                ) : null}
                {searchStatus && !searchBusy ? <> · {searchStatus}</> : null}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-elevated/30 px-4 py-2.5 [html[data-theme=monochrome]_&]:bg-panel">
          <div className="mr-auto hidden min-w-0 max-w-[45%] truncate text-metadata text-muted-foreground sm:block">
            {mode === 'folder'
              ? selected[0] && entries.some((e) => e.path === selected[0] && e.isDir)
                ? `Selected folder: ${basename(selected[0])}`
                : 'No subfolder selected — will use open folder above'
              : selected.length
                ? selected.map((p) => basename(p)).join(', ')
                : 'Nothing selected'}
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              if (runtimeEffectsEnabled) cancelFileExplorer();
            }}
          >
            Cancel
          </Button>
          {selectionError ? (
            <p role="alert" className="text-sm text-destructive">
              {selectionError}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            className="bg-foreground text-background hover:bg-foreground/90"
            disabled={!canConfirm}
            onClick={() => void confirm()}
          >
            {mode === 'folder'
              ? 'Select folder'
              : mode === 'files'
                ? `Select${selected.length ? ` (${selected.length})` : ''}`
                : 'Select file'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EntryIcon({ entry }: { entry: { path: string; isDir: boolean; name: string } }) {
  if (entry.isDir) return <Folder className="h-4 w-4 shrink-0 text-accent-honey" />;
  if (isImagePath(entry.path)) return <ImageIcon className="h-4 w-4 shrink-0 text-accent-copper" />;
  if (isVideoPath(entry.path)) return <Film className="h-4 w-4 shrink-0 text-accent-honey" />;
  return <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />;
}

function EntryTile({
  entry,
  selected,
  mode,
  constrainedRoot,
  allowThumb,
  hit,
  onOpen,
  onActivate,
}: {
  entry: { path: string; name: string; isDir: boolean; size?: number };
  selected: boolean;
  mode: FileExplorerMode;
  constrainedRoot: string | null;
  /** When false, show icon only — skips full-file base64 load. */
  allowThumb: boolean;
  hit?: SearchHit;
  onOpen: () => void;
  onActivate: () => void;
}) {
  const [thumb, setThumb] = React.useState<string | null>(null);
  const [thumbBusy, setThumbBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setThumb(null);
    setThumbBusy(false);
    if (entry.isDir || !isImagePath(entry.path) || !allowThumb) {
      return;
    }
    setThumbBusy(true);
    void (async () => {
      try {
        const img = await withExplorerImageSlot(() =>
          readImageFileBase64(entry.path, constrainedRoot ? { root: constrainedRoot } : {}),
        );
        if (cancelled) return;
        if (!img.ok) {
          setThumb(null);
          return;
        }
        // Drop oversize payloads that list metadata under-reported
        if (!shouldLoadExplorerImage(img.size, EXPLORER_THUMB_MAX_BYTES)) {
          setThumb(null);
          return;
        }
        const raw = img as { mimeType?: string; mime_type?: string; data: string };
        setThumb(imageDataUrl(raw.mimeType || raw.mime_type, img.data));
      } finally {
        if (!cancelled) setThumbBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.isDir, constrainedRoot, allowThumb]);

  const isImage = !entry.isDir && isImagePath(entry.path);

  return (
    <button
      type="button"
      onClick={onOpen}
      onDoubleClick={onActivate}
      aria-pressed={selected}
      className={cn(
        'flex flex-col items-center gap-1 rounded-lg border border-transparent p-1.5 text-center transition-colors',
        'hover:border-accent-copper/30 hover:bg-accent-copper/10',
        selected && 'border-accent-copper/50 bg-accent-copper/15 ring-1 ring-accent-copper/40',
      )}
      title={
        hit?.snippet ||
        (isImage && !allowThumb
          ? `${entry.path} (preview skipped — large or many images)`
          : entry.path)
      }
    >
      <div className="flex h-16 w-full items-center justify-center overflow-hidden rounded-md bg-background/60 [html[data-theme=monochrome]_&]:bg-background">
        {entry.isDir ? (
          <Folder className="h-8 w-8 text-accent-honey" />
        ) : thumb ? (
          <img
            src={thumb}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : isVideoPath(entry.path) ? (
          <Film className="h-8 w-8 text-accent-honey" />
        ) : isImage ? (
          thumbBusy ? (
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          ) : (
            <ImageIcon className="h-8 w-8 text-accent-copper" />
          )
        ) : (
          <FileText className="h-8 w-8 text-muted-foreground" />
        )}
      </div>
      <span className="line-clamp-2 w-full text-[10px] leading-tight text-foreground">
        {entry.name}
      </span>
    </button>
  );
}
