import type {
  RankedRepositoryCandidate,
  RepositoryCandidate,
  RepositoryContextEntry,
  RepositoryContextPack,
  RepositoryExclusionReason,
  RepositoryRepresentation,
} from './contracts';
import { rankRepositoryCandidates } from './ranking';

function securityExclusion(candidate: RepositoryCandidate): RepositoryExclusionReason | undefined {
  if (!candidate.projectRelative) return 'outside_project';
  if (candidate.ignored) return 'ignored';
  if (candidate.generated) return 'generated';
  if (candidate.secretRisk) return 'secret_risk';
  if (!candidate.trusted) return 'untrusted';
  return undefined;
}

function chooseRepresentation(
  candidate: RankedRepositoryCandidate,
  remaining: number,
): Readonly<{ representation: RepositoryRepresentation; tokens: number }> | undefined {
  if (candidate.fullTokens <= remaining) {
    return { representation: 'full', tokens: candidate.fullTokens };
  }
  if (candidate.signatureTokens <= remaining) {
    return { representation: 'signatures', tokens: candidate.signatureTokens };
  }
  if (candidate.metadataTokens <= remaining) {
    return { representation: 'metadata', tokens: candidate.metadataTokens };
  }
  return undefined;
}

export function buildRepositoryContextPack(input: {
  candidates: readonly RepositoryCandidate[];
  tokenBudget: number;
}): RepositoryContextPack {
  if (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget < 0) {
    throw new Error('Invalid repository context token budget.');
  }

  const ranked = rankRepositoryCandidates(input.candidates);
  const entries: RepositoryContextEntry[] = [];
  const exclusions: { path: string; reason: RepositoryExclusionReason }[] = [];
  let totalTokens = 0;

  for (const candidate of ranked) {
    const unsafe = securityExclusion(candidate);
    if (unsafe) {
      exclusions.push({ path: candidate.path, reason: unsafe });
      continue;
    }
    if (candidate.score === 0) {
      exclusions.push({ path: candidate.path, reason: 'irrelevant' });
      continue;
    }
    const selection = chooseRepresentation(candidate, input.tokenBudget - totalTokens);
    if (!selection) {
      exclusions.push({ path: candidate.path, reason: 'over_budget' });
      continue;
    }
    entries.push(
      Object.freeze({
        path: candidate.path,
        language: candidate.language,
        representation: selection.representation,
        tokens: selection.tokens,
        score: candidate.score,
        reasons: candidate.reasons,
        symbols: candidate.symbols,
      }),
    );
    totalTokens += selection.tokens;
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    exclusions: Object.freeze(exclusions.map((entry) => Object.freeze(entry))),
    totalTokens,
    remainingTokens: input.tokenBudget - totalTokens,
  });
}
