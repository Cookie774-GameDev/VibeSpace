import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  boundedRasterSize,
  createImageEditHistory,
  createTextHistory,
  pushImageStroke,
  pushTextChange,
  redoImageEdit,
  redoText,
  undoImageEdit,
  undoText,
  validateImagePngDataUrl,
  zoomAtPoint,
  panBy,
  MEDIA_PREVIEW_MAX_ZOOM,
  IMAGE_EDIT_MAX_DIMENSION,
  IMAGE_EDIT_MAX_PIXELS,
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
    const beforePan = view;
    view = panBy(view, 12, -8);
    expect(view.x).toBe(beforePan.x + 12);
    expect(view.y).toBe(beforePan.y - 8);
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

  it('undoes and redoes image strokes without losing the current edit', () => {
    const first = { points: [{ x: 2, y: 3 }], color: '#ef4444', width: 4 };
    const second = { points: [{ x: 5, y: 8 }], color: '#ef4444', width: 4 };
    let history = pushImageStroke(createImageEditHistory(), first);
    history = pushImageStroke(history, second);

    history = undoImageEdit(history);
    expect(history.present).toEqual([first]);
    history = redoImageEdit(history);
    expect(history.present).toEqual([first, second]);
    expect(undoImageEdit(createImageEditHistory())).toEqual(createImageEditHistory());
  });

  it('bounds exported raster dimensions and rejects invalid image sizes', () => {
    expect(boundedRasterSize(800, 600)).toEqual({ width: 800, height: 600 });
    const large = boundedRasterSize(20_000, 10_000)!;
    expect(large.width).toBeLessThanOrEqual(IMAGE_EDIT_MAX_DIMENSION);
    expect(large.height).toBeLessThanOrEqual(IMAGE_EDIT_MAX_DIMENSION);
    expect(large.width * large.height).toBeLessThanOrEqual(IMAGE_EDIT_MAX_PIXELS);
    expect(boundedRasterSize(0, 100)).toBeNull();
    expect(boundedRasterSize(Number.NaN, 100)).toBeNull();
  });

  it('validates decoded PNG bytes against inclusive attachment limits', () => {
    const oneBytePng = 'data:image/png;base64,AA==';
    expect(validateImagePngDataUrl(oneBytePng, 1)).toEqual({ ok: true, byteLength: 1 });
    expect(validateImagePngDataUrl(oneBytePng, 0)).toEqual({ ok: false, reason: 'too-large' });
    expect(validateImagePngDataUrl('data:image/jpeg;base64,QUJD', 100)).toEqual({
      ok: false,
      reason: 'unsupported',
    });
    expect(validateImagePngDataUrl('data:image/png;base64,not base64', 100)).toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });
});
