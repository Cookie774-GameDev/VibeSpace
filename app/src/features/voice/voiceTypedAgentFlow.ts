import { messageRepo } from '@/lib/db';
import type { ChatId } from '@/types';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { modelSupportsVision } from '@/lib/ai/vision';
import { modelSelectionContextFromAuth, validateSendModelAccess } from '@/lib/ai/modelSelection';
import { useAuthStore } from '@/stores/auth';
import { toast } from '@/components/ui/toast';
import { createVoiceAgentFlow } from './voiceAgentFlow';
import { dispatchVoiceMainRequest } from './voiceNativeDelegation';
import { voiceTaskCoordinator } from './voiceTaskCoordinator';
import { captureVoiceScreenAttachment } from './voiceScreenCapture';
import { ensureJarvisChatForProvider } from './voiceChatRouting';
import {
  resolveVoiceProviderSelection,
  type ParsedVoiceProviderOverrides,
} from './voiceProviderSelection';

/** A typed provider directive enters the same Main Agent decision path as speech. */
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

  const history = await messageRepo.listByChat(input.sourceChatId as ChatId);
  const sourceContext = history
    .slice(-8)
    .map((message) => {
      const excerpt = message.parts
        .filter((part) => part.kind === 'text')
        .map((part) => part.text)
        .join(' ')
        .slice(0, 700);
      return excerpt ? message.role + ': ' + excerpt : '';
    })
    .filter(Boolean)
    .join('\n')
    .slice(-4_000);

  const request = {
    chatId: String(chatId),
    text,
    mainProvider,
    workerProvider,
    selection: mainRoute.selection,
    sourceContext,
  };
  const receipt = await voiceTaskCoordinator.start(request, (report) => {
    const flow = createVoiceAgentFlow({
      now: Date.now,
      acknowledge: () => undefined,
      persistUser: async (turn) => {
        const saved = await messageRepo.create({
          chat_id: turn.chatId as ChatId,
          role: 'user',
          parts: [{ kind: 'text', text: turn.text }],
        });
        if (!saved?.id) throw new Error('The typed request could not be saved.');
        return String(saved.id);
      },
      captureScreen: async (requestText) => {
        if (
          mainRoute.selection.mode !== 'single' ||
          !modelSupportsVision(mainRoute.selection.providerId, mainRoute.selection.modelId)
        ) {
          return {
            ok: false as const,
            code: 'main_model_no_vision',
            message: 'The selected Main Agent model cannot receive a screenshot; sending text.',
          };
        }
        return captureVoiceScreenAttachment(requestText);
      },
      dispatchMain: dispatchVoiceMainRequest,
      reportStatus: (status) => {
        report(status);
        if (status.phase === 'capture_failed') {
          toast.warning('Agent task', status.message ?? 'Screen unavailable; sending text.');
        }
      },
    });
    return flow.run(request);
  });
  if (receipt.status === 'persist_failed') throw new Error('The typed request could not be saved.');
  if (receipt.status === 'dispatch_failed')
    throw new Error('The Main Agent did not accept the typed request.');
  if (receipt.status === 'cancelled') throw new Error('The typed request was cancelled.');
  toast.info(
    'Main Agent routed',
    'Sent to ' + (mainProvider === 'codex' ? 'Codex' : 'OpenCode') + '.',
  );
  return chatId;
}
