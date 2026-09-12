import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Redo2, Save, Undo2, X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { readTextFile, writeTextFile } from '@/lib/fs';
import { toast } from '@/components/ui/toast';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import {
  DEFAULT_PAN_ZOOM,
  attachmentToPreviewUrl,
  createTextHistory,
  isVideoMediaUrl,
  panBy,
  pushTextChange,
  redoText,
  resetPanZoom,
  undoText,
  zoomAtPoint,
  type PanZoomState,
  type TextHistory,
} from './mediaPreviewModel';

export type MediaPreviewTarget =
  | {
      kind: 'media';
      name: string;
      url: string;
      mediaKind: 'image' | 'video';
    }
  | {
      kind: 'file';
      path: string;
      projectRoot: string;
    };

export function mediaTargetFromAttachment(image: ChatImageAttachment): MediaPreviewTarget {
  const url = attachmentToPreviewUrl(image.mimeType, image.data);
  return {
    kind: 'media',
    name: image.name,
    url,
    mediaKind:
      isVideoMediaUrl(url, image.name) || image.mimeType.startsWith('video/') ? 'video' : 'image',
  };
}

export function MediaPreviewPanel({
  target,
  onClose,
}: {
  target: MediaPreviewTarget;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={target.kind === 'file' ? `Edit ${target.path}` : `Preview ${target.name}`}
      data-media-preview-panel="true"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full max-h-[min(92vh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-soft">
        {target.kind === 'media' ? (
          <MediaViewer target={target} onClose={onClose} />
        ) : (
          <FileEditor target={target} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function MediaViewer({
  target,
  onClose,
}: {
  target: Extract<MediaPreviewTarget, { kind: 'media' }>;
  onClose: () => void;
}) {
  const [view, setView] = useState<PanZoomState>(DEFAULT_PAN_ZOOM);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setView(resetPanZoom());
  }, [target.url]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const focalX = event.clientX - rect.left;
      const focalY = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((cur) => zoomAtPoint(cur, factor, focalX, focalY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <strong className="min-w-0 flex-1 truncate text-ui-strong text-foreground">
          {target.name}
        </strong>
        <span className="text-metadata text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Zoom out"
          onClick={() =>
            setView((cur) =>
              zoomAtPoint(
                cur,
                1 / 1.25,
                (stageRef.current?.clientWidth ?? 400) / 2,
                (stageRef.current?.clientHeight ?? 300) / 2,
              ),
            )
          }
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Zoom in"
          onClick={() =>
            setView((cur) =>
              zoomAtPoint(
                cur,
                1.25,
                (stageRef.current?.clientWidth ?? 400) / 2,
                (stageRef.current?.clientHeight ?? 300) / 2,
              ),
            )
          }
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Reset zoom"
          onClick={() => setView(resetPanZoom())}
        >
          <Maximize2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-black/90 active:cursor-grabbing"
        data-media-preview-stage="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // Do not pan when using native video controls or buttons.
          const t = event.target as HTMLElement | null;
          if (t?.closest?.('video, button, input, a, [data-no-pan]')) return;
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          const dx = event.clientX - dragRef.current.x;
          const dy = event.clientY - dragRef.current.y;
          dragRef.current = { x: event.clientX, y: event.clientY };
          setView((cur) => panBy(cur, dx, dy));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          try {
            (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div
          className="absolute left-1/2 top-1/2 will-change-transform"
          style={{
            transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`,
            transformOrigin: 'center center',
          }}
        >
          {target.mediaKind === 'video' ? (
            <video
              src={target.url}
              controls
              playsInline
              className="max-h-[70vh] max-w-[80vw] bg-black"
              preload="metadata"
              draggable={false}
            />
          ) : (
            <img
              src={target.url}
              alt={target.name}
              className="max-h-[70vh] max-w-[80vw] select-none"
              draggable={false}
            />
          )}
        </div>
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-metadata text-white">
          Scroll to zoom · drag to pan · Esc to close
        </p>
      </div>
    </>
  );
}

function FileEditor({
  target,
  onClose,
}: {
  target: Extract<MediaPreviewTarget, { kind: 'file' }>;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<TextHistory | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedRef = useRef('');
  const label = target.path.split(/[/\\]/).pop() ?? target.path;

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setHistory(null);
    setDirty(false);
    void readTextFile(target.path, { root: target.projectRoot }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        setError(result.error.raw || 'Could not open this file.');
        return;
      }
      savedRef.current = result.content;
      setHistory(createTextHistory(result.content));
      setStatus('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [target.path, target.projectRoot]);

  const applyHistory = useCallback((next: TextHistory) => {
    setHistory(next);
    setDirty(next.present !== savedRef.current);
  }, []);

  const save = useCallback(async () => {
    if (!history) return;
    setSaving(true);
    const written = await writeTextFile(target.path, history.present, {
      root: target.projectRoot,
    });
    setSaving(false);
    if (!written.ok) {
      toast.error('Save failed', written.error.raw || 'Could not write the file.');
      return;
    }
    savedRef.current = history.present;
    setDirty(false);
    toast.success('Saved', label);
  }, [history, label, target.path, target.projectRoot]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || !history) return;
      // Ctrl+Z undo; also accept Ctrl+X as undo per product request.
      // Ctrl+Y redo.
      if (event.key === 'z' || event.key === 'Z' || event.key === 'x' || event.key === 'X') {
        if (event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
          event.preventDefault();
          applyHistory(redoText(history));
          return;
        }
        if (event.key === 'x' || event.key === 'X' || event.key === 'z' || event.key === 'Z') {
          // Only intercept cut-as-undo when not selecting text for real cut would be odd;
          // product asked Ctrl+X undo — honor when not Shift.
          if (event.key === 'x' || event.key === 'X') {
            // Don't steal cut when user has a selection and expects cut — if selection length > 0, skip.
            const el = event.target as HTMLTextAreaElement | null;
            if (
              el &&
              typeof el.selectionStart === 'number' &&
              el.selectionStart !== el.selectionEnd
            ) {
              return;
            }
          }
          event.preventDefault();
          applyHistory(undoText(history));
        }
      } else if (event.key === 'y' || event.key === 'Y') {
        event.preventDefault();
        applyHistory(redoText(history));
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyHistory, history, onClose, save]);

  return (
    <>
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-accent-copper" />
        <strong
          className="min-w-0 flex-1 truncate text-ui-strong text-foreground"
          title={target.path}
        >
          {label}
          {dirty ? ' · unsaved' : ''}
        </strong>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="Undo"
          disabled={!history || history.past.length === 0}
          onClick={() => history && applyHistory(undoText(history))}
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          aria-label="Redo"
          disabled={!history || history.future.length === 0}
          onClick={() => history && applyHistory(redoText(history))}
        >
          <Redo2 className="h-3.5 w-3.5" />
          Redo
        </button>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-1 rounded px-2 py-1 text-metadata',
            dirty
              ? 'bg-accent-copper/15 text-accent-copper hover:bg-accent-copper/25'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
          aria-label="Save file"
          disabled={!history || saving || !dirty}
          onClick={() => void save()}
        >
          <Save className="h-3.5 w-3.5" />
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close file panel"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      {status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Opening file…
        </div>
      ) : status === 'error' ? (
        <p className="flex-1 p-4 text-destructive">{error}</p>
      ) : (
        <textarea
          className="min-h-0 flex-1 resize-none bg-panel p-3 font-mono text-[13px] leading-5 text-foreground outline-none"
          value={history?.present ?? ''}
          spellCheck={false}
          data-media-preview-editor="true"
          aria-label={`Edit ${label}`}
          onChange={(event) => {
            if (!history) return;
            applyHistory(pushTextChange(history, event.target.value));
          }}
        />
      )}
      <footer className="shrink-0 border-t border-border px-3 py-1.5 text-metadata text-muted-foreground">
        Ctrl+Z / Ctrl+X undo · Ctrl+Y redo · Ctrl+S save · Esc close
      </footer>
    </>
  );
}
