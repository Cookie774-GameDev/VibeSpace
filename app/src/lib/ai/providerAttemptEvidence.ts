import type { JarvisPreEffectTransportFailureEvidence } from '@/lib/jarvis/contracts';
import { validateJarvisPreEffectTransportFailureEvidence } from '@/lib/jarvis/contracts';

const providerAttemptTrackerBrand: unique symbol = Symbol('jarvis.provider-attempt-tracker');

type JarvisProviderAttemptTracker = Readonly<{
  [providerAttemptTrackerBrand]: true;
}>;

export type JarvisProviderAttemptFailureClassification =
  | {
      kind: 'pre_effect_transport_failure';
      evidence: JarvisPreEffectTransportFailureEvidence;
    }
  | {
      kind: 'response_started_transport_failure';
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
      responseStarted: true;
      chunkCount: number;
      actionDispatchCount: number;
      failureCategory: string;
      failedAt: number;
    }
  | {
      kind: 'action_dispatch_started_transport_failure';
      accountId: string;
      runId: string;
      requestId: string;
      attemptNumber: number;
      responseStarted: boolean;
      chunkCount: number;
      actionDispatchCount: number;
      failureCategory: string;
      failedAt: number;
    };

/** @internal Deep-module authority; omitted from every public barrel. */
export interface JarvisProviderAttemptEvidenceAuthority {
  begin(input: {
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    providerId: string;
    modelId: string;
  }): JarvisProviderAttemptTracker;
  noteResponseObservation(
    tracker: JarvisProviderAttemptTracker,
    input:
      | { kind: 'bytes'; byteLength: number; observedAt: number }
      | { kind: 'sdk_chunk'; observedAt: number },
  ): void;
  noteActionDispatch(tracker: JarvisProviderAttemptTracker, input: { observedAt: number }): void;
  verifyActiveEvidence(input: {
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    providerId: string;
    modelId: string;
  }): boolean;
  classifyFailure(
    tracker: JarvisProviderAttemptTracker,
    input: { failureCategory: string; failedAt: number },
  ): Promise<JarvisProviderAttemptFailureClassification>;
  revalidateFailure(input: {
    evidence: JarvisPreEffectTransportFailureEvidence;
    accountId: string;
    runId: string;
    requestId: string;
    attemptNumber: number;
    providerId: string;
    modelId: string;
  }): Promise<JarvisPreEffectTransportFailureEvidence | null>;
  complete(tracker: JarvisProviderAttemptTracker): void;
  invalidateAll(): void;
}

export class JarvisProviderAttemptFailureError extends Error {
  readonly code = 'jarvis_provider_attempt_failure' as const;
  readonly classification: JarvisProviderAttemptFailureClassification;
  readonly cause?: unknown;

  constructor(classification: JarvisProviderAttemptFailureClassification, cause?: unknown) {
    super('The provider attempt ended before canonical completion.');
    this.name = 'JarvisProviderAttemptFailureError';
    this.classification = classification;
    if (cause !== undefined) this.cause = cause;
  }
}

type AttemptBinding = {
  accountId: string;
  runId: string;
  requestId: string;
  attemptNumber: number;
  providerId: string;
  modelId: string;
};

type TrackerState = AttemptBinding & {
  tracker: JarvisProviderAttemptTracker;
  active: boolean;
  responseStarted: boolean;
  chunkCount: number;
  actionDispatchCount: number;
};

function requireIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid provider attempt ${field}.`);
  }
}

function validateBinding(binding: AttemptBinding): void {
  requireIdentifier(binding.accountId, 'accountId');
  requireIdentifier(binding.runId, 'runId');
  requireIdentifier(binding.requestId, 'requestId');
  requireIdentifier(binding.providerId, 'providerId');
  requireIdentifier(binding.modelId, 'modelId');
  if (!Number.isSafeInteger(binding.attemptNumber) || binding.attemptNumber < 1) {
    throw new Error('Invalid provider attempt attemptNumber.');
  }
}

function validateTimestamp(value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Invalid provider attempt timestamp.');
  }
}

function validateFailureCategory(value: string): void {
  if (!/^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('Invalid provider failure category.');
  }
}

function bindingKey(binding: AttemptBinding): string {
  return JSON.stringify([
    binding.accountId,
    binding.runId,
    binding.requestId,
    binding.attemptNumber,
    binding.providerId,
    binding.modelId,
  ]);
}

function canonicalEvidenceFields(
  binding: AttemptBinding,
  failureCategory: string,
  verifiedAt: number,
) {
  return {
    schemaVersion: 1 as const,
    accountId: binding.accountId,
    runId: binding.runId,
    requestId: binding.requestId,
    attemptNumber: binding.attemptNumber,
    providerId: binding.providerId,
    modelId: binding.modelId,
    boundary: 'before_first_response_byte' as const,
    responseStarted: false as const,
    chunkCount: 0 as const,
    actionDispatchCount: 0 as const,
    failureCategory,
    verifiedAt,
  };
}

function exactBinding(left: AttemptBinding, right: AttemptBinding): boolean {
  return (
    left.accountId === right.accountId &&
    left.runId === right.runId &&
    left.requestId === right.requestId &&
    left.attemptNumber === right.attemptNumber &&
    left.providerId === right.providerId &&
    left.modelId === right.modelId
  );
}

/** @internal Deep import for the trusted router/kernel composition only. */
export function createJarvisProviderAttemptEvidenceAuthority(input: {
  sha256(canonical: string): Promise<string>;
}): JarvisProviderAttemptEvidenceAuthority {
  const states = new WeakMap<object, TrackerState>();
  const active = new Map<string, Set<TrackerState>>();

  function stateFor(tracker: JarvisProviderAttemptTracker): TrackerState {
    const state = states.get(tracker as object);
    if (!state?.active) throw new Error('Provider attempt tracker is inactive.');
    return state;
  }

  function close(state: TrackerState): void {
    if (!state.active) return;
    state.active = false;
    const key = bindingKey(state);
    const group = active.get(key);
    group?.delete(state);
    if (group?.size === 0) active.delete(key);
  }

  return {
    begin(binding) {
      validateBinding(binding);
      const tracker = Object.freeze({ [providerAttemptTrackerBrand]: true as const });
      const state: TrackerState = {
        ...binding,
        tracker,
        active: true,
        responseStarted: false,
        chunkCount: 0,
        actionDispatchCount: 0,
      };
      states.set(tracker, state);
      const key = bindingKey(binding);
      const group = active.get(key) ?? new Set<TrackerState>();
      group.add(state);
      active.set(key, group);
      return tracker;
    },
    noteResponseObservation(tracker, observation) {
      const state = stateFor(tracker);
      validateTimestamp(observation.observedAt);
      if (
        observation.kind === 'bytes' &&
        (!Number.isSafeInteger(observation.byteLength) || observation.byteLength < 1)
      ) {
        throw new Error('Provider byte observation must be a positive integer.');
      }
      state.responseStarted = true;
      state.chunkCount += 1;
    },
    noteActionDispatch(tracker, observation) {
      const state = stateFor(tracker);
      validateTimestamp(observation.observedAt);
      state.actionDispatchCount += 1;
    },
    verifyActiveEvidence(binding) {
      try {
        validateBinding(binding);
      } catch {
        return false;
      }
      const group = active.get(bindingKey(binding));
      if (!group || group.size !== 1) return false;
      const [state] = group;
      return Boolean(state?.active && exactBinding(state, binding));
    },
    async classifyFailure(tracker, failure) {
      const state = stateFor(tracker);
      validateFailureCategory(failure.failureCategory);
      validateTimestamp(failure.failedAt);
      const snapshot = {
        accountId: state.accountId,
        runId: state.runId,
        requestId: state.requestId,
        attemptNumber: state.attemptNumber,
        responseStarted: state.responseStarted,
        chunkCount: state.chunkCount,
        actionDispatchCount: state.actionDispatchCount,
      };
      close(state);

      if (snapshot.actionDispatchCount > 0) {
        return Object.freeze({
          kind: 'action_dispatch_started_transport_failure' as const,
          ...snapshot,
          failureCategory: failure.failureCategory,
          failedAt: failure.failedAt,
        });
      }
      if (snapshot.responseStarted || snapshot.chunkCount > 0) {
        return Object.freeze({
          kind: 'response_started_transport_failure' as const,
          ...snapshot,
          responseStarted: true as const,
          failureCategory: failure.failureCategory,
          failedAt: failure.failedAt,
        });
      }

      const fields = canonicalEvidenceFields(state, failure.failureCategory, failure.failedAt);
      const digest = (await input.sha256(JSON.stringify(fields))).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error('Provider evidence digest is invalid.');
      }
      const evidence: JarvisPreEffectTransportFailureEvidence = Object.freeze({
        ...fields,
        evidenceRef: `sha256:${digest}`,
      });
      return Object.freeze({ kind: 'pre_effect_transport_failure' as const, evidence });
    },
    async revalidateFailure(expected) {
      const validation = validateJarvisPreEffectTransportFailureEvidence(expected.evidence);
      if (!validation.ok) return null;
      const binding: AttemptBinding = {
        accountId: expected.accountId,
        runId: expected.runId,
        requestId: expected.requestId,
        attemptNumber: expected.attemptNumber,
        providerId: expected.providerId,
        modelId: expected.modelId,
      };
      try {
        validateBinding(binding);
        validateFailureCategory(expected.evidence.failureCategory);
        validateTimestamp(expected.evidence.verifiedAt);
      } catch {
        return null;
      }
      if (!exactBinding(expected.evidence, binding)) return null;
      const fields = canonicalEvidenceFields(
        binding,
        expected.evidence.failureCategory,
        expected.evidence.verifiedAt,
      );
      const digest = (await input.sha256(JSON.stringify(fields))).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) return null;
      if (expected.evidence.evidenceRef !== `sha256:${digest}`) return null;
      return Object.freeze({ ...expected.evidence });
    },
    complete(tracker) {
      close(stateFor(tracker));
    },
    invalidateAll() {
      for (const group of active.values()) {
        for (const state of group) state.active = false;
      }
      active.clear();
    },
  };
}
