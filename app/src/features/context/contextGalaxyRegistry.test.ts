import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearContextGalaxySnapshotsForTests,
  contextTreeToGalaxyData,
  getContextGalaxySnapshot,
  publishContextGalaxySnapshot,
  subscribeContextGalaxySnapshots,
} from './contextGalaxyRegistry';

const node = (id: string) => ({
  id,
  label: id,
  description: `${id} description`,
  parentId: null,
  groupId: 'root',
  depth: 0,
  order: 0,
  radius: 12,
});

afterEach(() => clearContextGalaxySnapshotsForTests());

describe('contextGalaxyRegistry', () => {
  it('adapts the persisted Context hierarchy without changing its categories', () => {
    const result = contextTreeToGalaxyData({
      version: 1,
      projectId: 'project-a',
      rootDir: 'C:/project-a',
      generatedAt: 1,
      model: 'local',
      fileCount: 1,
      totalBytes: 4,
      summary: 'Project context',
      nodes: [
        {
          id: 'sources',
          title: 'Sources',
          kind: 'area',
          summary: '',
          children: [{ id: 'file', title: 'readme.md', kind: 'file', summary: 'Read me' }],
        },
      ],
    });

    expect(result.nodes.map((value) => value.id)).toEqual(['sources', 'file']);
    expect(result.nodes[0]?.description).toContain('Connected files');
    expect(result.edges).toEqual([{ id: 'sources:file', from: 'sources', to: 'file' }]);
  });

  it('isolates snapshots by both account and project', () => {
    publishContextGalaxySnapshot({
      accountId: 'account-a',
      projectId: 'project-a',
      mapId: 'map-a',
      nodes: [node('root-a')],
      edges: [],
      selectedId: 'root-a',
      activityNodeIds: [],
    });

    expect(getContextGalaxySnapshot('account-a', 'project-a')?.mapId).toBe('map-a');
    expect(getContextGalaxySnapshot('account-a', 'project-b')).toBeNull();
    expect(getContextGalaxySnapshot('account-b', 'project-a')).toBeNull();
  });

  it('bounds the live bridge and retains selected and active nodes', () => {
    const nodes = Array.from({ length: 1_100 }, (_, index) => ({
      ...node(`node-${index}`),
      order: index,
    }));
    publishContextGalaxySnapshot({
      accountId: 'account-a',
      projectId: null,
      mapId: 'map-a',
      nodes,
      edges: nodes.slice(1).map((value, index) => ({
        id: `edge-${index}`,
        from: 'node-0',
        to: value.id,
      })),
      selectedId: 'node-1099',
      activityNodeIds: ['node-1098'],
    });

    const snapshot = getContextGalaxySnapshot('account-a', null);
    expect(snapshot?.nodes.length).toBeLessThanOrEqual(1_000);
    expect(snapshot?.edges.length).toBeLessThanOrEqual(1_600);
    expect(snapshot?.nodes.some((value) => value.id === 'node-1099')).toBe(true);
    expect(snapshot?.nodes.some((value) => value.id === 'node-1098')).toBe(true);
  });

  it('notifies subscribers and makes stale cleanup lease-safe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeContextGalaxySnapshots(listener);
    const disposeOld = publishContextGalaxySnapshot({
      accountId: 'account-a',
      projectId: 'project-a',
      mapId: 'old',
      nodes: [node('old')],
      edges: [],
      selectedId: null,
      activityNodeIds: [],
    });
    publishContextGalaxySnapshot({
      accountId: 'account-a',
      projectId: 'project-a',
      mapId: 'new',
      nodes: [node('new')],
      edges: [],
      selectedId: null,
      activityNodeIds: [],
    });

    disposeOld();
    expect(getContextGalaxySnapshot('account-a', 'project-a')?.mapId).toBe('new');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
