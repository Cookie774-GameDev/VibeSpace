import { describe, expect, it } from 'vitest';
import {
  buildGalaxyLayout,
  DEFAULT_GALAXY_CAMERA,
  projectGalaxyPoint,
  reduceGalaxyCamera,
  selectGalaxyLod,
  type GalaxyInputNode,
} from './contextGalaxyLayout';

const nodes: GalaxyInputNode[] = [
  { id: 'root', parentId: null, depth: 0, order: 0, radius: 24, groupId: 'root' },
  { id: 'sources', parentId: 'root', depth: 1, order: 0, radius: 18, groupId: 'sources' },
  { id: 'notes', parentId: 'root', depth: 1, order: 1, radius: 18, groupId: 'notes' },
  { id: 'source-a', parentId: 'sources', depth: 2, order: 0, radius: 12, groupId: 'sources' },
  { id: 'note-a', parentId: 'notes', depth: 2, order: 0, radius: 12, groupId: 'notes' },
];

describe('context galaxy layout', () => {
  it('produces stable finite 3D sectors and keeps the root at the galactic center', () => {
    const first = buildGalaxyLayout(nodes);
    const second = buildGalaxyLayout([...nodes].reverse());
    expect(first).toEqual(second);
    expect(first.byId.get('root')).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(first.nodes.every((node) => [node.x, node.y, node.z].every(Number.isFinite))).toBe(true);
    expect(first.byId.get('sources')?.sector).not.toBe(first.byId.get('notes')?.sector);
  });

  it('clamps orbit, pan, and zoom camera state', () => {
    const orbited = reduceGalaxyCamera(DEFAULT_GALAXY_CAMERA, {
      type: 'orbit',
      deltaYaw: 100,
      deltaPitch: 100,
    });
    expect(orbited.pitch).toBeLessThan(Math.PI / 2);
    const zoomed = reduceGalaxyCamera(orbited, { type: 'zoom', factor: 0.00001 });
    expect(zoomed.distance).toBeGreaterThanOrEqual(220);
    const panned = reduceGalaxyCamera(zoomed, {
      type: 'pan',
      deltaX: Number.POSITIVE_INFINITY,
      deltaY: 50,
    });
    expect(Object.values(panned).every(Number.isFinite)).toBe(true);
  });

  it('projects depth with bounded perspective and rejects points behind the camera', () => {
    const visible = projectGalaxyPoint({ x: 0, y: 0, z: 0 }, DEFAULT_GALAXY_CAMERA, 800, 600);
    expect(visible).toMatchObject({ visible: true, x: 400, y: 300 });
    expect(visible.scale).toBeGreaterThan(0);
    const hidden = projectGalaxyPoint({ x: 0, y: 0, z: 4_000 }, DEFAULT_GALAXY_CAMERA, 800, 600);
    expect(hidden.visible).toBe(false);
  });

  it('strictly bounds LOD while retaining selected and active nodes', () => {
    const many = buildGalaxyLayout([
      nodes[0],
      ...Array.from({ length: 4_000 }, (_, index) => ({
        id: `node-${index}`,
        parentId: 'root',
        depth: 1,
        order: index,
        radius: 8,
        groupId: `group-${index % 8}`,
        importance: index / 4_000,
      })),
    ]);
    const edges = many.nodes.slice(1).map((node) => ({
      id: `edge-${node.id}`,
      from: 'root',
      to: node.id,
    }));
    const lod = selectGalaxyLod({
      nodes: many.nodes,
      edges,
      camera: DEFAULT_GALAXY_CAMERA,
      selectedId: 'node-3999',
      activityIds: new Set(['node-3998']),
      compact: true,
    });
    expect(lod.nodes.length).toBeLessThanOrEqual(180);
    expect(lod.edges.length).toBeLessThanOrEqual(260);
    expect(lod.nodes.some((node) => node.id === 'node-3999')).toBe(true);
    expect(lod.nodes.some((node) => node.id === 'node-3998')).toBe(true);
    expect(lod.clusteredCount).toBeGreaterThan(0);
  });
});
