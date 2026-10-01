import { describe, expect, it } from 'vitest';
import {
  buildMinimapModel,
  panCameraToWorldPoint,
  viewportWorldRect,
  worldPointFromMinimapClick,
} from './workbenchMinimap';

describe('workbenchMinimap', () => {
  const panels = [
    { id: 'a', x: 100, y: 100, width: 200, height: 150 },
    { id: 'b', x: 500, y: 300, width: 300, height: 200 },
  ];
  const canvas = { width: 1000, height: 700 };

  it('maps viewport from camera without inventing panel motion', () => {
    const view = { x: 50, y: 80, zoom: 0.5 };
    const vp = viewportWorldRect(view, canvas);
    expect(vp.x).toBeCloseTo(-100);
    expect(vp.y).toBeCloseTo(-160);
    expect(vp.width).toBeCloseTo(2000);
    expect(vp.height).toBeCloseTo(1400);
  });

  it('pans camera to center a world point and leaves zoom alone', () => {
    const view = { x: -2000, y: -1500, zoom: 0.8 };
    const next = panCameraToWorldPoint(400, 250, view, canvas);
    expect(next.zoom).toBe(0.8);
    // Screen center should land on world (400, 250)
    expect(next.x + 400 * next.zoom).toBeCloseTo(canvas.width / 2);
    expect(next.y + 250 * next.zoom).toBeCloseTo(canvas.height / 2);
  });

  it('maps minimap click fractions into world space', () => {
    const bounds = { left: 0, top: 0, width: 1000, height: 500 };
    expect(worldPointFromMinimapClick(0.5, 0.5, bounds)).toEqual({ x: 500, y: 250 });
    expect(worldPointFromMinimapClick(0, 0, bounds)).toEqual({ x: 0, y: 0 });
  });

  it('builds panel + viewport percent rects for rendering', () => {
    const model = buildMinimapModel(panels, { x: 24, y: 24, zoom: 0.8 }, canvas);
    expect(model.placements).toHaveLength(2);
    expect(model.viewportStyle.left).toMatch(/%$/);
    expect(model.viewportStyle.width).toMatch(/%$/);
  });
});
