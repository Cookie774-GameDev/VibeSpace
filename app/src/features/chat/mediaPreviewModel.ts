/** Pure helpers for media preview pan/zoom and file edit undo/redo. */

export const MEDIA_PREVIEW_MIN_ZOOM = 0.25;
export const MEDIA_PREVIEW_MAX_ZOOM = 40;
export const MEDIA_PREVIEW_ZOOM_STEP = 1.12;
export const FILE_EDIT_HISTORY_MAX = 80;
export const IMAGE_EDIT_HISTORY_MAX = 80;
export const IMAGE_EDIT_MAX_DIMENSION = 4096;
export const IMAGE_EDIT_MAX_PIXELS = 12_000_000;

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

export type ImagePoint = { x: number; y: number };
export type ImageStroke = {
  points: ImagePoint[];
  color: string;
  width: number;
};
export type ImageEditHistory = {
  past: ImageStroke[][];
  present: ImageStroke[];
  future: ImageStroke[][];
};
export type RasterSize = { width: number; height: number };

/** Return decoded bytes for a generated PNG data URL, or null for other/invalid encodings. */
function imagePngDataUrlByteLength(dataUrl: string): number | null {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) return null;
  const payload = dataUrl.slice(prefix.length);
  if (
    payload.length === 0 ||
    payload.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(payload)
  ) {
    return null;
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length / 4) * 3 - padding;
}

export function validateImagePngDataUrl(
  dataUrl: string,
  maxBytes: number,
): { ok: true; byteLength: number } | { ok: false; reason: 'unsupported' | 'too-large' } {
  const byteLength = imagePngDataUrlByteLength(dataUrl);
  if (byteLength === null || !Number.isFinite(maxBytes) || maxBytes < 0) {
    return { ok: false, reason: 'unsupported' };
  }
  if (byteLength > maxBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, byteLength };
}

export function createImageEditHistory(): ImageEditHistory {
  return { past: [], present: [], future: [] };
}

export function pushImageStroke(
  history: ImageEditHistory,
  stroke: ImageStroke,
): ImageEditHistory {
  if (stroke.points.length === 0) return history;
  const present = [...history.present, stroke];
  return {
    past: [...history.past, history.present].slice(-IMAGE_EDIT_HISTORY_MAX),
    present,
    future: [],
  };
}

export function undoImageEdit(history: ImageEditHistory): ImageEditHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future].slice(0, IMAGE_EDIT_HISTORY_MAX),
  };
}

export function redoImageEdit(history: ImageEditHistory): ImageEditHistory {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return {
    past: [...history.past, history.present].slice(-IMAGE_EDIT_HISTORY_MAX),
    present: next!,
    future: rest,
  };
}

/** Preserve aspect ratio while keeping canvas work bounded for large images. */
export function boundedRasterSize(
  width: number,
  height: number,
  maxDimension = IMAGE_EDIT_MAX_DIMENSION,
  maxPixels = IMAGE_EDIT_MAX_PIXELS,
): RasterSize | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    maxDimension <= 0 ||
    maxPixels <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    1,
    maxDimension / width,
    maxDimension / height,
    Math.sqrt(maxPixels / (width * height)),
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
