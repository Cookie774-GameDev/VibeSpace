import type { ContextBudgetKind } from './contracts';
import type { TokenOptimizationSegment } from './tokenOptimizerService';

const MAX_ITEMS_PER_GROUP = 256;
const MAX_TEXT_CHARS = 2_000_000;

export interface RankedContextBridgeItem {
  readonly text: string;
  readonly relevance: number;
}

export interface ContextMapRetrievalBridgeItem {
  readonly exactExcerpt: string;
  readonly ranking: Readonly<{ score: number }>;
}

export interface RepositoryContextBridgeItem extends RankedContextBridgeItem {
  readonly kind: 'file' | 'symbol';
  readonly duplicateOfIndex?: number;
  readonly supersededByIndex?: number;
}

export interface ContextSegmentBridgeInput {
  readonly systemInstructions?: readonly string[];
  readonly latestUserContent: string;
  readonly explicitAttachments?: readonly string[];
  readonly pinnedContext?: readonly string[];
  readonly toolSchemas?: readonly string[];
  readonly contextMapItems?: readonly ContextMapRetrievalBridgeItem[];
  readonly repositoryCandidates?: readonly RepositoryContextBridgeItem[];
}

function safeText(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_CHARS) {
    throw new Error(`Invalid ${label} content.`);
  }
  return value;
}

function relevance(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid ${label} relevance.`);
  }
  return value;
}

function bounded<T>(items: readonly T[] | undefined, label: string): readonly T[] {
  const result = items ?? [];
  if (result.length > MAX_ITEMS_PER_GROUP) {
    throw new Error(`Too many ${label} items.`);
  }
  return result;
}

function safeId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function segment(input: {
  id: string;
  kind: ContextBudgetKind;
  text: string;
  relevance: number;
  protected: boolean;
  reason: string;
  duplicateOf?: string;
  supersededBy?: string;
}): TokenOptimizationSegment {
  return Object.freeze({ ...input });
}

export function mapContextToTokenOptimizationSegments(
  input: ContextSegmentBridgeInput,
): readonly TokenOptimizationSegment[] {
  const result: TokenOptimizationSegment[] = [];

  bounded(input.systemInstructions, 'system instruction').forEach((text, index) => {
    result.push(
      segment({
        id: safeId('system', index),
        kind: 'system_instruction',
        text: safeText(text, 'system instruction'),
        relevance: 1,
        protected: true,
        reason: 'Protected system authority',
      }),
    );
  });

  result.push(
    segment({
      id: 'latest-user-001',
      kind: 'latest_user_message',
      text: safeText(input.latestUserContent, 'latest user'),
      relevance: 1,
      protected: true,
      reason: 'Protected latest user request',
    }),
  );

  bounded(input.explicitAttachments, 'explicit attachment').forEach((text, index) => {
    result.push(
      segment({
        id: safeId('attachment', index),
        kind: 'explicit_attachment',
        text: safeText(text, 'explicit attachment'),
        relevance: 1,
        protected: true,
        reason: 'Protected explicit attachment',
      }),
    );
  });

  bounded(input.pinnedContext, 'pinned context').forEach((text, index) => {
    result.push(
      segment({
        id: safeId('pin', index),
        kind: 'pinned_context_node',
        text: safeText(text, 'pinned context'),
        relevance: 1,
        protected: true,
        reason: 'Protected user-pinned context',
      }),
    );
  });

  bounded(input.toolSchemas, 'tool schema').forEach((text, index) => {
    result.push(
      segment({
        id: safeId('tool-schema', index),
        kind: 'tool_schema',
        text: safeText(text, 'tool schema'),
        relevance: 1,
        protected: true,
        reason: 'Protected tool contract',
      }),
    );
  });

  bounded(input.contextMapItems, 'Context Map').forEach((item, index) => {
    result.push(
      segment({
        id: safeId('context-map', index),
        kind: 'context_map_node',
        text: safeText(item.exactExcerpt, 'Context Map'),
        relevance: relevance(item.ranking.score, 'Context Map'),
        protected: false,
        reason: 'Retrieved Context Map evidence',
      }),
    );
  });

  const repositories = bounded(input.repositoryCandidates, 'repository candidate');
  repositories.forEach((item, index) => {
    const duplicateOf =
      item.duplicateOfIndex === undefined
        ? undefined
        : repositoryReference(item.duplicateOfIndex, index, repositories.length, 'duplicate');
    const supersededBy =
      item.supersededByIndex === undefined
        ? undefined
        : repositoryReference(item.supersededByIndex, index, repositories.length, 'superseded');
    result.push(
      segment({
        id: safeId('repository', index),
        kind: item.kind === 'file' ? 'repository_file' : 'repository_symbol',
        text: safeText(item.text, 'repository candidate'),
        relevance: relevance(item.relevance, 'repository candidate'),
        protected: false,
        reason:
          item.kind === 'file'
            ? 'Optional repository file candidate'
            : 'Optional repository symbol candidate',
        ...(duplicateOf ? { duplicateOf } : {}),
        ...(supersededBy ? { supersededBy } : {}),
      }),
    );
  });

  return Object.freeze(result);
}

function repositoryReference(
  targetIndex: number,
  sourceIndex: number,
  length: number,
  label: string,
): string {
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= length ||
    targetIndex === sourceIndex
  ) {
    throw new Error(`Invalid repository ${label} reference.`);
  }
  return safeId('repository', targetIndex);
}
