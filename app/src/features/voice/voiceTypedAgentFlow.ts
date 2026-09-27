import { messageRepo } from '@/lib/db';
import type { ChatId } from '@/types';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { modelSupportsVision } from '@/lib/ai/vision';
import { modelSelectionContextFromAuth, validateSendModelAccess } from '@/lib/ai/modelSelection';
import { useAuthStore } from '@/stores/auth';
import { useJarvisInteractionStore } from '@/features/jarvis-interaction/sessionStore';
import { launchJarvisChatAgent } from '@/features/jarvis-interaction/agentRunner';
import { toast } from '@/components/ui/toast';
import {
  buildVoiceMainResultSendDetail,
  createVoiceAgentFlow,
  type VoiceWorkerOutcome,
} from './voiceAgentFlow';
import { captureVoiceScreenAttachment } from './voiceScreenCapture';
import { ensureJarvisChatForProvider } from './voiceChatRouting';
import {
  resolveVoiceProviderSelection,
  type ParsedVoiceProviderOverrides,
} from './voiceProviderSelection';

async function waitForTypedWorker(
  parentChatId: string,
  agentId: string,
  childChatId: string,
): Promise<VoiceWorkerOutcome> {
  const status = await new Promise<VoiceWorkerOutcome['status']>((resolve) => {
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const check = () => {
      const card = useJarvisInteractionStore
        .getState()
        .agentsForChat(parentChatId)
        .find((candidate) => String(candidate.agentId) === agentId);
      if (card && ['done', 'blocked', 'failed', 'cancelled'].includes(card.status) && !closed) {
        closed = true;
        unsubscribe();
        clearTimeout(timeout);
        resolve(card.status as VoiceWorkerOutcome['status']);
      }
    };
    const timeout = setTimeout(() => {
      if (closed) return;
      closed = true;
      unsubscribe();
      resolve('failed');
    }, 10 * 60_000);
    unsubscribe = useJarvisInteractionStore.subscribe(check);
    check();
  });
  const messages = await messageRepo.listByChat(childChatId as ChatId);
  const final = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' || message.role === 'agent');
  const text = final?.parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  const card = useJarvisInteractionStore
    .getState()
    .agentsForChat(parentChatId)
    .find((candidate) => String(candidate.agentId) === agentId);
  return { status, text: text || card?.summary || card?.error || `Worker ${status}.` };
}

/** Typed provider directives use the same one-worker coordinator as speech. */
export async function startTypedAgentOverride(input: {
  parsed: ParsedVoiceProviderOverrides;
  options: readonly ModelPickerOption[];
  sourceChatId: string;
}): Promise<ChatId> {
  const text = input.parsed.taskText.trim();
  if (!text) throw new Error('Add a task after the provider instruction.');
  const auth = useAuthStore.getState();
  const mainProvider = input.parsed.providers.main ?? auth.voiceMainAgentProvider;
  const workerProvider = input.parsed.providers.worker ?? auth.voiceWorkerProvider;
  const mainRoute = resolveVoiceProviderSelection({
    provider: mainProvider,
    options: input.options,
    preferredSelection: auth.chatModelSelection,
  });
  resolveVoiceProviderSelection({
    provider: workerProvider,
    options: input.options,
    preferredSelection: auth.chatModelSelection,
  });
  const modelCheck = validateSendModelAccess(
    text,
    mainRoute.selection,
    modelSelectionContextFromAuth(auth),
    auth.stackCustomSteps,
  );
  if (!modelCheck.ok) throw new Error(modelCheck.message);
  const chatId = await ensureJarvisChatForProvider(mainProvider, text);
  if (!chatId) throw new Error('A Jarvis chat was unavailable for that provider.');
  if (input.parsed.saveAsDefault) {
    if (input.parsed.providers.main) auth.setVoiceMainAgentProvider(input.parsed.providers.main);
    if (input.parsed.providers.worker) auth.setVoiceWorkerProvider(input.parsed.providers.worker);
  }

  let launched = false;
  let resolveLaunch!: () => void;
  let rejectLaunch!: (error: Error) => void;
  const launchReceipt = new Promise<void>((resolve, reject) => {
    resolveLaunch = resolve;
    rejectLaunch = reject;
  });

  const flow = createVoiceAgentFlow({
    now: Date.now,
    acknowledge: () => undefined,
    persistUser: async (request) => {
      await messageRepo.create({
        chat_id: request.chatId as ChatId,
        role: 'user',
        parts: [{ kind: 'text', text: request.text }],
      });
    },
    captureScreen: async (requestText, provider) => {
      const route = resolveVoiceProviderSelection({
        provider,
        options: input.options,
        preferredSelection: useAuthStore.getState().chatModelSelection,
      });
      if (
        route.selection.mode !== 'single' ||
        !modelSupportsVision(route.selection.providerId, route.selection.modelId)
      ) {
        return {
          ok: false,
          code: 'worker_model_no_vision',
          message: 'The selected worker model cannot receive a screenshot; continuing with text.',
        };
      }
      return captureVoiceScreenAttachment(requestText);
    },
    launchWorker: async (request) => {
      const route = resolveVoiceProviderSelection({
        provider: request.requestedProvider,
        options: input.options,
        preferredSelection: useAuthStore.getState().chatModelSelection,
      });
      const history = await messageRepo.listByChat(input.sourceChatId as ChatId);
      const context = history
        .slice(-8)
        .map((message) => {
          const excerpt = message.parts
            .filter((part) => part.kind === 'text')
            .map((part) => part.text)
            .join(' ')
            .slice(0, 700);
          return excerpt ? `${message.role}: ${excerpt}` : '';
        })
        .filter(Boolean)
        .join('\n')
        .slice(-4_000);
      const launched = await launchJarvisChatAgent({
        parentChatId: request.parentChatId,
        task: context
          ? `${request.task}\n\nRecent parent conversation (context only):\n${context}`
          : request.task,
        modelLabel: route.modelLabel,
        modelSelection: route.selection,
        workerProvider: route.provider,
        imageAttachments: request.imageAttachments,
        recordParentCommand: false,
      });
      return { ...launched, actualProvider: route.provider };
    },
    waitForWorker: (request) =>
      waitForTypedWorker(request.parentChatId, request.agentId, request.childChatId),
    deliverMainResult: async (delivery) => {
      const route = resolveVoiceProviderSelection({
        provider: delivery.mainProvider,
        options: input.options,
        preferredSelection: useAuthStore.getState().chatModelSelection,
      });
      const detail = buildVoiceMainResultSendDetail({ delivery, selection: route.selection });
      window.dispatchEvent(new CustomEvent('jarvis:send', { detail }));
    },
    reportStatus: (status) => {
      if (status.phase === 'launched') {
        launched = true;
        resolveLaunch();
        toast.info(
          'Worker routed',
          `Task sent to ${status.provider === 'codex' ? 'Codex' : 'OpenCode'}.`,
        );
      } else if (status.phase === 'launch_failed') {
        rejectLaunch(new Error(status.message ?? 'The worker could not start.'));
      } else if (status.phase === 'capture_failed') {
        toast.warning('Agent task', status.message ?? 'The task could not start.');
      }
    },
  });
  void flow
    .run({ chatId, text, mainProvider, workerProvider })
    .then((result) => {
      if (result.status === 'delivery_failed') {
        toast.error(
          'Agent result failed',
          'The worker finished, but the result could not be delivered.',
        );
      }
    })
    .catch((error) => {
      const failure = error instanceof Error ? error : new Error('The result was unavailable.');
      if (!launched) rejectLaunch(failure);
      else toast.error('Agent task failed', failure.message);
    });
  await launchReceipt;
  return chatId;
}
