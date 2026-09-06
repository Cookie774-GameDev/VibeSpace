import type { LLMMessage } from '@/lib/ai';
import type { LLMContentPart } from '@/lib/ai/types';
import type {
  JarvisCapabilityRef,
  JarvisCapabilitySnapshot,
  JarvisContextConflict,
  JarvisContextPack,
  JarvisEntitlementSnapshot,
  JarvisModelSnapshot,
  JarvisOutputContract,
  JarvisRequestEnvelope,
  JarvisResponseMode,
  JarvisSourceRef,
} from '@/lib/jarvis/contracts';
import { validateJarvisRequestEnvelope } from '@/lib/jarvis/contracts';
import type { JarvisIdentitySnapshot } from '@/lib/jarvis/identity';
import type { JarvisProfileSnapshot } from '@/lib/jarvis/profiles/types';

export type JarvisRequestAttempt =
  | {
      kind: 'initial';
      requestId: string;
      runId: string;
      attemptNumber: 1;
    }
  | {
      kind: 'transport_retry';
      requestId: string;
      runId: string;
      attemptNumber: number;
      previousRequestId: string;
      previousRunId: string;
      previousAttemptNumber: number;
    }
  | {
      kind: 'logical_retry';
      requestId: string;
      runId: string;
      attemptNumber: 1;
      previousRequestId: string;
      previousRunId: string;
      previousAttemptNumber: number;
    };

export interface JarvisRequestInput {
  attempt: JarvisRequestAttempt;
  accountId: string;
  workspaceId?: string;
  projectId?: string;
  chatId?: string;
  parentRunId?: string;
  agent: JarvisRequestEnvelope['agent'];
  surface: JarvisRequestEnvelope['surface'];
  interactionMode: JarvisRequestEnvelope['interactionMode'];
  responseModeHint?: JarvisResponseMode;
  identity: JarvisIdentitySnapshot;
  profile: JarvisProfileSnapshot;
  model: JarvisModelSnapshot;
  capabilities: JarvisCapabilitySnapshot;
  context: JarvisContextPack;
  outputContract: JarvisOutputContract;
  userText: string;
  messageHistory: readonly LLMMessage[];
  createdAt: number;
}

export class JarvisRequestAttemptError extends Error {
  readonly code = 'invalid_request_attempt' as const;

  constructor(readonly reason: string) {
    super(`Invalid JARVIS request attempt: ${reason}`);
    this.name = 'JarvisRequestAttemptError';
  }
}

export class JarvisRequestEnvelopeValidationError extends Error {
  readonly code = 'invalid_request_envelope' as const;

  constructor(readonly validationErrors: readonly unknown[]) {
    super('Invalid JARVIS request envelope.');
    this.name = 'JarvisRequestEnvelopeValidationError';
  }
}

/**
 * The kernel's one detached, cycle-safe recursive freezer. It only copies
 * enumerable data because every accepted kernel contract must also be JSON-safe.
 */
export function deepFreezeJarvisCopy<T>(value: T): Readonly<T> {
  const copies = new WeakMap<object, object>();

  function copy(current: unknown): unknown {
    if (current === null || typeof current !== 'object') return current;

    const existing = copies.get(current);
    if (existing) return existing;

    if (Array.isArray(current)) {
      const arrayCopy: unknown[] = [];
      copies.set(current, arrayCopy);
      for (const item of current) arrayCopy.push(copy(item));
      return Object.freeze(arrayCopy);
    }

    const objectCopy: Record<string, unknown> = {};
    copies.set(current, objectCopy);
    for (const [key, item] of Object.entries(current)) {
      Object.defineProperty(objectCopy, key, {
        value: copy(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(objectCopy);
  }

  return copy(value) as Readonly<T>;
}

function requireNonEmptyId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JarvisRequestAttemptError(`${field}_required`);
  }
}

function requirePositiveAttemptNumber(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new JarvisRequestAttemptError(`${field}_invalid`);
  }
}

export function validateJarvisRequestAttempt(
  attempt: JarvisRequestAttempt,
): Readonly<{ requestId: string; runId: string; attemptNumber: number }> {
  if (!attempt || typeof attempt !== 'object') {
    throw new JarvisRequestAttemptError('attempt_required');
  }

  requireNonEmptyId(attempt.requestId, 'request_id');
  requireNonEmptyId(attempt.runId, 'run_id');
  requirePositiveAttemptNumber(attempt.attemptNumber, 'attempt_number');

  if (attempt.kind === 'initial') {
    if (attempt.attemptNumber !== 1) {
      throw new JarvisRequestAttemptError('initial_attempt_number_must_be_one');
    }
  } else if (attempt.kind === 'transport_retry' || attempt.kind === 'logical_retry') {
    requireNonEmptyId(attempt.previousRequestId, 'previous_request_id');
    requireNonEmptyId(attempt.previousRunId, 'previous_run_id');
    requirePositiveAttemptNumber(attempt.previousAttemptNumber, 'previous_attempt_number');

    if (attempt.requestId === attempt.previousRequestId) {
      throw new JarvisRequestAttemptError('request_id_must_be_fresh');
    }

    if (attempt.kind === 'transport_retry') {
      if (attempt.runId !== attempt.previousRunId) {
        throw new JarvisRequestAttemptError('transport_retry_run_id_changed');
      }
      if (attempt.attemptNumber !== attempt.previousAttemptNumber + 1) {
        throw new JarvisRequestAttemptError('transport_retry_attempt_not_sequential');
      }
    } else {
      if (attempt.runId === attempt.previousRunId) {
        throw new JarvisRequestAttemptError('logical_retry_run_id_reused');
      }
      if (attempt.attemptNumber !== 1) {
        throw new JarvisRequestAttemptError('logical_retry_attempt_number_must_be_one');
      }
    }
  } else {
    throw new JarvisRequestAttemptError('unknown_attempt_kind');
  }

  return Object.freeze({
    requestId: attempt.requestId,
    runId: attempt.runId,
    attemptNumber: attempt.attemptNumber,
  });
}

function copySource(source: JarvisSourceRef): JarvisSourceRef {
  return {
    id: source.id,
    kind: source.kind,
    label: source.label,
    ...(source.uri === undefined ? {} : { uri: source.uri }),
    accountId: source.accountId,
    ...(source.projectId === undefined ? {} : { projectId: source.projectId }),
    trust: source.trust,
    ...(source.origin === undefined ? {} : { origin: source.origin }),
    sensitivity: source.sensitivity,
    ...(source.observedAt === undefined ? {} : { observedAt: source.observedAt }),
    ...(source.contentHash === undefined ? {} : { contentHash: source.contentHash }),
  };
}

function copyContextConflict(conflict: JarvisContextConflict): JarvisContextConflict {
  return conflict.status === 'resolved'
    ? {
        groupId: conflict.groupId,
        status: conflict.status,
        sourceIds: [...conflict.sourceIds],
        winnerSourceId: conflict.winnerSourceId,
        basis: conflict.basis,
      }
    : {
        groupId: conflict.groupId,
        status: conflict.status,
        sourceIds: [...conflict.sourceIds],
      };
}

function copyContext(context: JarvisContextPack): JarvisContextPack {
  return {
    items: context.items.map((item) => ({
      source: copySource(item.source),
      purpose: item.purpose,
      excerpt: item.excerpt,
      ...(item.score === undefined ? {} : { score: item.score }),
      ...(item.freshness === undefined ? {} : { freshness: item.freshness }),
      ...(item.conflict === undefined ? {} : { conflict: copyContextConflict(item.conflict) }),
      truncated: item.truncated,
    })),
    budget: {
      maxChars: context.budget.maxChars,
      usedChars: context.budget.usedChars,
    },
    exclusions: context.exclusions.map((entry) => ({
      source: copySource(entry.source),
      reason: entry.reason,
    })),
  };
}

function copyCapabilityRef(ref: JarvisCapabilityRef): JarvisCapabilityRef {
  return {
    id: ref.id,
    state: ref.state,
    operations: [...ref.operations],
    ...(ref.evidenceRef === undefined ? {} : { evidenceRef: ref.evidenceRef }),
    ...(ref.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: ref.lastVerifiedAt }),
  };
}

function copyEntitlements(entitlements: JarvisEntitlementSnapshot): JarvisEntitlementSnapshot {
  return {
    source: entitlements.source,
    ...(entitlements.planId === undefined ? {} : { planId: entitlements.planId }),
    capabilities: [...entitlements.capabilities],
    ...(entitlements.verifiedAt === undefined ? {} : { verifiedAt: entitlements.verifiedAt }),
    ...(entitlements.expiresAt === undefined ? {} : { expiresAt: entitlements.expiresAt }),
  };
}

function copyCapabilities(capabilities: JarvisCapabilitySnapshot): JarvisCapabilitySnapshot {
  return {
    capturedAt: capabilities.capturedAt,
    tools: capabilities.tools.map(copyCapabilityRef),
    plugins: capabilities.plugins.map(copyCapabilityRef),
    mcps: capabilities.mcps.map(copyCapabilityRef),
    terminals: capabilities.terminals.map(copyCapabilityRef),
    agents: capabilities.agents.map(copyCapabilityRef),
    entitlements: copyEntitlements(capabilities.entitlements),
    ...(capabilities.actionSchemas === undefined
      ? {}
      : {
          actionSchemas: capabilities.actionSchemas.map((schema) =>
            deepFreezeJarvisCopy(schema),
          ),
        }),
  };
}

function copyModel(model: JarvisModelSnapshot): JarvisModelSnapshot {
  return {
    ...(model.connectionId === undefined ? {} : { connectionId: model.connectionId }),
    providerId: model.providerId,
    modelId: model.modelId,
    connectionMode: model.connectionMode,
    capabilities: deepFreezeJarvisCopy(model.capabilities) as Record<string, boolean>,
    ...(model.effectiveTemperature === undefined
      ? {}
      : { effectiveTemperature: model.effectiveTemperature }),
    capturedAt: model.capturedAt,
  };
}

function copyMessage(message: LLMMessage): LLMMessage {
  return {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content.map(
            (part): LLMContentPart =>
              part.type === 'text'
                ? { type: 'text', text: part.text }
                : {
                    type: 'image',
                    data: part.data,
                    mimeType: part.mimeType,
                    ...(part.name === undefined ? {} : { name: part.name }),
                  },
          ),
  };
}

export async function createJarvisRequestEnvelope(
  input: JarvisRequestInput,
): Promise<Readonly<JarvisRequestEnvelope>> {
  const attempt = validateJarvisRequestAttempt(input.attempt);
  const envelope: JarvisRequestEnvelope = {
    schemaVersion: 1,
    requestId: attempt.requestId,
    runId: attempt.runId,
    accountId: input.accountId,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.chatId === undefined ? {} : { chatId: input.chatId }),
    ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
    agent: {
      id: input.agent.id,
      slug: input.agent.slug,
      builtin: input.agent.builtin,
    },
    surface: input.surface,
    interactionMode: input.interactionMode,
    ...(input.responseModeHint === undefined ? {} : { responseModeHint: input.responseModeHint }),
    userText: input.userText,
    messageHistory: input.messageHistory.map(copyMessage),
    identity: {
      identityVersion: input.identity.identityVersion,
      coreHash: input.identity.coreHash,
      responseContractHash: input.identity.responseContractHash,
    },
    profile: {
      profileId: input.profile.profileId,
      revisionId: input.profile.revisionId,
      ...(input.profile.soulRevisionId === undefined
        ? {}
        : { soulRevisionId: input.profile.soulRevisionId }),
      customInstructions: input.profile.customInstructions,
      memoryScope: input.profile.memoryScope,
    },
    capabilities: copyCapabilities(input.capabilities),
    model: copyModel(input.model),
    context: copyContext(input.context),
    outputContract: {
      preserveStructuredBlocks: input.outputContract.preserveStructuredBlocks,
      allowActionBlocks: input.outputContract.allowActionBlocks,
      allowPlanBlocks: input.outputContract.allowPlanBlocks,
      allowQuestionBlocks: input.outputContract.allowQuestionBlocks,
      allowPermissionBlocks: input.outputContract.allowPermissionBlocks,
      voiceDelivery: input.outputContract.voiceDelivery,
      ...(input.outputContract.reasoningMode === undefined ? {} : { reasoningMode: input.outputContract.reasoningMode }),
    },
    createdAt: input.createdAt,
  };

  const validation = validateJarvisRequestEnvelope(envelope);
  if (!validation.ok) {
    throw new JarvisRequestEnvelopeValidationError(validation.errors);
  }

  return deepFreezeJarvisCopy(envelope);
}
