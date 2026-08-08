import type { JarvisResponseMode } from '@/lib/jarvis/contracts';
import { assessJarvisDryHumor, JARVIS_DRY_HUMOR_POLICY, type JarvisHumorSituation } from './humor';
import { hasProviderOnlyTerminalState, type JarvisVerifiedFacts } from './modeClassifier';
import { getJarvisResponsePolicy } from './modes';

export type JarvisLintViolationDisposition = 'repairable' | 'deterministic' | 'quarantine';

export interface JarvisLintViolation {
  code: string;
  disposition: JarvisLintViolationDisposition;
  safeSummary: string;
}

function violation(
  code: string,
  disposition: JarvisLintViolationDisposition,
  safeSummary: string,
): JarvisLintViolation {
  return Object.freeze({ code, disposition, safeSummary });
}

const HUMOR_SIGNAL =
  /\b(?:joke|funny|hilarious|amusing|silver lining|rare victory|chosen drama|appears satisfied|apparently|rollback plan may wish|optimism)\b/i;
const BROAD_INTEGRATION_COUNT =
  /\b(?:(?:all(?:\s+of)?|every)(?:\s+(?:listed|supported|catalogued))?|thousands?\s+of|(?:\d{1,3}(?:,\d{3})+|\d{4,})\+?)\s+(?:apps?|applications?|integrations?)\b/i;

function hasZapierGatewayOverclaim(prose: string): boolean {
  return prose
    .split(/[.!?\n]+/u)
    .some(
      (sentence) =>
        /\bzapier\b/i.test(sentence) &&
        /\b(?:access|available|connected|use|usable)\b/i.test(sentence) &&
        BROAD_INTEGRATION_COUNT.test(sentence),
    );
}

function humorSituation(
  prose: string,
  mode: JarvisResponseMode,
  facts: Readonly<JarvisVerifiedFacts>,
): JarvisHumorSituation {
  if (/\b(?:credential|password|api key|access token|secret)\b/i.test(prose)) {
    return 'credential_exposure';
  }
  if (/\b(?:security breach|compromised|intrusion|exploit)\b/i.test(prose)) {
    return 'security_breach';
  }
  if (/\b(?:safety incident|danger|injury|unsafe)\b/i.test(prose)) return 'safety_incident';
  if (/\b(?:delete|destroy|wipe|erase|irreversible)\b/i.test(prose)) {
    return 'destructive_operation';
  }
  if (/\b(?:medical|health|hospital|diagnosis|symptom)\b/i.test(prose)) return 'health';
  if (/\b(?:grief|grieving|bereavement|died|death)\b/i.test(prose)) return 'grief';
  if (/\b(?:financial loss|lost money|bankrupt|debt)\b/i.test(prose)) return 'financial_harm';
  if (/\b(?:legal risk|lawsuit|criminal|liability)\b/i.test(prose)) return 'legal_risk';
  if (mode === 'sensitive' || /\b(?:distress|desperate|crisis|self[- ]?harm)\b/i.test(prose)) {
    return 'serious_user_distress';
  }
  if (
    /\b(?:second|third|fourth|fifth|again|repeated)\b[^.!?\n]{0,60}\bfail/i.test(prose) ||
    /\bfail[^.!?\n]{0,60}\b(?:again|repeated)\b/i.test(prose)
  ) {
    return 'repeated_failures';
  }
  if (
    hasProviderOnlyTerminalState(facts) ||
    facts.modelState === 'degraded' ||
    facts.modelState === 'unavailable' ||
    /\b(?:uncertain|unverified|unknown|maybe|might)\b/i.test(prose)
  ) {
    return 'uncertain_facts';
  }
  if (mode === 'action_success') return 'successful_completion';
  if (mode === 'action_failure') {
    return /\b(?:minor|recoverable|retryable)\b/i.test(prose)
      ? 'minor_recoverable_failure'
      : 'repeated_failures';
  }
  if (/\b(?:ambitious|deadline|timeline|deployment window)\b/i.test(prose)) {
    return 'ambitious_timeline';
  }
  if (/\b(?:complex|overengineered|many moving parts)\b/i.test(prose)) {
    return 'overly_complex_plan';
  }
  if (/\b(?:plan|planning|approach)\b/i.test(prose)) return 'low_risk_planning';
  return 'routine_technical_inconvenience';
}

function humorClauseCount(prose: string): number {
  return prose
    .split(/[.!?;]+(?:\s+|$)|\n+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause && HUMOR_SIGNAL.test(clause)).length;
}

function withoutEpistemicCompletionLanguage(prose: string): string {
  return prose
    .replace(
      /\b(?:verify|check|confirm|determine|establish|ascertain)\s+(?:whether|if)\b[^.!?\n]{0,80}?\b(?:done|completed|finished|succeeded|successful)\b/gi,
      '',
    )
    .replace(/\bif\b[^.!?\n]{0,80}?\b(?:done|completed|finished|succeeded|successful)\b/gi, '');
}

export function containsProtectedInformationDisclosure(prose: string): boolean {
  return (
    /\bhidden\s+(?:system\s+prompt|prompt|instructions?)\b/i.test(prose) ||
    /\b(?:here\s+is|verbatim|exact)\s+(?:the\s+)?(?:system\s+prompt|developer\s+message|chain\s+of\s+thought)\b/i.test(
      prose,
    ) ||
    /\b(?:system\s+prompt|developer\s+message|chain\s+of\s+thought)\s*:/i.test(prose) ||
    /\b(?:reveal|show|print|provide|send|share|repeat|expose)\b[\s\S]{0,80}\b(?:system\s+prompt|hidden\s+(?:prompt|instructions?)|developer\s+message|chain\s+of\s+thought)\b/i.test(
      prose,
    ) ||
    /\b(?:send|share|provide|reveal|enter)\b[\s\S]{0,80}\b(?:password|api key|token|credential|secret)\b/i.test(
      prose,
    )
  );
}

export function lintJarvisProse(
  prose: string,
  mode: JarvisResponseMode,
  facts: Readonly<JarvisVerifiedFacts>,
): readonly JarvisLintViolation[] {
  const violations: JarvisLintViolation[] = [];
  if (containsProtectedInformationDisclosure(prose)) {
    violations.push(
      violation('protected_information_leak', 'quarantine', 'Protected information disclosure.'),
    );
  }
  if (/^\s*(?:sure|of course|absolutely)[!,.:\s]/i.test(prose)) {
    violations.push(violation('generic_opener', 'repairable', 'Generic opening filler.'));
  }
  if (
    /^\s*(?:sure!|of course!|absolutely!|great question!|hi there!|i(?:'d| would) be happy to help)/i.test(
      prose,
    )
  ) {
    violations.push(violation('forbidden_opening', 'repairable', 'Forbidden generic opening.'));
  }
  if (
    /\b(?:as an ai(?: language model)?|i am just a computer program|i(?: do not| don't) have feelings)\b/i.test(
      prose,
    )
  ) {
    violations.push(
      violation('generic_identity_disclaimer', 'repairable', 'Generic identity disclaimer.'),
    );
  }
  if (
    /\b(?:contact (?:our |the )?support(?: team)?|for further assistance|valued customer|how may i assist)\b/i.test(
      prose,
    )
  ) {
    violations.push(
      violation('generic_service_language', 'repairable', 'Generic service language.'),
    );
  }
  if ((prose.match(/!/g) ?? []).length > 1 || /!{2,}/.test(prose)) {
    violations.push(
      violation('excessive_exclamation', 'repairable', 'Excessive exclamation marks.'),
    );
  }
  if (/\p{Extended_Pictographic}/u.test(prose)) {
    violations.push(violation('emoji', 'repairable', 'Conversational emoji.'));
  }
  if ((prose.match(/\bsir\b/gi) ?? []).length > 1) {
    violations.push(violation('sir_overuse', 'repairable', 'The address cadence is overused.'));
  }
  if ((prose.match(/\b(?:sorry|apologi[sz]e|apologies)\b/gi) ?? []).length > 1) {
    violations.push(violation('excessive_apology', 'repairable', 'Excessive apology.'));
  }
  if (mode !== 'long_form_delivery' && /^\s*#{1,6}\s+/m.test(prose)) {
    violations.push(violation('excessive_headings', 'repairable', 'Unnecessary heading.'));
  }
  const responsePolicy = getJarvisResponsePolicy(mode);
  const maxSentences = responsePolicy.maxSentences;
  const sentenceCount = prose
    .split(/[.!?]+(?:\s+|$)/)
    .map((item) => item.trim())
    .filter(Boolean).length;
  if (maxSentences !== null && sentenceCount > maxSentences) {
    violations.push(
      violation('response_mode_budget', 'repairable', 'Too many sentences for the response mode.'),
    );
  }
  const wordCount = prose.trim().match(/\S+/gu)?.length ?? 0;
  const maximumTargetWords = responsePolicy.targetWords?.[1];
  if (maximumTargetWords !== undefined && wordCount > maximumTargetWords) {
    violations.push(
      violation(
        'response_mode_word_budget',
        'repairable',
        'Prose exceeds the response mode word target.',
      ),
    );
  }
  if (/^\s*\{action\}/im.test(prose)) {
    violations.push(
      violation('unsupported_action_macro', 'deterministic', 'Unsupported action macro.'),
    );
  }
  const status = facts.executionState?.status;
  const completionClaims = withoutEpistemicCompletionLanguage(prose)
    .replace(
      /\b(?:not|never|has not|hasn't|had not|hadn't)\s+(?:completed|finished|succeeded)\b/gi,
      '',
    )
    .replace(/\bpartially\s+(?:done|completed|finished|succeeded|successful)\b/gi, '')
    .replace(/\bsome\b[^.!?\n]{0,80}\b(?:done|completed|finished|succeeded|successful)\b/gi, '');
  const runningClaims = prose.replace(/\b(?:not|never|is not|isn't)\s+running\b/gi, '');
  const claimsComplete = /\b(done|completed|finished|succeeded|successful)\b/i.test(
    completionClaims,
  );
  const claimsPartial =
    /\b(?:partially\s+(?:done|complete|completed|finished|succeeded|successful)|partial\s+(?:action|operation|task|command|execution|run|job|build|work|completion|result)|some\b[^.!?\n]{0,80}\b(?:done|completed|finished|succeeded|successful|incomplete|unfinished)|(?:action|operation|task|command|execution|run|job|build|work)\b[^.!?\n]{0,50}\b(?:incomplete|unfinished)|(?:incomplete|unfinished)\s+(?:action|operation|task|command|execution|run|job|build|work))\b/i.test(
      prose,
    );
  const claimsRunning = /\b(running|in progress|still working)\b/i.test(runningClaims);
  const terminalState = facts.terminalState;
  if (
    hasProviderOnlyTerminalState(facts) &&
    (claimsPartial ||
      /\b(?:done|completed|finished|succeeded|successful|partial|failed|cancelled|timed out)\b/i.test(
        prose,
      ))
  ) {
    violations.push(
      violation(
        'provider_only_terminal_claim',
        'deterministic',
        'Provider-only terminal state is not independently verified.',
      ),
    );
  }
  if (
    (claimsComplete && status !== undefined && status !== 'completed') ||
    (claimsRunning &&
      status !== undefined &&
      status !== 'running' &&
      status !== 'compiling' &&
      status !== 'queued') ||
    (claimsPartial && status !== 'partial') ||
    (claimsComplete && terminalState !== undefined && terminalState !== 'completed') ||
    (claimsRunning &&
      terminalState !== undefined &&
      terminalState !== 'running' &&
      terminalState !== 'queued')
  ) {
    violations.push(
      violation(
        'verified_state_contradiction',
        'deterministic',
        'Provider prose contradicts verified lifecycle state.',
      ),
    );
  }
  const capabilityContradiction = [...facts.plugins, ...facts.mcps].some((capability) => {
    const escapedId = capability.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const claim = new RegExp(
      `\\b${escapedId}\\b[^.!?\\n]{0,80}\\b(available|connected|authenticated)\\b`,
      'i',
    )
      .exec(prose)?.[1]
      ?.toLowerCase();
    if (!claim) return false;
    const rank = {
      planned: 0,
      unavailable: 0,
      degraded: 0,
      available: 1,
      connected: 2,
      authenticated: 3,
    } as const;
    return rank[claim as 'available' | 'connected' | 'authenticated'] > rank[capability.state];
  });
  if (capabilityContradiction || hasZapierGatewayOverclaim(prose)) {
    violations.push(
      violation(
        'verified_capability_contradiction',
        'deterministic',
        'Provider prose exceeds the verified capability state.',
      ),
    );
  }
  if (
    facts.modelState === 'unavailable' &&
    /\b(?:switched|fell back|using another model|changed models?)\b/i.test(prose)
  ) {
    violations.push(
      violation(
        'verified_model_contradiction',
        'deterministic',
        'Provider prose claims an unverified model switch.',
      ),
    );
  }
  const detectedHumorClauses = humorClauseCount(prose);
  if (detectedHumorClauses > 0) {
    const situation = humorSituation(prose, mode, facts);
    const totalClauseCount = prose
      .split(/[.!?;]+(?:\s+|$)|\n+/u)
      .map((clause) => clause.trim())
      .filter(Boolean).length;
    const clarityPreserved = totalClauseCount > detectedHumorClauses;
    const history = facts.humorHistory ?? {
      recentReplyCount: 4,
      recentHumorReplyCount: 0,
    };
    const assessment = assessJarvisDryHumor({
      situation,
      humorClauseCount: detectedHumorClauses,
      clarityPreserved,
      ...history,
    });
    if (
      JARVIS_DRY_HUMOR_POLICY.prohibitedSituations.includes(
        situation as (typeof JARVIS_DRY_HUMOR_POLICY.prohibitedSituations)[number],
      ) ||
      !getJarvisResponsePolicy(mode).allowHumor
    ) {
      violations.push(
        violation('inappropriate_humor', 'repairable', 'Humor is not appropriate here.'),
      );
    }
    if (
      assessment.reason === 'too_many_clauses' ||
      assessment.reason === 'not_a_minority' ||
      detectedHumorClauses > JARVIS_DRY_HUMOR_POLICY.maxClauses ||
      (history.recentHumorReplyCount + 1) / (history.recentReplyCount + 1) >=
        JARVIS_DRY_HUMOR_POLICY.maximumReplyShareExclusive
    ) {
      violations.push(
        violation('excessive_humor', 'repairable', 'Humor exceeds the conservative cadence.'),
      );
    }
    if (!clarityPreserved || assessment.reason === 'clarity_not_preserved') {
      violations.push(
        violation(
          'humor_obscures_clarity',
          'repairable',
          'Humor obscures the decision-relevant fact.',
        ),
      );
    }
  }
  return Object.freeze(violations);
}
