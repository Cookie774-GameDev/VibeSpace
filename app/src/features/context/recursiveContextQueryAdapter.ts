import {
  ContextQueryError,
  type ContextQueryService,
  type ContextScope,
} from './contextQueryService';
import {
  parseCorpusTokenAddressQuery,
  serializeCorpusTokenAddressRoute,
  type CorpusScaleMetadata,
  type CorpusTokenAddress,
  type CorpusTokenCountInput,
} from './corpusScale';
import type {
  RecursiveContextEvidence,
  RecursiveContextRoundRequest,
  RecursiveContextRoundResult,
} from './recursiveContextPlanner';

function estimatedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ContextQueryError('cancelled');
  }
}

export function createRecursiveContextQueryAdapter(dependencies: {
  queryService: Pick<ContextQueryService, 'search' | 'open'>;
  scope: ContextScope;
  logicalAddressing?: Readonly<{
    corpus: Readonly<CorpusScaleMetadata>;
    shardSize: CorpusTokenCountInput;
  }>;
}) {
  return Object.freeze({
    async retrieveRound(
      request: RecursiveContextRoundRequest,
    ): Promise<RecursiveContextRoundResult> {
      abortIfNeeded(request.signal);
      const excluded = new Set(request.excludedEvidenceIds);
      const evidence: RecursiveContextEvidence[] = [];
      let remainingTokens = request.maxTokens;

      for (const query of request.queries) {
        if (evidence.length >= request.maxItems || remainingTokens <= 0) break;
        let logicalAddress: CorpusTokenAddress | undefined;
        let routedQuery = query;
        if (dependencies.logicalAddressing) {
          logicalAddress = parseCorpusTokenAddressQuery(
            dependencies.logicalAddressing.corpus,
            query,
            dependencies.logicalAddressing.shardSize,
          );
          routedQuery = serializeCorpusTokenAddressRoute(logicalAddress);
        }
        const found = await dependencies.queryService.search({
          scope: dependencies.scope,
          query: routedQuery,
          limit: request.maxItems - evidence.length,
          signal: request.signal,
        });
        abortIfNeeded(request.signal);
        for (const item of found.items) {
          if (
            evidence.length >= request.maxItems ||
            remainingTokens <= 0 ||
            excluded.has(item.pointer.id)
          ) {
            continue;
          }
          const opened = await dependencies.queryService.open({
            scope: dependencies.scope,
            pointer: item.pointer,
            maxBytes: Math.max(1, remainingTokens * 4),
            signal: request.signal,
          });
          abortIfNeeded(request.signal);
          if (!opened.text) continue;
          const tokens = estimatedTokens(opened.text);
          if (tokens > remainingTokens) continue;
          remainingTokens -= tokens;
          excluded.add(opened.pointer.id);
          evidence.push(
            Object.freeze({
              id: opened.pointer.id,
              exactExcerpt: opened.text,
              estimatedTokens: tokens,
              provenance: Object.freeze({
                sourceId: opened.record.sourceId,
                sourceRevision: opened.pointer.sourceVersion,
                contentDigest: `sha256:${opened.pointer.contentHash}` as const,
                indexedAt: opened.record.updatedAt ?? opened.record.createdAt,
                locator: logicalAddress
                  ? `${opened.record.contentRef}#token=${logicalAddress.position}&shard=${logicalAddress.shard}&offset=${logicalAddress.offset}`
                  : opened.record.contentRef,
              }),
            }),
          );
        }
      }

      return Object.freeze({
        evidence: Object.freeze(evidence),
        nextQueries: Object.freeze([]),
        complete: evidence.length > 0,
      });
    },
  });
}
