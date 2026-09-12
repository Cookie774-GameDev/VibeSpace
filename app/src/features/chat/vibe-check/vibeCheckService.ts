import { getChatPreview, subscribeChatPreviews } from '../streamingPreviewStore';
import { chatRepo, messageRepo, workspaceRepo } from '@/lib/db/repositories';
import { captureSyncQueueOwner } from '@/lib/cloudSyncQueueOwner';
import { resolveAccountIdentity } from '@/lib/accountIdentity';
import { useAuthStore } from '@/stores/auth';
import type { ChatId, MessageId, ProviderId } from '@/types/common';
import { selectionFromOption } from '@/lib/ai/modelSelection';
import { getChatRunState, type ChatRunState } from '../runtime/chatRunState';
import {
  readChatRuntimePolicyState,
  writeChatRuntimePolicyState,
} from '../runtime/chatRuntimeSettingsStore';
import { readChatReasoningPreference } from '../reasoningSlashStore';
import { dispatchChatToChat, dispatchJarvisSendWithAcceptance } from '../chatToChatDispatch';
import { projectChatHandoff, sanitizeChatHandoffText } from '../chatHandoffProjection';
import { getChatActivityEvents } from '../activity/activityStore';
import { auditInstruction, collectAuditEvidence } from './auditEvidence';
import {
  currentAuditScope,
  patchAudit,
  registerAuditCleanup,
  useVibeCheckStore,
  type AuditOptions,
} from './vibeCheckStore';

/** Waits for an idle gap, allowing the existing composer queue to drain first. */
export function waitForAuditSlot(
  chatId: string,
  signal: AbortSignal,
  interrupt: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let interrupted = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error('Audit closed.'));
    const check = () => {
      if (signal.aborted) return abort();
      const state = getChatRunState(chatId);
      if (state?.status !== 'running') return finish();
      if (interrupt && !interrupted) {
        if (!state.cancellationKey)
          return finish(new Error('This run cannot be interrupted safely. Wait for it to finish.'));
        interrupted = true;
        window.dispatchEvent(
          new CustomEvent('jarvis:cancel', { detail: { messageId: state.cancellationKey } }),
        );
      }
      timer = setTimeout(check, 250);
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(check, 150);
  });
}

export async function startVibeCheck(options: AuditOptions): Promise<void> {
  const initial = useVibeCheckStore.getState().session;
  if (!initial || ['preparing', 'waiting', 'running'].includes(initial.status)) return;
  const id = crypto.randomUUID();
  const controller = new AbortController();
  let targetId = '';
  let runKey: string | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let pollBusy = false;
  let unsubscribePreview: (() => void) | undefined;
  let livePreviewRun: string | undefined;
  let livePreviewText = '';
  let terminal = false;
  let baseline = new Set<string>();
  const valid = () =>
    !controller.signal.aborted &&
    currentAuditScope() === initial.scope &&
    useVibeCheckStore.getState().session?.id === id;
  const assertValid = () => {
    if (!valid()) throw new Error('The audit was closed or the account changed.');
  };
  const stopWatching = () => {
    clearInterval(poll);
    unsubscribePreview?.();
    window.removeEventListener('jarvis:run-state', onState as EventListener);
  };
  const readReport = async () => {
    if (!valid() || !targetId || pollBusy) return;
    pollBusy = true;
    try {
      const messages = await messageRepo.listByChat(targetId as ChatId);
      // Bind output to the accepted audit turn; stop at the next user message.
      const boundary = messages.findIndex((message) => String(message.id) === runKey);
      const after = boundary >= 0 ? messages.slice(boundary + 1) : [];
      const nextUser = after.findIndex((message) => message.role === 'user');
      const own = (nextUser < 0 ? after : after.slice(0, nextUser)).filter(
        (message) => !baseline.has(String(message.id)) && message.role === 'assistant',
      );
      const savedReport = sanitizeChatHandoffText(
        own
          .flatMap((message) =>
            message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])),
          )
          .join('\n\n'),
      );
      const report = !terminal && livePreviewRun ? livePreviewText : savedReport;
      if (valid() && report)
        patchAudit(id, {
          report,
          ...(!terminal ? { progress: 75, stage: 'Audit report arriving' } : {}),
        });
      if (terminal && valid()) {
        patchAudit(
          id,
          report
            ? { status: 'complete', stage: 'Audit complete', progress: 100 }
            : {
                status: 'error',
                stage: 'No audit returned',
                error: 'The run ended without a readable audit. Open the auditor chat for details.',
              },
        );
        stopWatching();
      }
    } catch (error) {
      if (valid())
        patchAudit(id, {
          status: 'error',
          stage: 'Could not read audit',
          error: error instanceof Error ? error.message : 'Audit unavailable.',
        });
      stopWatching();
    } finally {
      pollBusy = false;
    }
  };
  const onState = (event: Event) => {
    const state = (event as CustomEvent<ChatRunState>).detail;
    if (!valid() || state?.chatId !== targetId) return;
    if (!runKey || state.cancellationKey !== runKey) return;
    if (state.status === 'running')
      patchAudit(id, { status: 'running', stage: 'Auditor reviewing evidence', progress: 50 });
    else if (state.status === 'done') {
      terminal = true;
      void readReport();
    } else {
      patchAudit(id, {
        status: 'error',
        stage: state.status === 'cancelled' ? 'Audit stopped' : 'Audit failed',
        error: state.errorCode ?? 'Open the auditor chat for details, then retry.',
      });
      stopWatching();
    }
  };
  registerAuditCleanup(() => {
    controller.abort();
    stopWatching();
  });
  useVibeCheckStore.setState({
    session: {
      ...initial,
      id,
      options,
      status: 'preparing',
      stage: 'Gathering evidence',
      progress: 0,
      error: undefined,
      report: '',
      targetId: undefined,
    },
  });
  try {
    const auth = useAuthStore.getState();
    const source = await chatRepo.getById(initial.sourceId as ChatId);
    const workspace = source && (await workspaceRepo.getById(source.workspace_id));
    assertValid();
    if (
      !source ||
      source.archived ||
      source.workspace_id !== auth.workspaceId ||
      String(source.project_id ?? '') !== String(auth.projectId ?? '') ||
      workspace?.owner_id !== resolveAccountIdentity(auth)?.accountId
    )
      throw new Error('Source chat is unavailable in this account and project.');
    patchAudit(id, { title: source.title });
    if (options.auditor === 'main' || options.interrupt) {
      patchAudit(id, {
        status: 'waiting',
        stage: options.interrupt
          ? 'Stopping the current turn'
          : 'Waiting for current work to finish',
      });
      await waitForAuditSlot(initial.sourceId, controller.signal, options.interrupt);
    }
    assertValid();
    const messages = await messageRepo.listByChat(source.id);
    assertValid();
    const evidence = collectAuditEvidence(messages, getChatActivityEvents(source.id));
    const projection = projectChatHandoff({ sourceChat: source, messages });
    const instruction = `${auditInstruction(source.title, evidence)}\nSource chat id: ${initial.sourceId}. ${options.auditor === 'main' ? 'You are auditing this same chat; read its existing history.' : 'The source chat reference is attached below.'}`;
    patchAudit(id, {
      evidence,
      status: 'preparing',
      stage: 'Starting read-only audit',
      progress: 25,
    });
    if (options.auditor === 'new') {
      const previousAuditor = initial.auditorChatId
        ? await chatRepo.getById(initial.auditorChatId as ChatId)
        : undefined;
      assertValid();
      const reusable =
        previousAuditor &&
        !previousAuditor.archived &&
        previousAuditor.workspace_id === source.workspace_id &&
        String(previousAuditor.project_id ?? '') === String(source.project_id ?? '');
      const target = reusable
        ? previousAuditor
        : await chatRepo.createAuthorized(
            {
              workspace_id: source.workspace_id,
              project_id: source.project_id,
              title: `VibeCheck · ${source.title}`.slice(0, 160),
              mode: 'chat',
              active_agent_ids: [],
              connection: source.connection,
            },
            captureSyncQueueOwner(),
            valid,
          );
      assertValid();
      if (!target) throw new Error('Could not create the auditor chat.');
      targetId = String(target.id);
      patchAudit(id, { auditorChatId: targetId });
      if (reusable) {
        patchAudit(id, { status: 'waiting', stage: 'Waiting for the auditor to finish' });
        await waitForAuditSlot(targetId, controller.signal, false);
        assertValid();
      }
      baseline = new Set(
        (await messageRepo.listByChat(target.id)).map((message) => String(message.id)),
      );
      assertValid();
      writeChatRuntimePolicyState(targetId, {
        ...readChatRuntimePolicyState(initial.sourceId),
        access: 'read-only',
        approveAllForRun: false,
      });
    } else {
      targetId = initial.sourceId;
      baseline = new Set(messages.map((message) => String(message.id)));
    }
    patchAudit(id, { targetId });
    window.addEventListener('jarvis:run-state', onState as EventListener);
    const accountId = resolveAccountIdentity(auth)!.accountId;
    const oldPreviewRun = getChatPreview(accountId, targetId)?.runId;
    unsubscribePreview = subscribeChatPreviews(accountId, targetId, () => {
      if (!valid() || terminal || !runKey) return;
      const preview = getChatPreview(accountId, targetId);
      const active = getChatRunState(targetId);
      if (
        !preview ||
        preview.runId === oldPreviewRun ||
        active?.status !== 'running' ||
        active.cancellationKey !== runKey
      )
        return;
      const report = sanitizeChatHandoffText(preview.text);
      livePreviewRun = preview.runId;
      livePreviewText = report;
      if (report)
        patchAudit(id, { report, status: 'running', progress: 75, stage: 'Audit report arriving' });
    });
    poll = setInterval(() => void readReport(), 250);
    if (options.auditor === 'new') {
      const receipt = await dispatchChatToChat({
        sourceChatId: initial.sourceId,
        targetChatId: targetId,
        projection,
        instruction,
        dispatchKey: `vibe-check:${id}`,
        queueIfBusy: true,
        onPrepared: (messageId) => {
          assertValid();
          runKey = messageId;
        },
      });
      assertValid();
      if ('messageId' in receipt) runKey = receipt.messageId;
      if (receipt.status !== 'dispatched')
        throw new Error(
          `Audit was not accepted: ${receipt.status}${'reason' in receipt ? ` (${receipt.reason})` : ''}.`,
        );
    } else {
      if (getChatRunState(targetId)?.status === 'running')
        throw new Error('Another turn started. Retry after it finishes.');
      const message = await messageRepo.create({
        chat_id: source.id,
        role: 'user',
        parts: [{ kind: 'text', text: instruction }],
      });
      assertValid();
      runKey = String(message.id);
      const connection = source.connection;
      const modelId =
        connection?.modelId ??
        (auth.chatModelSelection.mode === 'single' &&
        auth.chatModelSelection.providerId === connection?.providerId
          ? auth.chatModelSelection.modelId
          : undefined);
      const selection =
        connection && modelId
          ? selectionFromOption(connection.providerId as ProviderId, modelId, connection)
          : auth.chatModelSelection;
      if (getChatRunState(targetId)?.status === 'running')
        throw new Error(
          'Another turn started. The audit prompt is saved; retry when the chat is idle.',
        );
      await dispatchJarvisSendWithAcceptance({
        chatId: targetId,
        // Close the idle-check race using the runtime's existing per-chat queue.
        queueIfBusy: true,
        cancellationKey: message.id as MessageId,
        text: instruction,
        accessLevel: 'read-only',
        interactionMode: 'ask',
        runtimeSettings: readChatRuntimePolicyState(targetId).settings,
        reasoningPreference: readChatReasoningPreference(targetId),
        modelSelectionOverride: selection,
        automaticModelRoutingEligible: false,
      });
    }
    assertValid();
    const acceptedState = getChatRunState(targetId);
    if (acceptedState?.cancellationKey === runKey)
      onState(new CustomEvent('jarvis:run-state', { detail: acceptedState }));
    void readReport();
  } catch (error) {
    if (valid())
      patchAudit(id, {
        status: 'error',
        stage: 'Audit could not finish',
        error:
          error instanceof Error && error.message.includes('RUNTIME_TIMEOUT')
            ? 'Startup could not be confirmed. Check the audit chat before retrying; the saved audit may still run.'
            : error instanceof Error
              ? error.message
              : 'Audit unavailable.',
      });
    stopWatching();
  }
}
