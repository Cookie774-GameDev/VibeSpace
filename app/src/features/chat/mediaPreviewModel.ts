/** Pure helpers for media preview pan/zoom and file edit undo/redo. */

export const MEDIA_PREVIEW_MIN_ZOOM = 0.25;
export const MEDIA_PREVIEW_MAX_ZOOM = 40;
export const MEDIA_PREVIEW_ZOOM_STEP = 1.12;
export const FILE_EDIT_HISTORY_MAX = 80;

export type PanZoomState = { scale: number; x: number; y: number };

export const DEFAULT_PAN_ZOOM: PanZoomState = Object.freeze({ scale: 1, x: 0, y: 0 });

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MEDIA_PREVIEW_MAX_ZOOM, Math.max(MEDIA_PREVIEW_MIN_ZOOM, scale));
}

/** Wheel/pinch style zoom around a focal point in panel coordinates. */
export function zoomAtPoint(
  state: PanZoomState,
  factor: number,
  focalX: number,
  focalY: number,
): PanZoomState {
  const nextScale = clampZoom(state.scale * factor);
  if (nextScale === state.scale) return state;
  const ratio = nextScale / state.scale;
  return {
    scale: nextScale,
    x: focalX - (focalX - state.x) * ratio,
    y: focalY - (focalY - state.y) * ratio,
  };
}

export function panBy(state: PanZoomState, dx: number, dy: number): PanZoomState {
  return { ...state, x: state.x + dx, y: state.y + dy };
}

export function resetPanZoom(): PanZoomState {
  return { ...DEFAULT_PAN_ZOOM };
}

export type TextHistory = {
  past: string[];
  present: string;
  future: string[];
};

export function createTextHistory(present: string): TextHistory {
  return { past: [], present, future: [] };
}

export function pushTextChange(history: TextHistory, next: string): TextHistory {
  if (next === history.present) return history;
  const past = [...history.past, history.present].slice(-FILE_EDIT_HISTORY_MAX);
  return { past, present: next, future: [] };
}

export function undoText(history: TextHistory): TextHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, FILE_EDIT_HISTORY_MAX),
  };
}

export function redoText(history: TextHistory): TextHistory {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return {
    past: [...history.past, history.present].slice(-FILE_EDIT_HISTORY_MAX),
    present: next!,
    future: rest,
  };
}

export function isVideoMediaUrl(url: string, name = ''): boolean {
  return (
    url.startsWith('data:video/') ||
    /^https?:\/\/.+\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) ||
    /\.(mp4|webm|mov|m4v)$/i.test(name)
  );
}

export function attachmentToPreviewUrl(mimeType: string, data: string): string {
  if (data.startsWith('data:')) return data;
  return `data:${mimeType};base64,${data}`;
}
