export interface GalaxyInputNode {
  id: string;
  parentId: string | null;
  depth: number;
  order: number;
  radius: number;
  groupId: string;
  importance?: number;
}

export interface GalaxyNode extends GalaxyInputNode {
  x: number;
  y: number;
  z: number;
  sector: number;
}

export interface GalaxyEdge {
  id: string;
  from: string;
  to: string;
}

export interface GalaxyLayout {
  nodes: GalaxyNode[];
  byId: Map<string, GalaxyNode>;
}

export interface GalaxyCamera {
  yaw: number;
  pitch: number;
  distance: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export type GalaxyCameraAction =
  | { type: 'orbit'; deltaYaw: number; deltaPitch: number }
  | { type: 'pan'; deltaX: number; deltaY: number }
  | { type: 'zoom'; factor: number }
  | { type: 'reset' };

export interface ProjectedGalaxyPoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
  visible: boolean;
}

export const DEFAULT_GALAXY_CAMERA: Readonly<GalaxyCamera> = Object.freeze({
  yaw: 0,
  pitch: -0.18,
  distance: 1_400,
  targetX: 0,
  targetY: 0,
  targetZ: 0,
});

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAX_PITCH = Math.PI / 2 - 0.08;
const MAX_TARGET = 10_000;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finite(value)));
}

function normalizedAngle(value: number): number {
  const angle = finite(value) % TAU;
  return angle < -Math.PI ? angle + TAU : angle > Math.PI ? angle - TAU : angle;
}

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function buildGalaxyLayout(input: readonly GalaxyInputNode[]): GalaxyLayout {
  const nodes = [...input].sort((left, right) => left.id.localeCompare(right.id));
  const sectorKeys = Array.from(
    new Set(
      nodes
        .filter((node) => node.depth > 0)
        .map((node) => node.groupId || node.parentId || node.id),
    ),
  ).sort();
  const sectorByKey = new Map(sectorKeys.map((key, index) => [key, index]));
  const sectorCount = Math.max(1, sectorKeys.length);
  const positioned = nodes.map<GalaxyNode>((node) => {
    if (node.depth <= 0) {
      return { ...node, x: 0, y: 0, z: 0, sector: -1 };
    }
    const key = node.groupId || node.parentId || node.id;
    const sector = sectorByKey.get(key) ?? 0;
    const sectorCenter = (sector / sectorCount) * TAU;
    const armPhase = node.order * GOLDEN_ANGLE + hashUnit(node.id) * 0.38;
    const spread = Math.min(Math.PI / Math.max(3, sectorCount), 0.72);
    const angle = sectorCenter + Math.sin(armPhase) * spread + node.depth * 0.09;
    const shell = 210 + node.depth * 185 + Math.sqrt(Math.max(0, node.order)) * 34;
    const elevation = (hashUnit(`${node.id}:z`) - 0.5) * Math.min(shell * 0.72, 460);
    return {
      ...node,
      x: Math.cos(angle) * shell,
      y: elevation,
      z: Math.sin(angle) * shell,
      sector,
    };
  });
  return { nodes: positioned, byId: new Map(positioned.map((node) => [node.id, node])) };
}

export function reduceGalaxyCamera(
  camera: Readonly<GalaxyCamera>,
  action: GalaxyCameraAction,
): GalaxyCamera {
  if (action.type === 'reset') return { ...DEFAULT_GALAXY_CAMERA };
  if (action.type === 'orbit') {
    return {
      ...camera,
      yaw: normalizedAngle(camera.yaw + finite(action.deltaYaw)),
      pitch: clamp(camera.pitch + finite(action.deltaPitch), -MAX_PITCH, MAX_PITCH),
    };
  }
  if (action.type === 'zoom') {
    return {
      ...camera,
      distance: clamp(camera.distance * finite(action.factor, 1), 220, 8_000),
    };
  }
  return {
    ...camera,
    targetX: clamp(camera.targetX + finite(action.deltaX), -MAX_TARGET, MAX_TARGET),
    targetY: clamp(camera.targetY + finite(action.deltaY), -MAX_TARGET, MAX_TARGET),
  };
}

export function projectGalaxyPoint(
  point: Pick<GalaxyNode, 'x' | 'y' | 'z'>,
  camera: Readonly<GalaxyCamera>,
  width: number,
  height: number,
): ProjectedGalaxyPoint {
  const safeWidth = Math.max(1, finite(width, 1));
  const safeHeight = Math.max(1, finite(height, 1));
  const x = finite(point.x) - camera.targetX;
  const y = finite(point.y) - camera.targetY;
  const z = finite(point.z) - camera.targetZ;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const yawX = x * cosYaw - z * sinYaw;
  const yawZ = x * sinYaw + z * cosYaw;
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const pitchY = y * cosPitch - yawZ * sinPitch;
  const pitchZ = y * sinPitch + yawZ * cosPitch;
  const depth = camera.distance - pitchZ;
  if (!Number.isFinite(depth) || depth <= 20) {
    return { x: safeWidth / 2, y: safeHeight / 2, depth, scale: 0, visible: false };
  }
  const focal = Math.min(safeWidth, safeHeight) * 0.9;
  const scale = focal / depth;
  const projectedX = safeWidth / 2 + yawX * scale;
  const projectedY = safeHeight / 2 - pitchY * scale;
  return {
    x: projectedX,
    y: projectedY,
    depth,
    scale,
    visible:
      projectedX >= -80 &&
      projectedX <= safeWidth + 80 &&
      projectedY >= -80 &&
      projectedY <= safeHeight + 80,
  };
}

export function selectGalaxyLod(input: {
  nodes: readonly GalaxyNode[];
  edges: readonly GalaxyEdge[];
  camera: Readonly<GalaxyCamera>;
  selectedId: string | null;
  activityIds: ReadonlySet<string>;
  compact: boolean;
}): {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  clusteredCount: number;
} {
  const nodeLimit = input.compact ? 180 : 900;
  const edgeLimit = input.compact ? 260 : 1_600;
  if (input.nodes.length <= nodeLimit) {
    const ids = new Set(input.nodes.map((node) => node.id));
    return {
      nodes: [...input.nodes],
      edges: input.edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .slice(0, edgeLimit),
      clusteredCount: 0,
    };
  }
  const score = (node: GalaxyNode): number => {
    if (node.depth === 0) return 4_000_000;
    if (node.id === input.selectedId) return 3_000_000;
    if (input.activityIds.has(node.id)) return 2_000_000;
    const dx = node.x - input.camera.targetX;
    const dy = node.y - input.camera.targetY;
    const dz = node.z - input.camera.targetZ;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return clamp(node.importance ?? 0, 0, 5) * 2_000 + 1_000 / Math.max(1, distance);
  };
  const groups = new Map<string, GalaxyNode[]>();
  for (const node of input.nodes) {
    const group = groups.get(node.groupId) ?? [];
    group.push(node);
    groups.set(node.groupId, group);
  }
  for (const group of groups.values()) group.sort((left, right) => score(right) - score(left));
  const selected: GalaxyNode[] = [];
  const selectedIds = new Set<string>();
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let index = 0; selected.length < nodeLimit; index += 1) {
    let added = false;
    for (const [, group] of orderedGroups) {
      const node = group[index];
      if (!node || selectedIds.has(node.id)) continue;
      selected.push(node);
      selectedIds.add(node.id);
      added = true;
      if (selected.length === nodeLimit) break;
    }
    if (!added) break;
  }
  selected.sort((left, right) => score(right) - score(left));
  const edges = input.edges
    .filter((edge) => selectedIds.has(edge.from) && selectedIds.has(edge.to))
    .slice(0, edgeLimit);
  return {
    nodes: selected,
    edges,
    clusteredCount: Math.max(0, input.nodes.length - selected.length),
  };
}
