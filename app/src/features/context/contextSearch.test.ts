import { describe, expect, it } from 'vitest';
import type { ContextTreeNode } from './tree';
import { searchContextNodes } from './contextSearch';

const node = (
  id: string,
  title: string,
  path: string,
  summary: string,
  tags: readonly string[] = [],
): ContextTreeNode => ({
  id,
  kind: 'file',
  title,
  path,
  summary,
  tags: [...tags],
  sizeBytes: 1,
  createdAt: 1,
  modifiedAt: 1,
  children: [],
});

describe('Context Map search ranking', () => {
  const nodes = [
    node('api', 'apiClient.ts', 'src/api/apiClient.ts', 'HTTP client', ['network']),
    node('ui', 'UserInterface.tsx', 'src/ui/UserInterface.tsx', 'Application shell', ['frontend']),
    node('index', 'index.ts', 'src/index.ts', 'Exports the public API'),
    node('logs', 'logger.ts', 'src/infra/logger.ts', 'Writes diagnostic lines', ['telemetry']),
  ];

  it('ranks exact title and path matches ahead of broad summary matches', () => {
    expect(searchContextNodes(nodes, 'api').map(({ node }) => node.id)).toEqual(['api', 'index']);
  });

  it('keeps one-character searches specific to title and path prefixes', () => {
    expect(searchContextNodes(nodes, 'u').map(({ node }) => node.id)).toEqual(['ui']);
    expect(searchContextNodes(nodes, 'i').map(({ node }) => node.id)).toEqual(['index']);
    expect(searchContextNodes(nodes, 'l').map(({ node }) => node.id)).toEqual(['logs']);
  });

  it('returns deterministic match reasons and respects the result cap', () => {
    const result = searchContextNodes(nodes, 'frontend', 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ node: { id: 'ui' }, reason: 'tag' });
  });
});
