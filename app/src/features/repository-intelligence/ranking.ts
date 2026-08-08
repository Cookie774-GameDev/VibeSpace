import type {
  RankedRepositoryCandidate,
  RepositoryCandidate,
  RepositorySelectionReason,
} from './contracts';

function assertCandidates(candidates: readonly RepositoryCandidate[]): void {
  const paths = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.path) throw new Error('Repository candidate path is required.');
    if (paths.has(candidate.path)) {
      throw new Error(`Duplicate repository candidate path ${candidate.path}.`);
    }
    paths.add(candidate.path);
    if (
      !Number.isSafeInteger(candidate.fullTokens) ||
      !Number.isSafeInteger(candidate.signatureTokens) ||
      !Number.isSafeInteger(candidate.metadataTokens) ||
      candidate.metadataTokens < 0 ||
      candidate.signatureTokens < candidate.metadataTokens ||
      candidate.fullTokens < candidate.signatureTokens
    ) {
      throw new Error(`Invalid token estimate for ${candidate.path}.`);
    }
    for (const relevance of [candidate.lexicalRelevance, candidate.taskRelevance]) {
      if (!Number.isFinite(relevance) || relevance < 0 || relevance > 1) {
        throw new Error(`Invalid relevance score for ${candidate.path}.`);
      }
    }
    if (
      !Number.isSafeInteger(candidate.incomingReferences) ||
      candidate.incomingReferences < 0 ||
      !Number.isSafeInteger(candidate.outgoingReferences) ||
      candidate.outgoingReferences < 0
    ) {
      throw new Error(`Invalid reference count for ${candidate.path}.`);
    }
  }
}

function rank(candidate: RepositoryCandidate): RankedRepositoryCandidate {
  const reasons: RepositorySelectionReason[] = [];
  let score = 0;
  if (candidate.explicit) {
    score += 100;
    reasons.push('explicitly_selected');
  }
  if (candidate.userPinned) {
    score += 80;
    reasons.push('user_pinned');
  }
  if (candidate.active) {
    score += 50;
    reasons.push('active_file');
  }
  if (candidate.importedByActiveFile) {
    score += 30;
    reasons.push('imported_by_active_file');
  }
  if (candidate.taskRelevance > 0) {
    score += candidate.taskRelevance * 20;
    reasons.push('task_relevance');
  }
  if (candidate.lexicalRelevance > 0) {
    score += candidate.lexicalRelevance * 15;
    reasons.push('lexical_relevance');
  }
  const referenceCount = candidate.incomingReferences * 2 + candidate.outgoingReferences;
  if (referenceCount > 0) {
    score += Math.log2(referenceCount + 1) * 5;
    reasons.push('reference_centrality');
  }
  return Object.freeze({
    ...candidate,
    symbols: Object.freeze([...candidate.symbols]),
    score,
    reasons: Object.freeze(reasons),
  });
}

export function rankRepositoryCandidates(
  candidates: readonly RepositoryCandidate[],
): readonly RankedRepositoryCandidate[] {
  assertCandidates(candidates);
  return Object.freeze(
    candidates
      .map(rank)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.path.length - right.path.length ||
          (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
      ),
  );
}
