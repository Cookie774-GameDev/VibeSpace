import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FileText,
  Loader2,
  Maximize2,
  Pencil,
  Redo2,
  Save,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { readTextFile, writeTextFile } from '@/lib/fs';
import { toast } from '@/components/ui/toast';
import type { ChatImageAttachment } from '@/lib/ai/vision';
import { IMAGE_ATTACHMENT_MAX_BYTES } from '@/lib/ai/vision';
import {
  DEFAULT_PAN_ZOOM,
  attachmentToPreviewUrl,
  boundedRasterSize,
  createImageEditHistory,
  createTextHistory,
  isVideoMediaUrl,
  panBy,
  pushImageStroke,
  pushTextChange,
  redoImageEdit,
  redoText,
  resetPanZoom,
  undoImageEdit,
  undoText,
  validateImagePngDataUrl,
  zoomAtPoint,
  type ImageEditHistory,
  type ImagePoint,
  type ImageStroke,
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

function imageEditErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.name === 'SecurityError') {
    return 'This image source blocks export. Reopen a saved chat image or choose another image.';
  }
  return error instanceof Error ? error.message : fallback;
}

export function MediaPreviewPanel({
  target,
  onClose,
  onSaveEditedCopy,
}: {
  target: MediaPreviewTarget;
  onClose: () => void;
  onSaveEditedCopy?: (pngDataUrl: string) => Promise<void>;
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
          <MediaViewer
            key={`${target.name}:${target.url}`}
            target={target}
            onClose={onClose}
            onSaveEditedCopy={onSaveEditedCopy}
          />
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
  onSaveEditedCopy,
}: {
  target: Extract<MediaPreviewTarget, { kind: 'media' }>;
  onClose: () => void;
  onSaveEditedCopy?: (pngDataUrl: string) => Promise<void>;
}) {
  const [view, setView] = useState<PanZoomState>(DEFAULT_PAN_ZOOM);
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [imageStatus, setImageStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [annotationHistory, setAnnotationHistory] = useState<ImageEditHistory>(
    createImageEditHistory,
  );
  const [draftPoints, setDraftPoints] = useState<ImagePoint[] | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setView(resetPanZoom());
  }, [target.url]);

  const hasImageEdits = annotationHistory.present.length > 0;

  const pointAt = useCallback(
    (clientX: number, clientY: number): ImagePoint | null => {
      const image = imageRef.current;
      if (!image || !imageDimensions || imageStatus !== 'ready') return null;
      const rect = image.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      return {
        x: ((clientX - rect.left) / rect.width) * imageDimensions.width,
        y: ((clientY - rect.top) / rect.height) * imageDimensions.height,
      };
    },
    [imageDimensions, imageStatus],
  );

  const makePngDataUrl = useCallback(() => {
    const image = imageRef.current;
    if (!image || !imageDimensions || imageStatus !== 'ready') {
      throw new Error('Wait for the image to finish loading before exporting.');
    }
    const size = boundedRasterSize(imageDimensions.width, imageDimensions.height);
    if (!size) throw new Error('The image has invalid dimensions and cannot be edited.');
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare an image canvas.');

    context.drawImage(image, 0, 0, size.width, size.height);
    const scaleX = size.width / imageDimensions.width;
    const scaleY = size.height / imageDimensions.height;
    for (const stroke of annotationHistory.present) {
      if (stroke.points.length === 0) continue;
      context.beginPath();
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width * Math.min(scaleX, scaleY);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      if (stroke.points.length === 1) {
        const [point] = stroke.points;
        context.arc(
          point!.x * scaleX,
          point!.y * scaleY,
          Math.max(1, context.lineWidth / 2),
          0,
          Math.PI * 2,
        );
        context.fill();
      } else {
        const [first, ...rest] = stroke.points;
        context.moveTo(first!.x * scaleX, first!.y * scaleY);
        for (const point of rest) context.lineTo(point.x * scaleX, point.y * scaleY);
        context.stroke();
      }
    }
    const dataUrl = canvas.toDataURL('image/png');
    const validation = validateImagePngDataUrl(dataUrl, IMAGE_ATTACHMENT_MAX_BYTES);
    if (!validation.ok) {
      throw new Error(
        validation.reason === 'too-large'
          ? 'The edited PNG exceeds the 8 MiB chat image limit. Try a smaller image.'
          : 'The browser returned an unsupported image format.',
      );
    }
    return dataUrl;
  }, [annotationHistory.present, imageDimensions, imageStatus]);

  const exportPng = useCallback(() => {
    try {
      const dataUrl = makePngDataUrl();
      const basename = target.name.replace(/\.[^.\\/]+$/u, '').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-');
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `${basename || 'annotated-image'}.png`;
      link.click();
      setEditMessage('Exported an annotated PNG.');
    } catch (error) {
      setEditMessage(imageEditErrorMessage(error, 'The annotated PNG could not be exported.'));
    }
  }, [makePngDataUrl, target.name]);

  const saveEditedCopy = useCallback(async () => {
    if (!onSaveEditedCopy) return;
    setSaving(true);
    setEditMessage(null);
    try {
      const dataUrl = makePngDataUrl();
      await onSaveEditedCopy(dataUrl);
      setAnnotationHistory(createImageEditHistory());
      setDraftPoints(null);
      setAnnotating(false);
      setEditMessage('Saved an edited copy to this chat. The original image is unchanged.');
    } catch (error) {
      setEditMessage(imageEditErrorMessage(error, 'The edited image could not be saved.'));
    } finally {
      setSaving(false);
    }
  }, [makePngDataUrl, onSaveEditedCopy]);

  const renderStroke = (stroke: ImageStroke, key: string) => {
    if (stroke.points.length === 1) {
      const point = stroke.points[0]!;
      return (
        <circle
          key={key}
          cx={point.x}
          cy={point.y}
          r={stroke.width / 2}
          fill={stroke.color}
        />
      );
    }
    const path = stroke.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
    return (
      <path
        key={key}
        d={path}
        fill="none"
        stroke={stroke.color}
        strokeWidth={stroke.width}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  };

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
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <strong className="min-w-0 flex-1 truncate text-ui-strong text-foreground">
          {target.name}
        </strong>
        <span className="text-metadata text-muted-foreground">{Math.round(view.scale * 100)}%</span>
        {target.mediaKind === 'image' && (
          <>
            <button
              type="button"
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-1 text-metadata hover:bg-muted hover:text-foreground disabled:opacity-40',
                annotating ? 'bg-accent-copper/20 text-accent-copper' : 'text-muted-foreground',
              )}
              aria-label={annotating ? 'Finish drawing' : 'Draw on image'}
              aria-pressed={annotating}
              disabled={imageStatus !== 'ready'}
              onClick={() => {
                setAnnotating((value) => !value);
                setDraftPoints(null);
                setEditMessage(null);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Draw
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              aria-label="Undo drawing"
              disabled={annotationHistory.past.length === 0}
              onClick={() => {
                setAnnotationHistory((history) => undoImageEdit(history));
                setEditMessage(null);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Undo
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              aria-label="Redo drawing"
              disabled={annotationHistory.future.length === 0}
              onClick={() => {
                setAnnotationHistory((history) => redoImageEdit(history));
                setEditMessage(null);
              }}
            >
              <Redo2 className="h-3.5 w-3.5" />
              Redo
            </button>
            {onSaveEditedCopy && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-accent-copper hover:bg-accent-copper/15 disabled:opacity-40"
                aria-label="Save edited copy to chat"
                disabled={!hasImageEdits || imageStatus !== 'ready' || saving}
                onClick={() => void saveEditedCopy()}
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? 'Saving…' : 'Save copy'}
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-metadata text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              aria-label="Export annotated PNG"
              disabled={!hasImageEdits || imageStatus !== 'ready'}
              onClick={exportPng}
            >
              <Download className="h-3.5 w-3.5" />
              Export PNG
            </button>
          </>
        )}
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
        className={cn(
          'relative min-h-0 flex-1 overflow-hidden bg-black/90',
          annotating ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing',
        )}
        data-media-preview-stage="true"
        data-testid="media-preview-stage"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // Do not pan when using native video controls or buttons.
          const t = event.target as HTMLElement | null;
          if (t?.closest?.('video, button, input, a, [data-no-pan]')) return;
          if (annotating && target.mediaKind === 'image') {
            const point = pointAt(event.clientX, event.clientY);
            if (!point) return;
            event.preventDefault();
            try {
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
            } catch {
              // Pointer capture is unavailable in some embedded WebViews.
            }
            dragRef.current = null;
            setDraftPoints([point]);
            setEditMessage(null);
            return;
          }
          try {
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          } catch {
            // Pointer capture is unavailable in some embedded WebViews.
          }
          dragRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          if (draftPoints) {
            const point = pointAt(event.clientX, event.clientY);
            if (point) setDraftPoints((points) => (points ? [...points, point] : points));
            return;
          }
          if (!dragRef.current) return;
          const dx = event.clientX - dragRef.current.x;
          const dy = event.clientY - dragRef.current.y;
          dragRef.current = { x: event.clientX, y: event.clientY };
          setView((cur) => panBy(cur, dx, dy));
        }}
        onPointerUp={(event) => {
          if (draftPoints && imageDimensions) {
            const width = Math.max(imageDimensions.width, imageDimensions.height) * 0.006;
            setAnnotationHistory((history) =>
              pushImageStroke(history, {
                points: draftPoints,
                color: '#ef4444',
                width,
              }),
            );
            setDraftPoints(null);
          }
          dragRef.current = null;
          try {
            (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
          } catch {
            // ignore
          }
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setDraftPoints(null);
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
            <div className="relative inline-block max-h-[70vh] max-w-[80vw]">
              <img
                ref={imageRef}
                src={target.url}
                alt={target.name}
                className="block max-h-[70vh] max-w-[80vw] select-none"
                draggable={false}
                onLoad={(event) => {
                  const { naturalWidth, naturalHeight } = event.currentTarget;
                  if (naturalWidth <= 0 || naturalHeight <= 0) {
                    setImageStatus('error');
                    return;
                  }
                  setImageDimensions({ width: naturalWidth, height: naturalHeight });
                  setImageStatus('ready');
                }}
                onError={() => setImageStatus('error')}
              />
              {imageDimensions && (
                <svg
                  className="pointer-events-none absolute inset-0 h-full w-full"
                  viewBox={`0 0 ${imageDimensions.width} ${imageDimensions.height}`}
                  aria-hidden="true"
                  preserveAspectRatio="none"
                >
                  {annotationHistory.present.map((stroke, index) =>
                    renderStroke(stroke, `saved-${index}`),
                  )}
                  {draftPoints &&
                    renderStroke(
                      {
                        points: draftPoints,
                        color: '#ef4444',
                        width: Math.max(imageDimensions.width, imageDimensions.height) * 0.006,
                      },
                      'draft',
                    )}
                </svg>
              )}
            </div>
          )}
        </div>
        {target.mediaKind === 'image' && imageStatus === 'loading' && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white"
            role="status"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            Loading image…
          </div>
        )}
        {target.mediaKind === 'image' && imageStatus === 'error' && (
          <p className="absolute inset-x-3 top-3 rounded bg-destructive/90 px-3 py-2 text-sm text-white" role="alert">
            The saved image could not be loaded. Verify its source or choose another image.
          </p>
        )}
        {editMessage && (
          <p
            className="absolute bottom-10 left-1/2 max-w-[90%] -translate-x-1/2 rounded bg-black/75 px-3 py-2 text-center text-metadata text-white"
            role="status"
          >
            {editMessage}
          </p>
        )}
        <p className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-metadata text-white">
          {annotating ? 'Draw with pointer · Undo/redo from toolbar · Esc to close' : 'Scroll to zoom · drag to pan · Esc to close'}
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
