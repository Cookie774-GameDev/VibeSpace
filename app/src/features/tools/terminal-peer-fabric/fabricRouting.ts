export type FabricBox = { id: string; x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type Edge = { to: number; length: number; axis: number };
const CLEARANCE = 2; // Fits the 6px separators, including the crisp backing stroke.
const BEND_COST = 6;

function intersects(a: Point, b: Point, r: FabricBox, padding = CLEARANCE) {
  return a.y === b.y
    ? a.y > r.y - padding &&
        a.y < r.y + r.height + padding &&
        Math.max(a.x, b.x) > r.x - padding &&
        Math.min(a.x, b.x) < r.x + r.width + padding
    : a.x > r.x - padding &&
        a.x < r.x + r.width + padding &&
        Math.max(a.y, b.y) > r.y - padding &&
        Math.min(a.y, b.y) < r.y + r.height + padding;
}

function bridge(points: Point[]) {
  const compact: Point[] = [];
  for (const point of points) {
    const a = compact.at(-2),
      b = compact.at(-1);
    if (b?.x === point.x && b.y === point.y) continue;
    if (a && b && ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)))
      compact.pop();
    compact.push(point);
  }
  const first = compact[0],
    last = compact.at(-1)!;
  return {
    x1: first.x,
    y1: first.y,
    x2: last.x,
    y2: last.y,
    path: compact.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '),
  };
}

/** Build a rectilinear visibility graph in the actual gaps between ALL panes.
 * No outside-frame shortcut, terminal interior, or guessed connection is allowed.
 * Reuse the graph for every connected pair and delivery in the same layout.
 */
export function createFabricRouter(boxes: readonly FabricBox[]) {
  const panes = boxes.filter(
    (r) => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
  );
  const coordinates = (axis: 'x' | 'y', size: 'width' | 'height') => {
    const edges = [...new Set(panes.flatMap((r) => [r[axis], r[axis] + r[size]]))].sort(
      (a, b) => a - b,
    );
    return [
      ...new Set([
        ...edges.slice(1).map((edge, i) => (edge + edges[i]) / 2),
        ...panes.map((r) => r[axis] + r[size] / 2),
      ]),
    ].sort((a, b) => a - b);
  };
  const xs = coordinates('x', 'width'),
    ys = coordinates('y', 'height');
  const points: Point[] = [];
  const graph: Edge[][] = [];
  const rows = new Map<number, number[]>(),
    cols = new Map<number, number[]>();
  const clear = (a: Point, b: Point, except?: string) =>
    panes.every((r) => r.id === except || !intersects(a, b, r));
  for (const y of ys)
    for (const x of xs) {
      const p = { x, y };
      if (!clear(p, p)) continue;
      const index = points.push(p) - 1;
      graph.push([]);
      rows.set(y, [...(rows.get(y) ?? []), index]);
      cols.set(x, [...(cols.get(x) ?? []), index]);
    }
  for (const [axis, lines] of [rows, cols].entries())
    for (const indices of lines.values()) {
      for (let i = 1; i < indices.length; i++) {
        const a = indices[i - 1],
          b = indices[i];
        if (!clear(points[a], points[b])) continue;
        const length = Math.abs(points[a].x - points[b].x) + Math.abs(points[a].y - points[b].y);
        graph[a].push({ to: b, length, axis });
        graph[b].push({ to: a, length, axis });
      }
    }

  const docks = (r: FabricBox) =>
    points.flatMap((p, node) => {
      let dock: Point | undefined;
      if (p.x > r.x + CLEARANCE && p.x < r.x + r.width - CLEARANCE) {
        if (p.y < r.y) dock = { x: p.x, y: r.y };
        else if (p.y > r.y + r.height) dock = { x: p.x, y: r.y + r.height };
      } else if (p.y > r.y + CLEARANCE && p.y < r.y + r.height - CLEARANCE) {
        if (p.x < r.x) dock = { x: r.x, y: p.y };
        else if (p.x > r.x + r.width) dock = { x: r.x + r.width, y: p.y };
      }
      if (!dock || !clear(dock, p, r.id)) return [];
      const axis = dock.y === p.y ? 0 : 1;
      const length = Math.abs(dock.x - p.x) + Math.abs(dock.y - p.y);
      return [{ node, dock, axis, length }];
    });

  return (from: FabricBox, to: FabricBox) => {
    if (
      from.id === to.id ||
      !panes.some((r) => r.id === from.id) ||
      !panes.some((r) => r.id === to.id)
    )
      return null;
    // Retain the shortest facing-edge connection when its shared gap is clear.
    const top = Math.max(from.y, to.y),
      bottom = Math.min(from.y + from.height, to.y + to.height);
    const left = Math.max(from.x, to.x),
      right = Math.min(from.x + from.width, to.x + to.width);
    let direct: Point[] | undefined;
    if (bottom > top && (from.x + from.width < to.x || to.x + to.width < from.x)) {
      direct = [
        { x: from.x < to.x ? from.x + from.width : from.x, y: (top + bottom) / 2 },
        { x: from.x < to.x ? to.x : to.x + to.width, y: (top + bottom) / 2 },
      ];
    } else if (right > left && (from.y + from.height < to.y || to.y + to.height < from.y)) {
      direct = [
        { x: (left + right) / 2, y: from.y < to.y ? from.y + from.height : from.y },
        { x: (left + right) / 2, y: from.y < to.y ? to.y : to.y + to.height },
      ];
    }
    if (
      direct &&
      panes.every(
        (r) =>
          !intersects(
            direct![0],
            direct![1],
            r,
            r.id === from.id || r.id === to.id ? 0 : CLEARANCE,
          ),
      )
    )
      return bridge(direct);

    const starts = docks(from),
      ends = docks(to);
    const costs = new Map<number, number>(),
      previous = new Map<number, number>();
    const origins = new Map<number, Point>();
    const queue: { key: number; cost: number }[] = [];
    for (const start of starts) {
      const key = start.node * 2 + start.axis;
      if (start.length >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, start.length);
      origins.set(key, start.dock);
      queue.push({ key, cost: start.length });
    }
    let best = Infinity,
      finalKey = -1,
      finalDock: Point | undefined;
    while (queue.length) {
      queue.sort((a, b) => b.cost - a.cost);
      const current = queue.pop()!;
      if (current.cost !== costs.get(current.key) || current.cost >= best) continue;
      const node = Math.floor(current.key / 2),
        axis = current.key % 2;
      for (const end of ends)
        if (end.node === node) {
          const cost = current.cost + end.length + (axis === end.axis ? 0 : BEND_COST);
          if (cost < best) {
            best = cost;
            finalKey = current.key;
            finalDock = end.dock;
          }
        }
      for (const edge of graph[node]) {
        const key = edge.to * 2 + edge.axis;
        const cost = current.cost + edge.length + (axis === edge.axis ? 0 : BEND_COST);
        if (cost >= (costs.get(key) ?? Infinity)) continue;
        costs.set(key, cost);
        previous.set(key, current.key);
        queue.push({ key, cost });
      }
    }
    if (!finalDock) return null;
    const path = [finalDock];
    let key = finalKey;
    for (;;) {
      path.push(points[Math.floor(key / 2)]);
      const parent = previous.get(key);
      if (parent === undefined) break;
      key = parent;
    }
    path.push(origins.get(key)!);
    return bridge(path.reverse());
  };
}

export function fabricBridge(
  from: FabricBox,
  to: FabricBox,
  boxes: readonly FabricBox[] = [from, to],
) {
  return createFabricRouter(boxes)(from, to);
}
