import { messageRepo } from '@/lib/db';
import type { ChatId } from '@/types';
import type { ModelPickerOption } from '@/lib/ai/useAccessibleChatModels';
import { modelSupportsVision } from '@/lib/ai/vision';
import { modelSelectionContextFromAuth, validateSendModelAccess } from '@/lib/ai/modelSelection';
import { useAuthStore } from '@/stores/auth';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { toast } from '@/components/ui/toast';
import { readChatReasoningPreference } from '@/features/chat/reasoningSlashStore';
import { createVoiceAgentFlow } from './voiceAgentFlow';
import { dispatchVoiceMainRequest } from './voiceNativeDelegation';
import { voiceTaskCoordinator } from './voiceTaskCoordinator';
import { captureVoiceScreenAttachment } from './voiceScreenCapture';
import { ensureJarvisChatForProvider } from './voiceChatRouting';
import {
  resolveVoiceProviderSelection,
  type ParsedVoiceProviderOverrides,
} from './voiceProviderSelection';

// Distinguish a retry after a revoked pending scope from the coordinator's cached result.
let typedScopeRevision = 0;

/** A typed provider directive enters the same Main Agent decision path as speech. */
export async function startTypedAgentOverride(input: {
  parsed: ParsedVoiceProviderOverrides;
  options: readonly ModelPickerOption[];
  sourceChatId: string;
}): Promise<ChatId> {
  const text = input.parsed.taskText.trim();
  if (!text) throw new Error('Add a task after the provider instruction.');
  const auth = useAuthStore.getState();
  const identity = resolveAccountIdentity(auth);
  if (!identity || !auth.workspaceId) throw new Error('An account and workspace are required for this typed request.');
  const accountId = identity.accountId;
  const scopeRevision = typedScopeRevision;
  const controller = new AbortController();
  const unsubscribe = useAuthStore.subscribe((next, previous) => {
    const nextIdentity = resolveAccountIdentity(next);
    const previousIdentity = resolveAccountIdentity(previous);
    if (nextIdentity?.accountId !== previousIdentity?.accountId ||
        nextIdentity?.source !== previousIdentity?.source ||
        next.workspaceId !== previous.workspaceId || next.projectId !== previous.projectId) {
      if (!controller.signal.aborted) typedScopeRevision += 1;
      controller.abort();
    }
  });
  const requireCurrent = () => {
    if (controller.signal.aborted) throw new Error('The typed request scope changed before acceptance. Submit it again in the current scope.');
  };
  try {
    const requestedMainProvider = input.parsed.providers.main ?? auth.voiceMainAgentProvider;
    const workerProvider = input.parsed.providers.worker ?? auth.voiceWorkerProvider;
    const mainRoute = resolveVoiceProviderSelection({
      provider: requestedMainProvider,
      options: input.options,
      preferredSelection: auth.chatModelSelection,
      preservePreferredRoute: !input.parsed.providers.main,
    });
    const mainProvider = mainRoute.provider;
    const reasoningPreference = readChatReasoningPreference(input.sourceChatId);
    const modelCheck = validateSendModelAccess(
      text,
      mainRoute.selection,
      modelSelectionContextFromAuth(auth),
      auth.stackCustomSteps,
    );
    if (!modelCheck.ok) throw new Error(modelCheck.message);
    const chatId = await ensureJarvisChatForProvider(mainProvider, text);
    requireCurrent();
    if (!chatId) throw new Error('A Jarvis chat was unavailable for that provider.');
    if (input.parsed.saveAsDefault) {
      if (input.parsed.providers.main) { requireCurrent(); auth.setVoiceMainAgentProvider(input.parsed.providers.main); }
      if (input.parsed.providers.worker) { requireCurrent(); auth.setVoiceWorkerProvider(input.parsed.providers.worker); }
    }

    requireCurrent();
    const history = await messageRepo.listByChat(input.sourceChatId as ChatId);
    requireCurrent();
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
      reasoningPreference,
      sourceContext,
      signal: controller.signal,
      dedupeScope: JSON.stringify([accountId, auth.workspaceId, auth.projectId, String(chatId), scopeRevision]),
    };
    const receipt = await voiceTaskCoordinator.start(request, (report) => {
      const flow = createVoiceAgentFlow({
        now: Date.now,
        acknowledge: () => undefined,
        persistUser: async (turn) => {
          requireCurrent();
          const saved = await messageRepo.create({
            chat_id: turn.chatId as ChatId,
            role: 'user',
            parts: [{ kind: 'text', text: turn.text }],
          });
          requireCurrent();
          if (!saved?.id) throw new Error('The typed request could not be saved.');
          return String(saved.id);
        },
        captureScreen: async (requestText) => {
          requireCurrent();
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
        dispatchMain: (detail) => {
          requireCurrent();
          return dispatchVoiceMainRequest({ ...detail, accountId });
        },
        reportStatus: (status) => {
          if (controller.signal.aborted) return;
          report(status);
          if (status.phase === 'capture_failed') {
            toast.warning('Agent task', status.message ?? 'Screen unavailable; sending text.');
          }
        },
      });
      return flow.run(request);
    });
    if (receipt.status !== 'accepted') requireCurrent();
    if (receipt.status === 'persist_failed') throw new Error('The typed request could not be saved.');
    if (receipt.status === 'dispatch_failed')
      throw new Error('The Main Agent did not accept the typed request.');
    if (receipt.status === 'cancelled') throw new Error('The typed request was cancelled.');
    if (!controller.signal.aborted) toast.info(
      'Main Agent routed',
      'Sent to ' + (mainProvider === 'codex' ? 'Codex' : 'OpenCode') + '.',
    );
    return chatId;
  } finally {
    unsubscribe();
  }
}
