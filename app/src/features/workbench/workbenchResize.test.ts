import { expect, it } from 'vitest';
import { resizeWorkbenchBounds } from './workbenchResize';
const start = { x: 100, y: 200, width: 400, height: 300 };
it.each([0.25, 0.78, 1, 2])('resizes consistently at zoom %s', (zoom) => {
  expect(resizeWorkbenchBounds(start, 'se', 100 * zoom, 60 * zoom, zoom)).toEqual({
    ...start,
    width: 500,
    height: 360,
  });
});
it('anchors the opposite corner when resizing north-west or reaching minimum size', () => {
  expect(resizeWorkbenchBounds(start, 'nw', -50, -20, 1)).toEqual({
    x: 50,
    y: 180,
    width: 450,
    height: 320,
  });
  expect(resizeWorkbenchBounds(start, 'nw', 1000, 1000, 1)).toEqual({
    x: 260,
    y: 340,
    width: 240,
    height: 160,
  });
});
it('changes only the chosen edge', () => {
  expect(resizeWorkbenchBounds(start, 'e', 50, 80, 1)).toEqual({ ...start, width: 450 });
});
