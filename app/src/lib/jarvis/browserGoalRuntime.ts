import type { JarvisIssuedActionExecution } from './approvalEngine';
import type {
  GoalCheckpointRepository,
  GoalCheckpointStorageAppendResult,
  GoalCheckpointStoredRecordV1,
} from './goalCheckpointRepository';
import type { GoalCheckpointState } from './goalCheckpoint';
import type {
  NativeCapabilityBroker,
  NativeCapabilityOutcome,
  NativeCapabilityRequest,
} from './nativeCapabilityBroker';
import type {
  NormalizedProviderGoalEvent,
  ProviderGoalAdapter,
  ProviderGoalPayload,
} from './providerGoalAdapter';
import {
  verifyTruthfulCompletion,
  type CanonicalCriterionEvidenceV1,
  type TruthfulCompletionResult,
} from './truthfulCompletion';
import { evaluateUntrustedContent, type UntrustedContentReceipt } from './untrustedContentPolicy';
import type { BrowserGoalPlaywrightAdapter } from './browserGoalPlaywrightAdapter';
import type { PlaywrightBrowserReceipt } from './playwrightBrowserWorker';

export type BrowserGoalProviderEventResult = Readonly<{
  event: NormalizedProviderGoalEvent;
  contentReceipt?: UntrustedContentReceipt;
}>;

export type BrowserGoalCapabilityResult = Readonly<{
  outcome: NativeCapabilityOutcome;
  checkpoint: GoalCheckpointStorageAppendResult;
  contentReceipt?: UntrustedContentReceipt;
  browserReceipt?: PlaywrightBrowserReceipt;
}>;

export interface BrowserGoalRuntime {
  acceptProviderEvent(
    payload: ProviderGoalPayload,
    observedAt: number,
  ): Promise<BrowserGoalProviderEventResult>;
  executeCapability(input: {
    record: GoalCheckpointStoredRecordV1;
    request: NativeCapabilityRequest;
    execution: JarvisIssuedActionExecution;
    returnedContent?: string;
    state?: GoalCheckpointState;
    completedCriteriaIds: readonly string[];
    idempotencyKey: string;
    finalMutationAt: number;
    createdAt: number;
    cursorIssuedAt: number;
    cursorExpiresAt: number;
  }): Promise<BrowserGoalCapabilityResult>;
  verifyCompletion(input: {
    record: GoalCheckpointStoredRecordV1;
    evidence: readonly CanonicalCriterionEvidenceV1[];
  }): TruthfulCompletionResult;
}

function providerContent(payload: ProviderGoalPayload): string | undefined {
  if (payload.kind === 'text_delta') return payload.text;
  if (payload.kind === 'reasoning_summary') return payload.summary;
  return undefined;
}

function assertBrowserScope(
  record: GoalCheckpointStoredRecordV1,
  request: NativeCapabilityRequest,
): void {
  if (
    request.kind !== 'browser' ||
    request.accountId !== record.accountId ||
    request.runId !== record.manifest.runId ||
    request.workspaceRoot !== record.manifest.repoRoot ||
    record.projectId !== record.manifest.projectId ||
    record.manifestId !== record.manifest.id ||
    record.revision !== record.checkpoint.sequence
  ) {
    throw new Error('Browser capability does not match the durable goal scope.');
  }
}

export function createBrowserGoalRuntime(input: {
  repository: GoalCheckpointRepository;
  broker: NativeCapabilityBroker;
  provider: ProviderGoalAdapter;
  playwright?: BrowserGoalPlaywrightAdapter;
}): BrowserGoalRuntime {
  return Object.freeze<BrowserGoalRuntime>({
    async acceptProviderEvent(payload, observedAt) {
      const event = input.provider.push(payload, observedAt);
      const content = providerContent(event.payload);
      const contentReceipt =
        content === undefined
          ? undefined
          : await evaluateUntrustedContent({ source: 'model', content });
      return Object.freeze({
        event,
        ...(contentReceipt === undefined ? {} : { contentReceipt }),
      });
    },

    async executeCapability(capabilityInput) {
      assertBrowserScope(capabilityInput.record, capabilityInput.request);
      const outcome = await input.broker.execute(
        capabilityInput.request,
        capabilityInput.execution,
      );
      if (outcome.kind !== 'browser') {
        throw new Error('Native broker returned a non-browser capability outcome.');
      }
      const isPlaywrightOutcome =
        Boolean(input.playwright) &&
        outcome.capabilityId === input.playwright!.nativeAdapter.id;
      const browserReceipt =
        isPlaywrightOutcome
          ? input.playwright!.receipt(outcome.resultRef)
          : undefined;
      if (
        isPlaywrightOutcome &&
        !browserReceipt
      ) {
        throw new Error('Playwright browser outcome is missing its canonical worker receipt.');
      }
      const returnedContent = isPlaywrightOutcome
        ? browserReceipt?.observation?.text
        : capabilityInput.returnedContent;
      const contentReceipt =
        returnedContent === undefined
          ? undefined
          : await evaluateUntrustedContent({
              source: 'browser_dom',
              content: returnedContent,
            });
      const checkpoint = await input.repository.append({
        manifest: capabilityInput.record.manifest,
        previous: capabilityInput.record,
        expectedRevision: capabilityInput.record.revision,
        idempotencyKey: capabilityInput.idempotencyKey,
        state: capabilityInput.state ?? 'running',
        completedCriteriaIds: capabilityInput.completedCriteriaIds,
        evidenceRefs: Object.freeze([outcome.resultRef, outcome.evidenceRef]),
        finalMutationAt: capabilityInput.finalMutationAt,
        createdAt: capabilityInput.createdAt,
        cursorIssuedAt: capabilityInput.cursorIssuedAt,
        cursorExpiresAt: capabilityInput.cursorExpiresAt,
      });
      return Object.freeze({
        outcome,
        checkpoint,
        ...(contentReceipt === undefined ? {} : { contentReceipt }),
        ...(browserReceipt === undefined ? {} : { browserReceipt }),
      });
    },

    verifyCompletion({ record, evidence }) {
      return verifyTruthfulCompletion({
        manifest: record.manifest,
        checkpoint: record.checkpoint,
        evidence,
      });
    },
  });
}
