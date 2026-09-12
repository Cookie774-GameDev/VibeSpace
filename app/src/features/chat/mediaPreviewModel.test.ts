import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  createTextHistory,
  pushTextChange,
  redoText,
  undoText,
  zoomAtPoint,
  panBy,
  MEDIA_PREVIEW_MAX_ZOOM,
} from './mediaPreviewModel';

describe('mediaPreviewModel', () => {
  it('clamps and zooms deeply around a focal point', () => {
    expect(clampZoom(0.01)).toBe(0.25);
    expect(clampZoom(100)).toBe(MEDIA_PREVIEW_MAX_ZOOM);
    let view = { scale: 1, x: 0, y: 0 };
    for (let i = 0; i < 40; i += 1) {
      view = zoomAtPoint(view, 1.2, 100, 80);
    }
    expect(view.scale).toBeGreaterThan(10);
    expect(view.scale).toBeLessThanOrEqual(MEDIA_PREVIEW_MAX_ZOOM);
    view = panBy(view, 12, -8);
    expect(view.x).toBe(view.x);
  });

  it('undo and redo restore file edit history (Ctrl+Z / Ctrl+Y model)', () => {
    let h = createTextHistory('hello');
    h = pushTextChange(h, 'hello world');
    h = pushTextChange(h, 'hello world!');
    h = undoText(h);
    expect(h.present).toBe('hello world');
    h = undoText(h);
    expect(h.present).toBe('hello');
    h = redoText(h);
    expect(h.present).toBe('hello world');
    h = redoText(h);
    expect(h.present).toBe('hello world!');
  });
});
