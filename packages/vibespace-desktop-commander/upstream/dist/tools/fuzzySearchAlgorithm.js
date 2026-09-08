/**
 * Pure fuzzy-search algorithm, shared by the main thread (fuzzySearch.ts)
 * and the worker thread (fuzzySearchWorker.ts). This is the single source
 * of truth for the algorithm — do not fork it.
 *
 * Must stay side-effect free with no imports beyond fastest-levenshtein:
 * telemetry lives in the caller (metrics are returned, not captured here),
 * and a small module graph keeps worker spawn cheap.
 */
import { distance } from 'fastest-levenshtein';
/**
 * Finds the closest match to a query string within text using fuzzy matching.
 * Returns the match plus timing/iteration metrics for the caller to report.
 */
export function fuzzyIndexOf(text, query) {
    const startTime = performance.now();
    const metrics = { iterativeTimeMs: 0, iterations: 0, segmentLength: 0 };
    const match = recursiveFuzzyIndexOf(text, query, 0, text.length, Infinity, metrics);
    return {
        match,
        metrics: { ...metrics, executionTimeMs: performance.now() - startTime }
    };
}
/**
 * Recursively narrows the search to the half of the text with the better
 * Levenshtein distance, falling back to iterative refinement when the
 * segment is small or no longer improving.
 */
function recursiveFuzzyIndexOf(text, query, start, end, parentDistance, metrics) {
    // For small text segments, use iterative approach
    if (end - start <= 2 * query.length) {
        return iterativeReduction(text, query, start, end, parentDistance, metrics);
    }
    let midPoint = start + Math.floor((end - start) / 2);
    let leftEnd = Math.min(end, midPoint + query.length); // Include query length to cover overlaps
    let rightStart = Math.max(start, midPoint - query.length); // Include query length to cover overlaps
    let leftDistance = distance(text.substring(start, leftEnd), query);
    let rightDistance = distance(text.substring(rightStart, end), query);
    let bestDistance = Math.min(leftDistance, parentDistance, rightDistance);
    // If parent distance is already the best, use iterative approach
    if (parentDistance === bestDistance) {
        return iterativeReduction(text, query, start, end, parentDistance, metrics);
    }
    // Recursively search the better half
    if (leftDistance < rightDistance) {
        return recursiveFuzzyIndexOf(text, query, start, leftEnd, bestDistance, metrics);
    }
    else {
        return recursiveFuzzyIndexOf(text, query, rightStart, end, bestDistance, metrics);
    }
}
/**
 * Iteratively refines the best match by shrinking the segment from both ends
 * while the Levenshtein distance keeps improving.
 */
function iterativeReduction(text, query, start, end, parentDistance, metrics) {
    const startTime = performance.now();
    let bestDistance = parentDistance;
    let bestStart = start;
    let bestEnd = end;
    // Improve start position
    let nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestStart++;
        nextDistance = distance(text.substring(bestStart + 1, bestEnd), query);
        metrics.iterations++;
    }
    // Improve end position
    nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);
    while (nextDistance < bestDistance) {
        bestDistance = nextDistance;
        bestEnd--;
        nextDistance = distance(text.substring(bestStart, bestEnd - 1), query);
        metrics.iterations++;
    }
    metrics.iterativeTimeMs = performance.now() - startTime;
    metrics.segmentLength = end - start;
    return {
        start: bestStart,
        end: bestEnd,
        value: text.substring(bestStart, bestEnd),
        distance: bestDistance
    };
}
