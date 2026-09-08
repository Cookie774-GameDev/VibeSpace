/**
 * Pure fuzzy-search algorithm, shared by the main thread (fuzzySearch.ts)
 * and the worker thread (fuzzySearchWorker.ts). This is the single source
 * of truth for the algorithm — do not fork it.
 *
 * Must stay side-effect free with no imports beyond fastest-levenshtein:
 * telemetry lives in the caller (metrics are returned, not captured here),
 * and a small module graph keeps worker spawn cheap.
 */
export interface FuzzyMatch {
    start: number;
    end: number;
    value: string;
    distance: number;
}
export interface FuzzySearchMetrics {
    /** Total wall time of the search in ms */
    executionTimeMs: number;
    /** Wall time of the final iterative refinement phase in ms */
    iterativeTimeMs: number;
    /** Iterations spent in the iterative refinement phase */
    iterations: number;
    /** Length of the segment handed to iterative refinement */
    segmentLength: number;
}
export interface FuzzySearchResult {
    match: FuzzyMatch;
    metrics: FuzzySearchMetrics;
}
/**
 * Finds the closest match to a query string within text using fuzzy matching.
 * Returns the match plus timing/iteration metrics for the caller to report.
 */
export declare function fuzzyIndexOf(text: string, query: string): FuzzySearchResult;
