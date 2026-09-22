import type { createFabricRouter, FabricBox } from './fabricRouting';

/** Join every reachable member through real gaps, independently of click order. */
export function fabricConnections(
  members: readonly FabricBox[],
  route: ReturnType<typeof createFabricRouter>,
) {
  const groups = new Map(members.map((member) => [member.id, member.id]));
  const pairs = members.flatMap((from, i) =>
    members
      .slice(i + 1)
      .map((to) => ({
        from,
        to,
        distance: Math.hypot(
          from.x + from.width / 2 - to.x - to.width / 2,
          from.y + from.height / 2 - to.y - to.height / 2,
        ),
      })),
  );
  pairs.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.from.id.localeCompare(b.from.id) ||
      a.to.id.localeCompare(b.to.id),
  );
  const connections = [];
  for (const { from, to } of pairs) {
    const group = groups.get(from.id),
      other = groups.get(to.id);
    if (group === other) continue;
    const bridge = route(from, to);
    if (!bridge) continue;
    connections.push({ from, to, bridge });
    for (const [id, value] of groups) if (value === other) groups.set(id, group!);
    if (connections.length === members.length - 1) break;
  }
  return connections;
}
