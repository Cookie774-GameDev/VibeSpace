/** Closed diagnostic metadata; never retain native errors, queries or paths. */
export class ContextSearchReadinessError extends Error {
  readonly code: 'context_index_unavailable' | 'context_search_failed';
  constructor(readonly reason: 'index_empty_or_rebuild' | 'index_status_failed' | 'lexical_query_failed') {
    super('The selected context source index could not answer this search.');
    this.name = 'ContextSearchReadinessError';
    this.code = reason === 'lexical_query_failed' ? 'context_search_failed' : 'context_index_unavailable';
  }
}