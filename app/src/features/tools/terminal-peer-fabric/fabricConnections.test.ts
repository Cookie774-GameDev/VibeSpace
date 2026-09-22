import { expect, it } from 'vitest';
import { createFabricRouter } from './fabricRouting';
import { fabricConnections } from './fabricConnections';
it('keeps all ten members connected even when selection jumps across full-height panes', () => {
  const boxes = Array.from({ length: 10 }, (_, i) => ({
    id: `${i}`,
    x: i * 120,
    y: 20,
    width: 100,
    height: 400,
  }));
  const selected = [boxes[0], boxes[9], ...boxes.slice(1, 9)];
  const connections = fabricConnections(selected, createFabricRouter(boxes));
  expect(connections).toHaveLength(9);
  expect(new Set(connections.flatMap((c) => [c.from.id, c.to.id])).size).toBe(10);
  for (const c of connections) expect(Math.abs(c.from.x - c.to.x)).toBe(120);
});
it('never draws a made-up bridge through an unconnected blocking terminal', () => {
  const boxes = [0, 1, 2].map((i) => ({ id: `${i}`, x: i * 120, y: 0, width: 100, height: 400 }));
  expect(fabricConnections([boxes[0], boxes[2]], createFabricRouter(boxes))).toEqual([]);
});
