import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import type { ProviderId } from '@/types';
import { deepFreezeJarvisCopy } from './requestEnvelope';

type SingleModelSelection = Extract<ChatModelSelection, { mode: 'single' }>;

export type JarvisModelCostClass = 'free' | 'low' | 'standard' | 'premium' | 'unknown';

export type JarvisModelSwitchIntent =
  | Readonly<{ kind: 'provider'; providerId: ProviderId }>
  | Readonly<{ kind: 'local' }>
  | Readonly<{ kind: 'fastest_connected' }>
  | Readonly<{ kind: 'hive_balanced' }>
  | Readonly<{ kind: 'strongest_coding' }>
  | Readonly<{ kind: 'cheapest_capable' }>
  | Readonly<{ kind: 'switch_back' }>;

export interface JarvisModelSwitchCandidate {
  selection: SingleModelSelection;
  preferred?: boolean;
  connected: boolean;
  available: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  speedRank?: number;
  contextWindowTokens?: number;
  toolReliabilityRank?: number;
  codingRank: number;
  costClass: JarvisModelCostClass;
  maximumCostPerMillionUsd?: number;
  costMetadataSource?: 'exact_rate_table' | 'embedded_snapshot' | 'local';
}

export interface JarvisHiveBalancedAssessment {
  configured: boolean;
  connected: boolean;
  available: boolean;
  supportsImages: boolean;
  supportsTools: boolean;
  allLocal: boolean;
  costClass: JarvisModelCostClass;
}

export interface JarvisModelSwitchDecisionInput {
  intent: JarvisModelSwitchIntent;
  current: ChatModelSelection;
  previous?: ChatModelSelection;
  candidates: readonly JarvisModelSwitchCandidate[];
  hiveBalanced?: Readonly<JarvisHiveBalancedAssessment>;
  offlineMode: boolean;
  requirements: Readonly<{ images?: boolean; tools?: boolean }>;
  policyRequiresApproval: boolean;
}

type JarvisModelSwitchFailureReason =
  | 'target_not_configured'
  | 'no_previous_selection'
  | 'provider_not_connected'
  | 'model_unavailable'
  | 'required_capability_unavailable'
  | 'offline_mode';

export type JarvisModelSwitchApprovalReason =
  | 'local_to_cloud'
  | 'cost_increase'
  | 'cost_unknown'
  | 'policy';

export type JarvisModelSwitchDecision =
  | Readonly<{
      status: 'not_configured' | 'not_connected' | 'unavailable';
      reason: JarvisModelSwitchFailureReason;
    }>
  | Readonly<{ status: 'already_selected'; target: ChatModelSelection }>
  | Readonly<{
      status: 'approval_required';
      target: ChatModelSelection;
      reasons: readonly JarvisModelSwitchApprovalReason[];
    }>
  | Readonly<{ status: 'ready'; target: ChatModelSelection }>;

const COST_RANK: Readonly<Record<JarvisModelCostClass, number>> = Object.freeze({
  free: 0,
  low: 1,
  standard: 2,
  premium: 3,
  unknown: 4,
});

function frozenIntent(intent: JarvisModelSwitchIntent): Readonly<JarvisModelSwitchIntent> {
  return deepFreezeJarvisCopy(intent);
}

export function parseJarvisModelSwitchIntent(
  raw: string,
): Readonly<JarvisModelSwitchIntent> | null {
  const text = raw
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?]+\s*$/u, '')
    .trim();
  const providerMatch = text.match(
    /^(?:switch(?: me)? to|use)\s+(claude|gemini|grok)(?:\s+for\s+(?:this(?:\s+task)?|(?:the\s+)?next\s+answer))?$/i,
  );
  if (providerMatch) {
    const providerId: ProviderId =
      providerMatch[1]?.toLowerCase() === 'claude'
        ? 'anthropic'
        : providerMatch[1]?.toLowerCase() === 'grok'
          ? 'xai'
          : 'google';
    return frozenIntent({ kind: 'provider', providerId });
  }
  if (/^(?:switch(?: me)? to|use)\s+(?:(?:a|my)\s+)?local model$/i.test(text)) {
    return frozenIntent({ kind: 'local' });
  }
  if (/^(?:switch(?: me)? to|use)\s+the fastest connected model$/i.test(text)) {
    return frozenIntent({ kind: 'fastest_connected' });
  }
  if (/^(?:switch(?: me)? to|use)\s+hive balanced$/i.test(text)) {
    // Intent is still parseable for recovery/tests; execution fails closed when gated.
    return frozenIntent({ kind: 'hive_balanced' });
  }
  if (/^(?:switch(?: me)? to|use)\s+the strongest coding model$/i.test(text)) {
    return frozenIntent({ kind: 'strongest_coding' });
  }
  if (
    /^(?:switch(?: me)? to|use)\s+the cheapest model(?:\s+that\s+can\s+handle\s+this)?$/i.test(text)
  ) {
    return frozenIntent({ kind: 'cheapest_capable' });
  }
  if (/^(?:switch back|go back to the default model)$/i.test(text)) {
    return frozenIntent({ kind: 'switch_back' });
  }
  return null;
}

function isLocalProvider(providerId: ProviderId): boolean {
  return providerId === 'ollama' || providerId === 'local';
}

function copySelection(selection: SingleModelSelection): SingleModelSelection {
  const base = {
    mode: 'single' as const,
    providerId: selection.providerId,
    modelId: selection.modelId.trim(),
  };
  if (!selection.connectionId) return base;
  return {
    ...base,
    connectionId: selection.connectionId,
    connectionMode: selection.connectionMode,
    authSource: selection.authSource,
    capabilities: { ...selection.capabilities },
  };
}

function stableCandidateKey(candidate: JarvisModelSwitchCandidate): string {
  const selection = candidate.selection;
  return `${selection.providerId}\u0000${selection.modelId}\u0000${selection.connectionId ?? ''}`;
}

function safeCandidates(
  candidates: readonly JarvisModelSwitchCandidate[],
): JarvisModelSwitchCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate?.selection?.mode === 'single' &&
      candidate.selection.modelId.trim().length > 0 &&
      (candidate.speedRank === undefined || Number.isFinite(candidate.speedRank)) &&
      Number.isFinite(candidate.codingRank) &&
      Object.hasOwn(COST_RANK, candidate.costClass),
  );
}

function candidatesForIntent(
  input: JarvisModelSwitchDecisionInput,
  candidates: readonly JarvisModelSwitchCandidate[],
): readonly JarvisModelSwitchCandidate[] | null {
  switch (input.intent.kind) {
    case 'provider': {
      const providerId = input.intent.providerId;
      return candidates.filter((candidate) => candidate.selection.providerId === providerId);
    }
    case 'local':
      return candidates.filter((candidate) => isLocalProvider(candidate.selection.providerId));
    case 'fastest_connected':
    case 'strongest_coding':
    case 'cheapest_capable':
      return candidates;
    case 'hive_balanced':
      return [];
    case 'switch_back': {
      const previous = input.previous;
      if (previous?.mode !== 'single') return null;
      return candidates.filter((candidate) => sameSelection(candidate.selection, previous));
    }
  }
}

function supportsRequirements(
  candidate: JarvisModelSwitchCandidate,
  requirements: JarvisModelSwitchDecisionInput['requirements'],
): boolean {
  return (
    (!requirements.images || candidate.supportsImages) &&
    (!requirements.tools || candidate.supportsTools)
  );
}

function orderedCandidates(
  candidates: readonly JarvisModelSwitchCandidate[],
  intent: JarvisModelSwitchIntent,
): JarvisModelSwitchCandidate[] {
  return [...candidates].sort((left, right) => {
    if (intent.kind === 'provider' || intent.kind === 'local') {
      const preferenceDifference =
        Number(right.preferred === true) - Number(left.preferred === true);
      if (preferenceDifference !== 0) return preferenceDifference;
    }
    const costDifference = COST_RANK[left.costClass] - COST_RANK[right.costClass];
    const codingDifference = right.codingRank - left.codingRank;
    const speedDifference = (right.speedRank ?? 0) - (left.speedRank ?? 0);
    if (intent.kind === 'fastest_connected') {
      if (speedDifference !== 0) return speedDifference;
      if (costDifference !== 0) return costDifference;
      if (codingDifference !== 0) return codingDifference;
    } else if (intent.kind === 'cheapest_capable') {
      if (costDifference !== 0) return costDifference;
      if (codingDifference !== 0) return codingDifference;
    } else {
      if (codingDifference !== 0) return codingDifference;
      if (costDifference !== 0) return costDifference;
    }
    const leftKey = stableCandidateKey(left);
    const rightKey = stableCandidateKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function sameSelection(left: ChatModelSelection, right: ChatModelSelection): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === 'none' || right.mode === 'none') return true;
  if (left.mode === 'hive' && right.mode === 'hive') return left.hiveId === right.hiveId;
  return (
    left.mode === 'single' &&
    right.mode === 'single' &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.connectionId === right.connectionId
  );
}

function candidateForSelection(
  candidates: readonly JarvisModelSwitchCandidate[],
  selection: ChatModelSelection,
): JarvisModelSwitchCandidate | undefined {
  if (selection.mode !== 'single') return undefined;
  return candidates
    .filter(
      (candidate) =>
        candidate.selection.providerId === selection.providerId &&
        candidate.selection.modelId === selection.modelId &&
        (!selection.connectionId || candidate.selection.connectionId === selection.connectionId),
    )
    .sort((left, right) => Number(right.preferred === true) - Number(left.preferred === true))[0];
}

function approvalReasonsForTarget(
  input: JarvisModelSwitchDecisionInput,
  candidates: readonly JarvisModelSwitchCandidate[],
  target: Readonly<{ local: boolean; costClass: JarvisModelCostClass }>,
): JarvisModelSwitchApprovalReason[] {
  const reasons: JarvisModelSwitchApprovalReason[] = [];
  if (
    input.current.mode === 'single' &&
    isLocalProvider(input.current.providerId) &&
    !target.local
  ) {
    reasons.push('local_to_cloud');
  }

  const currentCandidate = candidateForSelection(candidates, input.current);
  if (target.costClass === 'unknown') {
    reasons.push('cost_unknown');
  } else if (
    currentCandidate &&
    currentCandidate.costClass !== 'unknown' &&
    COST_RANK[target.costClass] > COST_RANK[currentCandidate.costClass]
  ) {
    reasons.push('cost_increase');
  }
  if (input.policyRequiresApproval) reasons.push('policy');
  return reasons;
}

function frozenDecision(decision: JarvisModelSwitchDecision): JarvisModelSwitchDecision {
  return deepFreezeJarvisCopy(decision);
}

export function planJarvisModelSwitch(
  input: JarvisModelSwitchDecisionInput,
): Readonly<JarvisModelSwitchDecision> {
  if (input.intent.kind === 'hive_balanced') {
    if (!isHiveProductEnabled()) {
      return frozenDecision({ status: 'not_configured', reason: 'target_not_configured' });
    }
    const assessment = input.hiveBalanced;
    if (!assessment?.configured) {
      return frozenDecision({ status: 'not_configured', reason: 'target_not_configured' });
    }
    if (input.offlineMode && !assessment.allLocal) {
      return frozenDecision({ status: 'unavailable', reason: 'offline_mode' });
    }
    if (
      (input.requirements.images && !assessment.supportsImages) ||
      (input.requirements.tools && !assessment.supportsTools)
    ) {
      return frozenDecision({
        status: 'unavailable',
        reason: 'required_capability_unavailable',
      });
    }
    if (!assessment.connected) {
      return frozenDecision({ status: 'not_connected', reason: 'provider_not_connected' });
    }
    if (!assessment.available) {
      return frozenDecision({ status: 'unavailable', reason: 'model_unavailable' });
    }
    const target: ChatModelSelection = { mode: 'hive', hiveId: 'balanced' };
    if (sameSelection(input.current, target)) {
      return frozenDecision({ status: 'already_selected', target });
    }
    const reasons = approvalReasonsForTarget(input, safeCandidates(input.candidates), {
      local: assessment.allLocal,
      costClass: assessment.costClass,
    });
    return reasons.length > 0
      ? frozenDecision({ status: 'approval_required', target, reasons })
      : frozenDecision({ status: 'ready', target });
  }
  const candidates = safeCandidates(input.candidates);
  const configured = candidatesForIntent(input, candidates);
  if (configured === null) {
    return frozenDecision({ status: 'not_configured', reason: 'no_previous_selection' });
  }
  if (configured.length === 0) {
    return frozenDecision({ status: 'not_configured', reason: 'target_not_configured' });
  }
  const offlineEligible = input.offlineMode
    ? configured.filter((candidate) => isLocalProvider(candidate.selection.providerId))
    : configured;
  if (input.offlineMode && offlineEligible.length === 0) {
    return frozenDecision({ status: 'unavailable', reason: 'offline_mode' });
  }

  const capable = offlineEligible.filter((candidate) =>
    supportsRequirements(candidate, input.requirements),
  );
  if (capable.length === 0) {
    return frozenDecision({
      status: 'unavailable',
      reason: 'required_capability_unavailable',
    });
  }
  const connected = capable.filter((candidate) => candidate.connected);
  if (connected.length === 0) {
    return frozenDecision({ status: 'not_connected', reason: 'provider_not_connected' });
  }
  const available = connected.filter((candidate) => candidate.available);
  if (available.length === 0) {
    return frozenDecision({ status: 'unavailable', reason: 'model_unavailable' });
  }

  const targetCandidate = orderedCandidates(available, input.intent)[0]!;
  const target = copySelection(targetCandidate.selection);
  if (sameSelection(input.current, target)) {
    return frozenDecision({ status: 'already_selected', target });
  }
  const reasons = approvalReasonsForTarget(input, candidates, {
    local: isLocalProvider(targetCandidate.selection.providerId),
    costClass: targetCandidate.costClass,
  });
  return reasons.length > 0
    ? frozenDecision({ status: 'approval_required', target, reasons })
    : frozenDecision({ status: 'ready', target });
}
