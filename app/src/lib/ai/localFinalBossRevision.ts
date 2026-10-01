import type { RunAgentRequest } from './router';
import type { ReasoningMode } from './reasoningControls';
import { llmContentToText, type LLMResponse } from './types';
import { reconcileExplicitExactLiteral } from './exactLiteralReply';

type RunAgent = (request: RunAgentRequest) => Promise<LLMResponse>;

const MAX_DRAFT_CHARS = 32_000;
const WORD_RE = /[a-z0-9][a-z0-9_-]{3,}/giu;
const STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'could',
  'design',
  'from',
  'have',
  'into',
  'local',
  'only',
  'please',
  'should',
  'that',
  'their',
  'there',
  'these',
  'this',
  'with',
  'would',
]);
const INVALID_POWERSHELL_SIGNALS = [
  /\bTest-Script\b/giu,
  /\[Transaction\]/giu,
  /\.LockObject\s*\(/giu,
  /\bRemove-ItemLock\b/giu,
  /\b(?:Get|Set)-Content\s+-FilePath\b/giu,
  /New-Object\s+-ComObject\s+PSNote\b/giu,
];

const REVISION_INSTRUCTION = [
  'Token Final Boss verification pass.',
  'Reread the original request and critically inspect the draft immediately above.',
  'Correct factual errors, invented APIs, invalid code, missing acceptance criteria, unsafe path or permission behavior, unsupported completion claims, and contradictions.',
  'Preserve any valid approval-gated action blocks exactly; never claim a tool ran without a real tool result.',
  'Prefer a precise, executable answer over extra length.',
  'Return only the corrected final answer. Do not mention the draft, this review, or private reasoning.',
].join(' ');

function boundedDraft(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= MAX_DRAFT_CHARS) return normalized;
  return normalized.slice(0, MAX_DRAFT_CHARS);
}

function meaningfulTerms(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(WORD_RE) ?? []).filter((term) => !STOP_WORDS.has(term)).slice(0, 80),
  );
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function candidateScore(originalRequest: string, candidate: string): number {
  const requestTerms = meaningfulTerms(originalRequest);
  const candidateTerms = meaningfulTerms(candidate);
  let score = 0;
  for (const term of requestTerms) {
    if (candidateTerms.has(term)) score += 4;
  }
  const fences = countMatches(candidate, /```/gu);
  if (fences % 2 === 0) score += 4;
  else score -= 12;
  if (/\b(?:verification|verify|tests?|checklist)\b/iu.test(originalRequest)) {
    score += /\b(?:verification|verify|tests?|checklist)\b/iu.test(candidate) ? 8 : -8;
  }
  if (/\bpowershell\b/iu.test(originalRequest)) {
    for (const signal of INVALID_POWERSHELL_SIGNALS) {
      score -= countMatches(candidate, signal) * 20;
    }
  }
  if (/\b(?:I|we)\s+(?:ran|executed|created|wrote|deleted|installed)\b/iu.test(candidate)) {
    score -= 16;
  }
  return score;
}

export function selectHigherQualityFinalBossCandidate(
  originalRequest: string,
  draft: string,
  revision: string,
): 'draft' | 'revision' {
  return candidateScore(originalRequest, revision) > candidateScore(originalRequest, draft)
    ? 'revision'
    : 'draft';
}

export function shouldRunLocalFinalBossRevision(
  mode: ReasoningMode | undefined,
  providerId: string,
): boolean {
  return (
    mode === 'token-final-boss' &&
    (providerId.toLowerCase() === 'ollama' || providerId.toLowerCase() === 'local')
  );
}

export async function runBoundedLocalFinalBossRevision(
  runAgent: RunAgent,
  request: RunAgentRequest,
): Promise<LLMResponse> {
  request.signal?.throwIfAborted();
  const draft = await runAgent({ ...request, onChunk: undefined });
  request.signal?.throwIfAborted();
  const draftText = boundedDraft(draft.text);
  if (!draftText) throw new Error('Token Final Boss draft was empty.');
  const originalRequest = [...request.messages]
    .reverse()
    .find((message) => message.role === 'user')?.content;
  const originalRequestText = originalRequest ? llmContentToText(originalRequest) : '';

  let revision: LLMResponse;
  try {
    revision = await runAgent({
      ...request,
      onChunk: undefined,
      messages: [
        ...request.messages,
        { role: 'assistant', content: draftText },
        { role: 'user', content: REVISION_INSTRUCTION },
      ],
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const reconciledDraftText = reconcileExplicitExactLiteral(originalRequestText, draft.text);
    request.onChunk?.({ delta: reconciledDraftText, first: true });
    request.onChunk?.({ delta: '', done: true });
    return { ...draft, text: reconciledDraftText };
  }
  request.signal?.throwIfAborted();
  const winner =
    selectHigherQualityFinalBossCandidate(originalRequestText, draftText, revision.text) ===
    'revision'
      ? revision
      : draft;
  const winnerText = reconcileExplicitExactLiteral(originalRequestText, winner.text);
  request.onChunk?.({ delta: winnerText, first: true });
  request.onChunk?.({ delta: '', done: true });

  return {
    ...winner,
    text: winnerText,
    usage: {
      input_tokens: draft.usage.input_tokens + revision.usage.input_tokens,
      output_tokens: draft.usage.output_tokens + revision.usage.output_tokens,
      cost_usd: draft.usage.cost_usd + revision.usage.cost_usd,
    },
  };
}
