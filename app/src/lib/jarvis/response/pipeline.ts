import type {
  JarvisRequestEnvelope,
  JarvisResponseEnvelope,
  JarvisModelSnapshot,
} from '@/lib/jarvis/contracts';
import { validateJarvisResponseEnvelope } from '@/lib/jarvis/contracts';
import type { Part } from '@/types';
import { parseActionBlocks } from '@/lib/actions';
import { inferFallbackActionProposals } from '@/lib/actions/fallbackActions';
import { parseJarvisPlanBlocks } from '@/features/jarvis-interaction/planParser';
import { parseJarvisQuestionBlocks } from '@/features/jarvis-interaction/questionParser';
import { parseJarvisPermissionBlocks } from '@/features/jarvis-interaction/permissionParser';
import { deepFreezeJarvisCopy } from '@/lib/jarvis/requestEnvelope';
import {
  containsProtectedInformationDisclosure,
  lintJarvisProse,
  type JarvisLintViolation,
} from './linter';
import {
  classifyJarvisResponseMode,
  hasProviderOnlyTerminalState,
  type JarvisVerifiedFacts,
} from './modeClassifier';
import { repairJarvisProseOnce, type JarvisRepairPort } from './repair';
import {
  buildJarvisSensitiveFallback,
  classifyJarvisSensitiveTopic,
  lintJarvisSensitiveProse,
  type JarvisSensitiveTopic,
} from './sensitive';
import { deriveJarvisSpokenText } from './spokenDelivery';
import {
  formatJarvisVerifiedNarration,
  INVALID_STRUCTURED_REGION_TEMPLATE,
  QUARANTINED_RESPONSE_TEMPLATE,
  verifiedResponseTemplate,
} from './templates';
import {
  jarvisRegionPlaceholder,
  restoreJarvisStructuredRegions,
  tokenizeJarvisResponse,
} from './tokenizer';
import { enforceJarvisOutputReferencePolicy } from './outputReferencePolicy';

export interface RawProviderResponse {
  text: string;
  provider: JarvisModelSnapshot;
  verifiedFacts: JarvisVerifiedFacts;
  completedAt: number;
}

export class JarvisResponsePipelineError extends Error {
  readonly code = 'invalid_jarvis_response' as const;

  constructor(readonly validationErrors: readonly unknown[]) {
    super('The processed JARVIS response is invalid.');
    this.name = 'JarvisResponsePipelineError';
  }
}

const CURRENT_MODEL_QUERY_PATTERNS = Object.freeze([
  /^(?:which|what)\s+model\s+are\s+you\s+using$/i,
  /^(?:which|what)\s+model\s+is\s+(?:(?:currently|now)\s+)?(?:active|selected|in use)$/i,
  /^what(?:'s|\s+is)\s+(?:the\s+)?(?:current|active|selected)\s+model$/i,
  /^what\s+model\s+am\s+i\s+using$/i,
]);
const EMPTY_PROVIDER_RESPONSE_TEMPLATE =
  'I received an empty model reply instead of a usable answer. Please retry the request.';

function isCurrentModelStatusQuestion(userText: string): boolean {
  const normalized = userText
    .trim()
    .replace(/[?.!]+\s*$/u, '')
    .trim();
  return CURRENT_MODEL_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function safeViolation(
  code: string,
  disposition: JarvisLintViolation['disposition'],
  safeSummary: string,
): JarvisLintViolation {
  return Object.freeze({ code, disposition, safeSummary });
}

function sanitizeProse(prose: string): {
  prose: string;
  violations: readonly JarvisLintViolation[];
} {
  const placeholders = prose.match(/\uE000JARVIS_REGION_\d+\uE001/g) ?? [];
  if (containsProtectedInformationDisclosure(prose)) {
    return {
      prose: [QUARANTINED_RESPONSE_TEMPLATE, ...placeholders].join('\n\n'),
      violations: [
        safeViolation(
          'protected_information_leak',
          'quarantine',
          'Protected information disclosure.',
        ),
      ],
    };
  }
  if (/^\s*\{action\}/im.test(prose)) {
    return {
      prose: prose
        .split(/\r?\n/)
        .filter((line) => !/^\s*\{action\}/i.test(line))
        .join('\n'),
      violations: [
        safeViolation('unsupported_action_macro', 'deterministic', 'Unsupported action macro.'),
      ],
    };
  }
  return { prose, violations: [] };
}

function deterministicFallback(prose: string, facts: Readonly<JarvisVerifiedFacts>): string {
  if (facts.executionState?.status === 'awaiting_approval' && /\bcommand\b/i.test(prose)) {
    return 'The command is prepared and awaiting your authorisation, sir.';
  }
  const verified = verifiedResponseTemplate(facts);
  if (verified) return verified;
  let formatted = prose.replace(
    /^\s*(?:sure|of course|absolutely|great question|hi there|i(?:'d| would) be happy to help)[!,.:\s-]*/i,
    '',
  );
  formatted = formatted.replace(
    /\b(?:as an ai(?: language model)?|i am just a computer program|i(?: do not| don't) have feelings)\b[,.]?\s*/gi,
    '',
  );
  formatted = formatted.replace(
    /\b(?:contact (?:our |the )?support(?: team)?|for further assistance|valued customer|how may i assist)\b[,.]?\s*/gi,
    '',
  );
  formatted = formatted.replace(/^\s*#{1,6}\s+/gm, '');
  formatted = formatted.replace(/\p{Extended_Pictographic}/gu, '');
  formatted = formatted.replace(/!+/g, '.');

  let sirUsed = false;
  formatted = formatted.replace(/(?:,\s*)?\bsir\b/gi, (match) => {
    if (sirUsed) return '';
    sirUsed = true;
    return match;
  });

  let apologyUsed = false;
  formatted = (formatted.match(/[^.!?]+[.!?]*/g) ?? [formatted])
    .filter((sentence) => {
      if (!/\b(?:sorry|apologi[sz]e|apologies)\b/i.test(sentence)) return true;
      if (apologyUsed) return false;
      apologyUsed = true;
      return true;
    })
    .join(' ');
  formatted = formatted
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\.{2,}/g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return formatted || 'The response is ready, Sir.';
}

function lintResponseProse(
  prose: string,
  mode: JarvisResponseEnvelope['mode'],
  facts: Readonly<JarvisVerifiedFacts>,
  sensitiveTopic?: JarvisSensitiveTopic,
): readonly JarvisLintViolation[] {
  return [
    ...lintJarvisProse(prose, mode, facts),
    ...(sensitiveTopic ? lintJarvisSensitiveProse(prose, sensitiveTopic) : []),
  ];
}

function textParts(displayText: string): Part[] {
  return [{ kind: 'text', text: displayText }];
}

function withMissingPlaceholders(prose: string, placeholders: readonly string[]): string {
  const missing = placeholders.filter((placeholder) => !prose.includes(placeholder));
  return [prose, ...missing].filter(Boolean).join('\n\n');
}

function splitLongFormWrapper(prose: string):
  | Readonly<{
      wrapper: string;
      separator: string;
      artifact: string;
    }>
  | undefined {
  const separator = /\r?\n[ \t]*\r?\n/u.exec(prose);
  if (!separator || separator.index === 0) return undefined;
  const artifactStart = separator.index + separator[0].length;
  const artifact = prose.slice(artifactStart);
  if (!artifact.trim()) return undefined;
  return Object.freeze({
    wrapper: prose.slice(0, separator.index),
    separator: separator[0],
    artifact,
  });
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, withoutUndefined(item)]),
  );
}

function capabilityEnforcementFacts(
  providerFacts: Readonly<JarvisVerifiedFacts>,
  capabilities: Readonly<Pick<JarvisRequestEnvelope['capabilities'], 'plugins' | 'mcps'>>,
): Readonly<JarvisVerifiedFacts> {
  return deepFreezeJarvisCopy({
    ...providerFacts,
    plugins: capabilities.plugins,
    mcps: capabilities.mcps,
  });
}

function operationalVerifiedFacts(
  facts: Readonly<JarvisVerifiedFacts>,
): Readonly<JarvisVerifiedFacts> {
  return deepFreezeJarvisCopy({
    ...facts,
    plugins: [],
    mcps: [],
  });
}

function convertTextParts(
  parts: readonly Part[],
  convert: (text: string) => { converted: boolean; parts: Part[] },
): Part[] {
  return parts.flatMap((part) => {
    if (part.kind !== 'text') return [part];
    const converted = convert(part.text);
    return converted.converted ? converted.parts : [part];
  });
}

function validatedParts(
  displayText: string,
  request: Readonly<Pick<JarvisRequestEnvelope, 'requestId' | 'userText' | 'outputContract'>>,
): Part[] {
  let parts = textParts(displayText);
  let actionIndex = 0;
  let planIndex = 0;
  let questionIndex = 0;
  let permissionIndex = 0;
  if (request.outputContract.allowQuestionBlocks) {
    parts = convertTextParts(parts, (text) => {
      const parsed = parseJarvisQuestionBlocks(text);
      const normalized = parsed.parts.map((part): Part => {
        if (part.kind !== 'question_block') return part;
        const index = questionIndex++;
        const generatedId = /^qb_\d+_\d+$/.test(part.block.id);
        const blockId = generatedId
          ? `jarvis_question_${request.requestId}_${index}`
          : part.block.id;
        return {
          ...part,
          block: {
            ...part.block,
            id: blockId,
            questions: part.block.questions.map((question, questionOffset) => ({
              ...question,
              id:
                question.id === `q_${questionOffset + 1}`
                  ? `${blockId}_q_${questionOffset + 1}`
                  : question.id,
            })),
          },
        };
      });
      return { converted: parsed.hasQuestionBlocks, parts: normalized };
    });
  }
  if (request.outputContract.allowPlanBlocks) {
    parts = convertTextParts(parts, (text) => {
      const parsed = parseJarvisPlanBlocks(text);
      const normalized = parsed.parts.map((part): Part => {
        if (part.kind !== 'plan_review') return part;
        const index = planIndex++;
        const id = /^plan_\d+_\d+$/.test(part.plan.id)
          ? `jarvis_plan_${request.requestId}_${index}`
          : part.plan.id;
        return { ...part, plan: { ...part.plan, id } };
      });
      return { converted: parsed.hasPlanBlocks, parts: normalized };
    });
  }
  if (request.outputContract.allowPermissionBlocks) {
    parts = convertTextParts(parts, (text) => {
      const parsed = parseJarvisPermissionBlocks(text);
      const normalized = parsed.parts.map((part): Part => {
        if (part.kind !== 'permission_request') return part;
        const index = permissionIndex++;
        const id = /^perm_\d+_\d+$/.test(part.request.id)
          ? `jarvis_permission_${request.requestId}_${index}`
          : part.request.id;
        return { ...part, request: { ...part.request, id } };
      });
      return { converted: parsed.hasPermissionBlocks, parts: normalized };
    });
  }
  if (request.outputContract.allowActionBlocks) {
    parts = convertTextParts(parts, (text) => {
      const parsed = parseActionBlocks(text);
      const converted: Part[] = parsed.segments.flatMap((segment): Part[] => {
        if (segment.kind === 'prose') {
          return segment.text.trim() ? [{ kind: 'text', text: segment.text }] : [];
        }
        if (!segment.ok) return [{ kind: 'text', text: INVALID_STRUCTURED_REGION_TEMPLATE }];
        return [
          {
            kind: 'action_proposal',
            call_id: `jarvis_action_${request.requestId}_${actionIndex++}`,
            action_id: segment.proposal.action_id,
            params: segment.proposal.params,
            ...(segment.proposal.rationale ? { rationale: segment.proposal.rationale } : {}),
            status: 'pending',
          },
        ];
      });
      return { converted: parsed.hasActionBlocks, parts: converted };
    });
    // The canonical kernel intentionally executes at most one approval-bound
    // action per response. Small local models sometimes emit a create action
    // followed by a read/verify action; passing both would reject the entire
    // otherwise valid response. Preserve the first executable step and require
    // subsequent effects to occur in a later, independently verified turn.
    let keptAction = false;
    parts = parts.filter((part) => {
      if (part.kind !== 'action_proposal') return true;
      if (keptAction) return false;
      keptAction = true;
      return true;
    });
    if (parts.every((part) => part.kind === 'text')) {
      const fallbackProposals = inferFallbackActionProposals(request.userText, displayText);
      if (fallbackProposals.length > 0) {
        const actionLabel = fallbackProposals
          .map(({ action_id, rationale }) => rationale?.trim() || action_id)
          .join(' ');
        return [
          {
            kind: 'text',
            text: formatJarvisVerifiedNarration({
              kind: 'approval_required',
              actionLabel,
            }).text,
          },
          ...fallbackProposals.map<Part>((proposal) => ({
            kind: 'action_proposal',
            call_id: proposal.call_id,
            action_id: proposal.action_id,
            params: proposal.params,
            rationale: proposal.rationale,
            status: 'pending',
          })),
        ];
      }
    }
  }
  const nonEmptyParts = parts.length > 0 ? parts : textParts(displayText);
  return nonEmptyParts.map((part) => withoutUndefined(part) as Part);
}

export async function processJarvisResponse(
  raw: Readonly<RawProviderResponse>,
  request: Readonly<JarvisRequestEnvelope>,
  repair: JarvisRepairPort,
): Promise<Readonly<JarvisResponseEnvelope>> {
  const snapshot = deepFreezeJarvisCopy({
    raw: {
      text: raw.text,
      provider: raw.provider,
      verifiedFacts: raw.verifiedFacts,
      completedAt: raw.completedAt,
    },
    request: {
      requestId: request.requestId,
      runId: request.runId,
      userText: request.userText,
      responseModeHint: request.responseModeHint,
      outputContract: request.outputContract,
      sourceRefs: request.context.items.map((item) => item.source),
      model: request.model,
      capabilities: {
        plugins: request.capabilities.plugins,
        mcps: request.capabilities.mcps,
      },
    },
  });
  const facts = capabilityEnforcementFacts(
    snapshot.raw.verifiedFacts,
    snapshot.request.capabilities,
  );
  const operationalFacts = operationalVerifiedFacts(facts);
  if (isCurrentModelStatusQuestion(snapshot.request.userText)) {
    const narration = formatJarvisVerifiedNarration({
      kind: 'current_model',
      providerId: snapshot.request.model.providerId,
      modelId: snapshot.request.model.modelId,
      connectionMode: snapshot.request.model.connectionMode,
      state: facts.modelState,
    });
    const displayText = narration.text;
    const spokenText = deriveJarvisSpokenText({
      proseWithPlaceholders: displayText,
      mode: narration.mode,
      verifiedFacts: facts,
    });
    const deterministicViolations = lintJarvisProse(displayText, narration.mode, facts);
    const envelope: JarvisResponseEnvelope = {
      schemaVersion: 1,
      requestId: snapshot.request.requestId,
      runId: snapshot.request.runId,
      mode: narration.mode,
      displayText,
      ...(snapshot.request.outputContract.voiceDelivery === 'none' || !spokenText
        ? {}
        : { spokenText }),
      parts: validatedParts(displayText, snapshot.request),
      artifactIds: [],
      sourceRefs: snapshot.request.sourceRefs,
      provider: snapshot.request.model,
      enforcement: {
        linted: true,
        violations: deterministicViolations.map((item) => item.code),
        repairAttempted: false,
        repairSucceeded: false,
        fallbackUsed: true,
      },
      completedAt: snapshot.raw.completedAt,
    };
    const validation = validateJarvisResponseEnvelope(envelope);
    if (!validation.ok) throw new JarvisResponsePipelineError(validation.errors);
    return deepFreezeJarvisCopy(envelope);
  }
  const tokenized = tokenizeJarvisResponse(snapshot.raw.text);
  const emptyProviderReply = snapshot.raw.text.trim().length === 0;
  const mode = classifyJarvisResponseMode(snapshot.request, facts);
  const sensitiveTopic =
    mode === 'sensitive'
      ? (classifyJarvisSensitiveTopic(snapshot.request.userText) ?? 'general')
      : undefined;
  let prose = tokenized.proseWithPlaceholders;
  const invalidRegionViolations: JarvisLintViolation[] = [];
  for (const region of tokenized.regions) {
    if (region.valid) continue;
    prose = prose.replace(
      jarvisRegionPlaceholder(region.index),
      INVALID_STRUCTURED_REGION_TEMPLATE,
    );
    invalidRegionViolations.push(
      safeViolation(
        `${region.errorCode ?? 'invalid_shape'}:${region.index}`,
        'deterministic',
        `Structured region ${region.index} is invalid.`,
      ),
    );
  }

  const sanitized = sanitizeProse(prose);
  prose = sanitized.prose;
  const initialViolations = [
    ...sanitized.violations,
    ...invalidRegionViolations,
    ...lintResponseProse(prose, mode, facts, sensitiveTopic),
  ];
  const hasQuarantine = initialViolations.some((item) => item.disposition === 'quarantine');
  const validPlaceholders = sensitiveTopic
    ? []
    : tokenized.regions
        .filter((region) => region.valid)
        .map((region) => jarvisRegionPlaceholder(region.index));
  const longFormParts = mode === 'long_form_delivery' ? splitLongFormWrapper(prose) : undefined;
  const mutableRepairProse = longFormParts?.wrapper ?? prose;
  const mutableRepairPlaceholders = validPlaceholders.filter((placeholder) =>
    mutableRepairProse.includes(placeholder),
  );
  const repairedScope =
    hasQuarantine || sensitiveTopic
      ? { prose, attempted: false, succeeded: false }
      : await repairJarvisProseOnce(
          {
            prose: mutableRepairProse,
            immutablePlaceholders: mutableRepairPlaceholders,
            mode,
            verifiedFacts: facts,
            violations: initialViolations,
          },
          repair,
        );
  const repaired =
    longFormParts && repairedScope.succeeded
      ? {
          ...repairedScope,
          prose: `${repairedScope.prose.trim()}${longFormParts.separator}${longFormParts.artifact}`,
        }
      : {
          ...repairedScope,
          prose: repairedScope.succeeded ? repairedScope.prose : prose,
        };

  let repairSucceeded = repaired.succeeded;
  let finalProse = repaired.prose;
  let repairedViolations: readonly JarvisLintViolation[] = [];
  if (repairSucceeded) {
    const repairedScopeViolations = lintResponseProse(
      longFormParts ? repairedScope.prose : finalProse,
      mode,
      facts,
      sensitiveTopic,
    );
    repairedViolations = longFormParts
      ? [
          ...initialViolations.filter((item) => item.disposition !== 'repairable'),
          ...repairedScopeViolations,
        ]
      : repairedScopeViolations;
    if (repairedViolations.length > 0) {
      repairSucceeded = false;
      finalProse = prose;
    }
  }

  const hasCapabilityContradiction = [...initialViolations, ...repairedViolations].some(
    (item) => item.code === 'verified_capability_contradiction',
  );
  const needsDeterministicFallback =
    initialViolations.some((item) => item.disposition === 'deterministic') ||
    (repaired.attempted && !repairSucceeded) ||
    Boolean(verifiedResponseTemplate(operationalFacts));
  if (sensitiveTopic) {
    finalProse = buildJarvisSensitiveFallback(sensitiveTopic);
  } else if (hasQuarantine) {
    finalProse = withMissingPlaceholders(QUARANTINED_RESPONSE_TEMPLATE, validPlaceholders);
  } else if (emptyProviderReply) {
    finalProse = EMPTY_PROVIDER_RESPONSE_TEMPLATE;
  } else if (needsDeterministicFallback) {
    const deterministic = deterministicFallback(
      finalProse,
      hasCapabilityContradiction ? facts : operationalFacts,
    );
    finalProse = withMissingPlaceholders(deterministic, validPlaceholders);
  }
  if (
    !sensitiveTopic &&
    invalidRegionViolations.length > 0 &&
    !finalProse.includes(INVALID_STRUCTURED_REGION_TEMPLATE)
  ) {
    finalProse = [finalProse, INVALID_STRUCTURED_REGION_TEMPLATE].filter(Boolean).join('\n\n');
  }

  const outputReferencePolicy = enforceJarvisOutputReferencePolicy(
    { proseWithPlaceholders: finalProse, regions: tokenized.regions },
    snapshot.request.sourceRefs,
  );
  finalProse = outputReferencePolicy.proseWithPlaceholders;
  const validRegions = sensitiveTopic ? [] : outputReferencePolicy.structuredRegions;
  const restoredDisplayText = restoreJarvisStructuredRegions(finalProse, validRegions);
  const preserveLongFormArtifactSuffix =
    Boolean(longFormParts) && !hasQuarantine && !needsDeterministicFallback;
  const displayText = preserveLongFormArtifactSuffix
    ? restoredDisplayText.trimStart()
    : restoredDisplayText.trim();
  const spokenText = deriveJarvisSpokenText({
    proseWithPlaceholders: finalProse,
    mode,
    structuredRegions: validRegions,
    verifiedFacts: facts,
  });
  const violations = Array.from(
    new Set([
      ...initialViolations.map((item) => item.code),
      ...outputReferencePolicy.violationCodes,
    ]),
  );
  const envelope: JarvisResponseEnvelope = {
    schemaVersion: 1,
    requestId: snapshot.request.requestId,
    runId: snapshot.request.runId,
    mode,
    displayText,
    ...(snapshot.request.outputContract.voiceDelivery === 'none' || !spokenText
      ? {}
      : { spokenText }),
    parts: validatedParts(displayText, snapshot.request),
    artifactIds: [],
    sourceRefs: snapshot.request.sourceRefs,
    ...(facts.executionState &&
    (!hasProviderOnlyTerminalState(facts) ||
      (facts.executionState.verifiedBy === 'provider' && facts.executionState.status === 'partial'))
      ? { executionState: facts.executionState }
      : {}),
    provider: snapshot.raw.provider,
    enforcement: {
      linted: true,
      violations,
      repairAttempted: repaired.attempted,
      repairSucceeded,
      fallbackUsed:
        Boolean(sensitiveTopic) ||
        hasQuarantine ||
        emptyProviderReply ||
        needsDeterministicFallback ||
        outputReferencePolicy.violationCodes.length > 0,
    },
    completedAt: snapshot.raw.completedAt,
  };
  const validation = validateJarvisResponseEnvelope(envelope);
  if (!validation.ok) throw new JarvisResponsePipelineError(validation.errors);
  return deepFreezeJarvisCopy(envelope);
}

export type { JarvisRepairPort, JarvisRepairRequest } from './repair';
export type { JarvisVerifiedFacts } from './modeClassifier';
