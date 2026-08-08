/**
 * Pure geometry for the Workbench minimap.
 * Camera-only — never mutates panel positions/sizes.
 */

export interface MinimapPanelRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized?: boolean;
}

export interface MinimapView {
  x: number;
  y: number;
  zoom: number;
}

export interface MinimapCanvasSize {
  width: number;
  height: number;
}

export interface WorldBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PercentRect {
  left: string;
  top: string;
  width: string;
  height: string;
}

/** Visible viewport in world coordinates (inverse of stage transform). */
export function viewportWorldRect(
  view: MinimapView,
  canvas: MinimapCanvasSize,
): { x: number; y: number; width: number; height: number } {
  const zoom = Math.max(0.05, view.zoom || 1);
  return {
    x: -view.x / zoom,
    y: -view.y / zoom,
    width: Math.max(1, canvas.width) / zoom,
    height: Math.max(1, canvas.height) / zoom,
  };
}

/** Bounding box of panels + optional extra rects (e.g. viewport), with padding. */
export function computeWorldBounds(
  panels: readonly MinimapPanelRect[],
  extras: ReadonlyArray<{ x: number; y: number; width: number; height: number }> = [],
  pad = 80,
): WorldBounds {
  if (panels.length === 0 && extras.length === 0) {
    return { left: 0, top: 0, width: 1200, height: 800 };
  }
  const rects = [
    ...panels.map((p) => ({
      x: p.x,
      y: p.y,
      width: Math.max(1, p.width),
      height: Math.max(1, p.minimized ? 42 : p.height),
    })),
    ...extras,
  ];
  const left = Math.min(...rects.map((r) => r.x)) - pad;
  const top = Math.min(...rects.map((r) => r.y)) - pad;
  const right = Math.max(...rects.map((r) => r.x + r.width)) + pad;
  const bottom = Math.max(...rects.map((r) => r.y + r.height)) + pad;
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function rectToPercent(
  item: { x: number; y: number; width: number; height: number },
  bounds: WorldBounds,
): PercentRect {
  return {
    left: `${((item.x - bounds.left) / bounds.width) * 100}%`,
    top: `${((item.y - bounds.top) / bounds.height) * 100}%`,
    width: `${Math.max(2, (item.width / bounds.width) * 100)}%`,
    height: `${Math.max(2, (item.height / bounds.height) * 100)}%`,
  };
}

/**
 * Camera that centers a world point on the canvas without changing zoom.
 * Does not move panels — only view.x / view.y.
 */
export function panCameraToWorldPoint(
  worldX: number,
  worldY: number,
  view: MinimapView,
  canvas: MinimapCanvasSize,
): MinimapView {
  const zoom = Math.max(0.05, view.zoom || 1);
  return {
    zoom,
    x: canvas.width / 2 - worldX * zoom,
    y: canvas.height / 2 - worldY * zoom,
  };
}

/** Map a click (0–1 fractions inside the minimap) to a world point. */
export function worldPointFromMinimapClick(
  fractionX: number,
  fractionY: number,
  bounds: WorldBounds,
): { x: number; y: number } {
  const fx = Math.min(1, Math.max(0, fractionX));
  const fy = Math.min(1, Math.max(0, fractionY));
  return {
    x: bounds.left + fx * bounds.width,
    y: bounds.top + fy * bounds.height,
  };
}

export function buildMinimapModel(
  panels: readonly MinimapPanelRect[],
  view: MinimapView,
  canvas: MinimapCanvasSize,
) {
  const viewport = viewportWorldRect(view, canvas);
  const bounds = computeWorldBounds(panels, [viewport], 100);
  return {
    bounds,
    viewport,
    viewportStyle: rectToPercent(viewport, bounds),
    placements: panels.slice(0, 48).map((panel) => ({
      id: panel.id,
      style: rectToPercent(
        {
          x: panel.x,
          y: panel.y,
          width: Math.max(1, panel.width),
          height: Math.max(1, panel.minimized ? 42 : panel.height),
        },
        bounds,
      ),
    })),
  };
}
