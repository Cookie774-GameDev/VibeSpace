import type { ChatImageAttachment } from '@/lib/ai/vision';
import type { ChatModelSelection } from '@/lib/ai/modelSelection';
import type { SendDetail } from '@/lib/ai/runtime';
import type { VoiceSessionBinding } from './voiceSessionBinding';
import type { VoiceAgentProvider } from './voiceProviderSelection';

export const VOICE_BRIEF_SYSTEM_INSTRUCTION =
  'Reply quickly and as briefly as possible. Use the fewest words that preserve the action, real status, result, and any important limitation. Acknowledge promptly; do not narrate routine steps.';

const DUPLICATE_WINDOW_MS = 45_000;

export interface VoiceAgentRequest {
  chatId: string;
  text: string;
  mainProvider: VoiceAgentProvider;
  workerProvider: VoiceAgentProvider;
  signal?: AbortSignal;
}

export interface VoiceAgentFlowStatus {
  phase:
    | 'acknowledged'
    | 'submitted'
    | 'capture_failed'
    | 'launched'
    | 'worker_terminal'
    | 'main_dispatched'
    | 'launch_failed'
    | 'delivery_failed'
    | 'cancelled';
  chatId: string;
  provider?: VoiceAgentProvider;
  message?: string;
  elapsedMs: number;
}

export interface VoiceWorkerOutcome {
  status: 'done' | 'blocked' | 'failed' | 'cancelled';
  text: string;
}

export interface VoiceAgentFlowResult {
  status: 'main_dispatched' | 'launch_failed' | 'delivery_failed' | 'cancelled';
  duplicate: boolean;
  actualWorkerProvider?: VoiceAgentProvider;
  childChatId?: string;
  elapsedMs: number;
}

export interface VoiceAgentFlowDependencies {
  now(): number;
  acknowledge(text: string): void | Promise<void>;
  persistUser(input: VoiceAgentRequest): Promise<void>;
  captureScreen(
    text: string,
    provider: VoiceAgentProvider,
  ): Promise<
    { ok: true; attachment: ChatImageAttachment } | { ok: false; code: string; message: string }
  >;
  launchWorker(input: {
    parentChatId: string;
    task: string;
    requestedProvider: VoiceAgentProvider;
    imageAttachments: ChatImageAttachment[];
  }): Promise<{ agentId: string; childChatId: string; actualProvider: VoiceAgentProvider }>;
  waitForWorker(input: {
    parentChatId: string;
    agentId: string;
    childChatId: string;
    signal?: AbortSignal;
  }): Promise<VoiceWorkerOutcome>;
  deliverMainResult(input: VoiceMainDelivery): Promise<void>;
  reportStatus(status: VoiceAgentFlowStatus): void;
}

export interface VoiceMainDelivery {
  chatId: string;
  userText: string;
  mainProvider: VoiceAgentProvider;
  workerProvider: VoiceAgentProvider;
  childChatId: string;
  workerStatus: VoiceWorkerOutcome['status'];
  workerText: string;
  captureNotice?: string;
  instruction: typeof VOICE_BRIEF_SYSTEM_INSTRUCTION;
}

/** Build the exact runtime send; only voice sends receive the brief system instruction. */
export function buildVoiceMainResultSendDetail(input: {
  delivery: VoiceMainDelivery;
  selection: ChatModelSelection;
  voiceSession?: Readonly<VoiceSessionBinding>;
}): SendDetail {
  const { delivery, selection, voiceSession } = input;
  return {
    chatId: delivery.chatId,
    ...(voiceSession
      ? { accountId: voiceSession.accountId, voiceSessionId: voiceSession.sessionId }
      : {}),
    text: delivery.userText,
    speakReply: Boolean(voiceSession),
    interactionMode: 'ask',
    modelSelectionOverride: selection,
    autoApproveActions: false,
    localCommandContext: [
      ...(voiceSession ? [delivery.instruction] : []),
      'The worker already ran. Report its result; do not launch another worker or repeat the task.',
      `Actual worker provider: ${delivery.workerProvider}. Worker status: ${delivery.workerStatus}.`,
      delivery.captureNotice ?? '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 800),
    structuredContext: {
      kind: 'multitask',
      payload: {
        voiceWorkerResult: Boolean(voiceSession),
        childChatId: delivery.childChatId,
        workerProvider: delivery.workerProvider,
        workerStatus: delivery.workerStatus,
        workerText: delivery.workerText.slice(0, 20_000),
        captureNotice: delivery.captureNotice,
      },
    },
  };
}

function normalizedVoiceTask(text: string): string {
  return text
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.!?]+$/gu, '')
    .toLocaleLowerCase();
}

function workerTask(text: string, hasScreen: boolean): string {
  return [
    `User's voice request: ${text.trim()}`,
    'Use the current VibeSpace project and parent-chat context. Complete this one task. Report the real result and any blocker briefly with useful evidence.',
    hasScreen
      ? 'One user-permitted screenshot is attached to this worker message. Inspect it only for this request.'
      : 'No screen image is attached; proceed from the text and available project context.',
  ].join('\n\n');
}

export function createVoiceAgentFlow(deps: VoiceAgentFlowDependencies) {
  const recent = new Map<string, { finishedAt?: number; result: Promise<VoiceAgentFlowResult> }>();

  const run = (input: VoiceAgentRequest): Promise<VoiceAgentFlowResult> => {
    const text = input.text.trim();
    const startedAt = deps.now();
    const key = `${input.chatId}\u0000${input.mainProvider}\u0000${input.workerProvider}\u0000${normalizedVoiceTask(text)}`;
    for (const [candidate, entry] of recent) {
      if (entry.finishedAt !== undefined && startedAt - entry.finishedAt >= DUPLICATE_WINDOW_MS) {
        recent.delete(candidate);
      }
    }
    const prior = recent.get(key);
    if (prior) {
      return prior.result.then((result) => ({ ...result, duplicate: true }));
    }

    const report = (
      phase: VoiceAgentFlowStatus['phase'],
      extras: Pick<VoiceAgentFlowStatus, 'provider' | 'message'> = {},
    ) =>
      deps.reportStatus({
        phase,
        chatId: input.chatId,
        elapsedMs: Math.max(0, deps.now() - startedAt),
        ...extras,
      });
    const cancelled = (): VoiceAgentFlowResult => ({
      status: 'cancelled',
      duplicate: false,
      elapsedMs: Math.max(0, deps.now() - startedAt),
    });

    const operation = (async (): Promise<VoiceAgentFlowResult> => {
      if (!text || input.signal?.aborted) return cancelled();
      try {
        void Promise.resolve(deps.acknowledge('On it.')).catch(() => undefined);
      } catch {
        // A failed local voice engine must not prevent the task from starting.
      }
      report('acknowledged');

      try {
        await deps.persistUser({ ...input, text });
      } catch (error) {
        report('launch_failed', { message: 'The voice request could not be saved.' });
        return { status: 'launch_failed', duplicate: false, elapsedMs: deps.now() - startedAt };
      }
      if (input.signal?.aborted) {
        report('cancelled');
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
        if (captureNotice) report('capture_failed', { message: captureNotice });
      }
      if (input.signal?.aborted) {
        report('cancelled');
        return cancelled();
      }

      let launched: Awaited<ReturnType<VoiceAgentFlowDependencies['launchWorker']>>;
      try {
        launched = await deps.launchWorker({
          parentChatId: input.chatId,
          task: workerTask(text, imageAttachments.length > 0),
          requestedProvider: input.workerProvider,
          imageAttachments,
        });
      } catch (error) {
        report('launch_failed', {
          message: error instanceof Error ? error.message : 'The worker could not start.',
        });
        return { status: 'launch_failed', duplicate: false, elapsedMs: deps.now() - startedAt };
      }
      report('launched', { provider: launched.actualProvider });

      let worker: VoiceWorkerOutcome;
      try {
        worker = await deps.waitForWorker({
          parentChatId: input.chatId,
          agentId: launched.agentId,
          childChatId: launched.childChatId,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        worker = {
          status: input.signal?.aborted ? 'cancelled' : 'failed',
          text: error instanceof Error ? error.message : 'The worker result was unavailable.',
        };
      }
      if (input.signal?.aborted) {
        report('cancelled');
        return cancelled();
      }
      report('worker_terminal', { provider: launched.actualProvider, message: worker.status });

      try {
        await deps.deliverMainResult({
          chatId: input.chatId,
          userText: text,
          mainProvider: input.mainProvider,
          workerProvider: launched.actualProvider,
          childChatId: launched.childChatId,
          workerStatus: worker.status,
          workerText: worker.text,
          ...(captureNotice ? { captureNotice } : {}),
          instruction: VOICE_BRIEF_SYSTEM_INSTRUCTION,
        });
      } catch (error) {
        report('delivery_failed', {
          message: error instanceof Error ? error.message : 'The result could not be delivered.',
        });
        return {
          status: 'delivery_failed',
          duplicate: false,
          actualWorkerProvider: launched.actualProvider,
          childChatId: launched.childChatId,
          elapsedMs: deps.now() - startedAt,
        };
      }
      report('main_dispatched', { provider: input.mainProvider });
      return {
        status: 'main_dispatched',
        duplicate: false,
        actualWorkerProvider: launched.actualProvider,
        childChatId: launched.childChatId,
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
