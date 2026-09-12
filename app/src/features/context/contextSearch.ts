import type { ContextTreeNode } from './tree';

export type ContextSearchReason = 'title' | 'path' | 'tag' | 'summary';

export interface ContextSearchResult {
  node: ContextTreeNode;
  reason: ContextSearchReason;
  score: number;
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function fieldScore(
  value: string,
  query: string,
  weights: readonly [number, number, number],
): number {
  if (!value) return 0;
  if (value === query) return weights[0];
  if (value.startsWith(query)) return weights[1];
  const boundary = value.search(new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(query)}`, 'iu'));
  if (boundary >= 0) return weights[2];
  return value.includes(query) ? Math.max(1, weights[2] - 20) : 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic, local-only Context search. One-character queries stay
 * intentionally narrow so common letters do not return the same first 200
 * nodes from traversal order.
 */
export function searchContextNodes(
  nodes: readonly ContextTreeNode[],
  rawQuery: string,
  limit = 200,
): readonly ContextSearchResult[] {
  const query = normalized(rawQuery).slice(0, 500);
  if (!query || limit <= 0) return [];
  const oneCharacter = query.length === 1;

  return nodes
    .flatMap((node): ContextSearchResult[] => {
      const title = normalized(node.title);
      const path = normalized(node.path);
      const tags = (node.tags ?? []).map(normalized);
      const summary = normalized(node.summary);
      if (oneCharacter) {
        const basename = path.split(/[\\/]/u).at(-1) ?? '';
        const score = title.startsWith(query) ? 110 : basename.startsWith(query) ? 105 : 0;
        return score > 0
          ? [{ node, reason: title.startsWith(query) ? 'title' : 'path', score }]
          : [];
      }

      const candidates: Array<{
        reason: ContextSearchReason;
        score: number;
      }> = [
        { reason: 'title', score: fieldScore(title, query, [120, 110, 95]) },
        { reason: 'path', score: fieldScore(path, query, [115, 105, 90]) },
      ];
      candidates.push(
        {
          reason: 'tag',
          score: Math.max(0, ...tags.map((tag) => fieldScore(tag, query, [100, 92, 82]))),
        },
        { reason: 'summary', score: fieldScore(summary, query, [75, 68, 58]) },
      );
      const best = candidates.sort((left, right) => right.score - left.score)[0]!;
      return best.score > 0 ? [{ node, ...best }] : [];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.node.title.localeCompare(right.node.title) ||
        left.node.id.localeCompare(right.node.id),
    )
    .slice(0, Math.min(200, Math.max(0, limit)));
}
