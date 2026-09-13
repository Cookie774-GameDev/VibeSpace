import { describe, expect, it } from 'vitest';
import { fabricBridge as route } from './fabricRouting';

type Box = { id: string; x: number; y: number; width: number; height: number };
const box = (id: string, x: number, y: number, width = 100, height = 100): Box => ({
  id,
  x,
  y,
  width,
  height,
});
function assertClear(path: string, obstacles: Box[]) {
  const points = Array.from(path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g), (match) => ({
    x: +match[1],
    y: +match[2],
  }));
  expect(points.length).toBeGreaterThan(1);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    expect(a.x === b.x || a.y === b.y).toBe(true);
    for (const r of obstacles) {
      const crosses =
        a.y === b.y
          ? a.y > r.y &&
            a.y < r.y + r.height &&
            Math.max(a.x, b.x) > r.x &&
            Math.min(a.x, b.x) < r.x + r.width
          : a.x > r.x &&
            a.x < r.x + r.width &&
            Math.max(a.y, b.y) > r.y &&
            Math.min(a.y, b.y) < r.y + r.height;
      expect(crosses, `segment ${i} crosses ${r.id}: ${path}`).toBe(false);
    }
  }
}
describe('fabric routes through pane separators', () => {
  it('connects opposite corners in a ten-pane layout in both directions', () => {
    const panes = Array.from({ length: 10 }, (_, i) =>
      box(String(i), (i % 5) * 112, Math.floor(i / 5) * 112),
    );
    for (const [from, to] of [
      [panes[4], panes[5]],
      [panes[5], panes[4]],
    ]) {
      const bridge = route(from, to, panes);
      expect(bridge).not.toBeNull();
      assertClear(bridge!.path, panes);
    }
  });
  it('detours around an unconnected pane between aligned peers', () => {
    const panes = [
      box('a', 0, 0),
      box('blocker', 112, 0),
      box('b', 224, 0),
      box('lower', 0, 112, 324),
    ];
    const bridge = route(panes[0], panes[2], panes);
    expect(bridge).not.toBeNull();
    assertClear(bridge!.path, panes);
  });
  it('zigzags through staggered dividers instead of crossing the middle row', () => {
    const panes = [
      ...Array.from({ length: 4 }, (_, i) => box(`top-${i}`, i * 106, 0)),
      box('mid-0', 0, 106, 134),
      box('mid-1', 140, 106, 134),
      box('mid-2', 280, 106, 138),
      box('bottom-0', 0, 212, 120),
      box('bottom-1', 126, 212, 140),
      box('bottom-2', 272, 212, 146),
    ];
    const bridge = route(panes[3], panes[7], panes);
    expect(bridge).not.toBeNull();
    assertClear(bridge!.path, panes);
    expect(bridge!.path.match(/L/g)!.length).toBeGreaterThanOrEqual(4);
  });
  it('never draws through a sealed divider or overlapping panes', () => {
    const panes = [box('a', 0, 0), box('wall', 100, 0), box('b', 200, 0)];
    expect(route(panes[0], panes[2], panes)).toBeNull();
    expect(route(panes[0], panes[0], panes)).toBeNull();
  });
});
