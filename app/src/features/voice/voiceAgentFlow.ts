import type { ChatImageAttachment } from '@/lib/ai/vision';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import type { ReasoningPreference } from '@/lib/ai/reasoningControls';
import type { SendDetail } from '@/lib/ai/runtime';
import type { VoiceSessionBinding } from './voiceSessionBinding';
import type { VoiceAgentProvider } from './voiceProviderSelection';
import {
  buildVoiceNativeDelegationGuidance,
  dispatchVoiceMainRequest,
  type VoiceMainDispatchReceipt,
} from './voiceNativeDelegation';

export const VOICE_BRIEF_SYSTEM_INSTRUCTION =
  'Reply quickly and as briefly as possible. Use the fewest words that preserve the action, real status, result, and any important limitation. Acknowledge promptly; do not narrate routine steps.';

const DUPLICATE_WINDOW_MS = 45_000;
const MAX_SOURCE_CONTEXT_CHARS = 4_000;
const MAX_PRIOR_TASK_CONTEXT_CHARS = 1_500;
const MAX_LOCAL_COMMAND_CONTEXT_CHARS = 800;

export interface VoiceAgentRequest {
  chatId: string;
  text: string;
  mainProvider: VoiceAgentProvider;
  workerProvider: VoiceAgentProvider;
  selection: ChatModelSelection;
  reasoningPreference?: ReasoningPreference;
  requestId?: string;
  dedupeScope?: string;
  voiceSession?: Readonly<VoiceSessionBinding>;
  sourceContext?: string;
  priorTaskContext?: string;
  signal?: AbortSignal;
}

export interface VoiceAgentFlowStatus {
  phase:
    | 'acknowledged'
    | 'persist_failed'
    | 'capture_failed'
    | 'submitted'
    | 'main_accepted'
    | 'dispatch_failed'
    | 'cancelled';
  chatId: string;
  mainProvider: VoiceAgentProvider;
  workerProvider: VoiceAgentProvider;
  requestId: string;
  cancellationKey?: string;
  message?: string;
  elapsedMs: number;
}

export interface VoiceAgentFlowResult {
  status: 'main_accepted' | 'persist_failed' | 'dispatch_failed' | 'cancelled';
  duplicate: boolean;
  requestId: string;
  cancellationKey?: string;
  elapsedMs: number;
}

export interface VoiceAgentFlowDependencies {
  now(): number;
  acknowledge(text: string): void | Promise<void>;
  /** Persist the original user turn once; return its actual message ID. */
  persistUser(input: VoiceAgentRequest & { text: string; requestId: string }): Promise<string>;
  captureScreen(
    text: string,
    provider: VoiceAgentProvider,
  ): Promise<
    { ok: true; attachment: ChatImageAttachment } | { ok: false; code: string; message: string }
  >;
  dispatchMain(detail: SendDetail): Promise<VoiceMainDispatchReceipt>;
  createRequestId?(): string;
  reportStatus(status: VoiceAgentFlowStatus): void;
}

function normalizedVoiceTask(text: string): string {
  return text
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]+$/gu, '')
    .toLocaleLowerCase();
}

function boundedContext(value: string | undefined, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, limit);
}

function newVoiceRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return `vreq_${randomUUID.call(globalThis.crypto)}`;
  return `vreq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Build one original Main turn. The Main runtime decides whether to answer or use its native tool. */
export function buildVoiceMainRequestSendDetail(input: {
  chatId: string;
  userText: string;
  mainProvider: VoiceAgentProvider;
  workerProvider: VoiceAgentProvider;
  selection: ChatModelSelection;
  reasoningPreference?: ReasoningPreference;
  cancellationKey: string;
  requestId: string;
  voiceSession?: Readonly<VoiceSessionBinding>;
  captureNotice?: string;
  imageAttachments?: ChatImageAttachment[];
  sourceContext?: string;
  priorTaskContext?: string;
}): SendDetail {
  const text = input.userText.trim();
  const requestId = input.requestId.trim();
  const cancellationKey = input.cancellationKey.trim();
  if (!text) throw new Error('voice_main_request_text_required');
  if (!requestId) throw new Error('voice_main_request_id_required');
  if (
    !cancellationKey ||
    cancellationKey.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(cancellationKey)
  ) {
    throw new Error('voice_main_cancellation_key_invalid');
  }
  if (
    input.voiceSession &&
    (String(input.voiceSession.chatId) !== input.chatId ||
      !input.voiceSession.accountId ||
      !input.voiceSession.sessionId)
  ) {
    throw new Error('voice_main_session_binding_mismatch');
  }

  const guidance = buildVoiceNativeDelegationGuidance({
    selectedMainProvider: input.mainProvider,
    requestedWorkerProvider: input.workerProvider,
  });
  const sourceContext = boundedContext(input.sourceContext, MAX_SOURCE_CONTEXT_CHARS);
  const priorTaskContext = boundedContext(input.priorTaskContext, MAX_PRIOR_TASK_CONTEXT_CHARS);
  const imageAttachments = input.imageAttachments?.length ? input.imageAttachments : undefined;
  const captureNotice = boundedContext(input.captureNotice, 240);
  const localCommandContext = [
    ...(input.voiceSession ? [VOICE_BRIEF_SYSTEM_INSTRUCTION] : []),
    guidance,
    ...(imageAttachments
      ? [
          'The explicitly requested screenshot is attached to this Main turn only. Do not claim a native worker saw it without a tool receipt confirming image transfer.',
        ]
      : []),
    ...(captureNotice
      ? [
          `Screen capture limitation: ${captureNotice} Continue from the original text and mention this briefly.`,
        ]
      : []),
  ]
    .join('\n')
    .slice(0, MAX_LOCAL_COMMAND_CONTEXT_CHARS);

  return {
    chatId: input.chatId,
    cancellationKey: cancellationKey as SendDetail['cancellationKey'],
    ...(input.voiceSession
      ? { accountId: input.voiceSession.accountId, voiceSessionId: input.voiceSession.sessionId }
      : {}),
    text,
    ...(imageAttachments ? { imageAttachments } : {}),
    speakReply: Boolean(input.voiceSession),
    interactionMode: 'agent',
    modelSelectionOverride: input.selection,
    ...(input.reasoningPreference ? { reasoningPreference: input.reasoningPreference } : {}),
    autoApproveActions: false,
    localCommandContext,
    structuredContext: {
      kind: 'multitask',
      sourceMessageId: cancellationKey,
      payload: {
        voiceMainRequest: true,
        requestId,
        mainProvider: input.mainProvider,
        requestedWorkerProvider: input.workerProvider,
        crossProviderNativeSessionUnavailable: input.mainProvider !== input.workerProvider,
        workerRoutingInstruction: guidance,
        ...(captureNotice ? { captureNotice } : {}),
        ...(imageAttachments
          ? { screenshotAttachedToMain: true, workerImageReceiptRequired: true }
          : {}),
        ...(sourceContext ? { sourceContext } : {}),
        ...(priorTaskContext ? { priorTaskContext } : {}),
      },
    },
  };
}

/** Acknowledge, persist, capture if asked, then dispatch one Main turn. */
export function createVoiceAgentFlow(deps: VoiceAgentFlowDependencies) {
  const recent = new Map<string, { finishedAt?: number; result: Promise<VoiceAgentFlowResult> }>();

  const run = (input: VoiceAgentRequest): Promise<VoiceAgentFlowResult> => {
    const text = input.text.trim();
    const startedAt = deps.now();
    const requestId = input.requestId?.trim() || deps.createRequestId?.() || newVoiceRequestId();
    const dedupeScope = input.dedupeScope?.trim() || input.chatId;
    const key = JSON.stringify([
      dedupeScope,
      input.mainProvider,
      input.workerProvider,
      normalizedVoiceTask(text),
    ]);
    for (const [candidate, entry] of recent) {
      if (entry.finishedAt !== undefined && startedAt - entry.finishedAt >= DUPLICATE_WINDOW_MS) {
        recent.delete(candidate);
      }
    }
    const prior = recent.get(key);
    if (prior) return prior.result.then((result) => ({ ...result, duplicate: true }));

    const report = (
      phase: VoiceAgentFlowStatus['phase'],
      extras: Pick<VoiceAgentFlowStatus, 'cancellationKey' | 'message'> = {},
    ) => {
      try {
        deps.reportStatus({
          phase,
          chatId: input.chatId,
          mainProvider: input.mainProvider,
          workerProvider: input.workerProvider,
          requestId,
          elapsedMs: Math.max(0, deps.now() - startedAt),
          ...extras,
        });
      } catch {
        // Status subscribers cannot block persistence or the Main runtime send.
      }
    };
    const cancelled = (): VoiceAgentFlowResult => ({
      status: 'cancelled',
      duplicate: false,
      requestId,
      elapsedMs: Math.max(0, deps.now() - startedAt),
    });

    const operation = (async (): Promise<VoiceAgentFlowResult> => {
      if (!text || input.signal?.aborted) return cancelled();
      if (input.voiceSession) {
        try {
          void Promise.resolve(deps.acknowledge('On it.')).catch(() => undefined);
        } catch {
          // A local speech failure must not prevent the Main request.
        }
        report('acknowledged');
      }

      let cancellationKey: string;
      try {
        cancellationKey = (await deps.persistUser({ ...input, text, requestId })).trim();
        if (!cancellationKey) throw new Error('persisted_voice_message_identity_unavailable');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The voice request could not be saved.';
        report('persist_failed', { message });
        return {
          status: 'persist_failed',
          duplicate: false,
          requestId,
          elapsedMs: Math.max(0, deps.now() - startedAt),
        };
      }
      if (input.signal?.aborted) {
        report('cancelled', { cancellationKey });
        return cancelled();
      }

      let imageAttachments: ChatImageAttachment[] = [];
      let captureNotice: string | undefined;
      if (/\bon my screen\b/iu.test(text)) {
        try {
          const capture = await deps.captureScreen(text, input.workerProvider);
          if (capture.ok) imageAttachments = [capture.attachment];
          else captureNotice = capture.message;
        } catch {
          captureNotice = 'I could not capture the screen; continuing with text.';
        }
        if (captureNotice) report('capture_failed', { cancellationKey, message: captureNotice });
      }
      if (input.signal?.aborted) {
        report('cancelled', { cancellationKey });
        return cancelled();
      }

      const detail = buildVoiceMainRequestSendDetail({
        chatId: input.chatId,
        userText: text,
        mainProvider: input.mainProvider,
        workerProvider: input.workerProvider,
        selection: input.selection,
        ...(input.reasoningPreference ? { reasoningPreference: input.reasoningPreference } : {}),
        cancellationKey,
        requestId,
        ...(input.voiceSession ? { voiceSession: input.voiceSession } : {}),
        ...(captureNotice ? { captureNotice } : {}),
        ...(imageAttachments.length ? { imageAttachments } : {}),
        ...(input.sourceContext ? { sourceContext: input.sourceContext } : {}),
        ...(input.priorTaskContext ? { priorTaskContext: input.priorTaskContext } : {}),
      });

      report('submitted', { cancellationKey });
      let receipt: VoiceMainDispatchReceipt;
      try {
        receipt = await deps.dispatchMain(detail);
      } catch {
        receipt = {
          status: 'failed',
          code: 'dispatch_failed',
          message: 'The Main request could not be dispatched.',
        };
      }
      if (receipt.status !== 'accepted') {
        report('dispatch_failed', { cancellationKey, message: receipt.message });
        return {
          status: 'dispatch_failed',
          duplicate: false,
          requestId,
          cancellationKey,
          elapsedMs: Math.max(0, deps.now() - startedAt),
        };
      }

      report('main_accepted', { cancellationKey });
      return {
        status: 'main_accepted',
        duplicate: false,
        requestId,
        cancellationKey,
        elapsedMs: Math.max(0, deps.now() - startedAt),
      };
    })();
    const entry: { finishedAt?: number; result: Promise<VoiceAgentFlowResult> } = {
      result: operation,
    };
    recent.set(key, entry);
    void operation.then(
      () => {
        entry.finishedAt = deps.now();
      },
      () => {
        entry.finishedAt = deps.now();
      },
    );
    return operation;
  };

  return { run };
}

/** Resolves after a matching runtime `running` event, never merely after dispatchEvent. */
export const dispatchVoiceMainRequestByDefault = dispatchVoiceMainRequest;
