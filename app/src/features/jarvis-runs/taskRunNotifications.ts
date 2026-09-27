import { notifyDone } from '@/lib/notifications';
import type { JarvisEvent, JarvisRunStatus } from '@/lib/jarvis/contracts/execution';
import { notify as nativeNotify } from '@/lib/tauri';
import { chatRepo, workspaceRepo } from '@/lib/db/repositories';
import { jarvisRunRepo } from '@/lib/db/jarvisRepositories';
import { hasDetectedSecret } from '@/lib/security/secretDetector';
import { useUIStore } from '@/stores/ui';
import type { ChatId } from '@/types/common';
import { useJarvisTaskRunStore } from './taskRunStore';

interface TaskRunNotificationBindings {
  accountId?: string;
  subscribe: (listener: (event: JarvisEvent) => void) => () => void;
  notify?: (
    title: string,
    body: string,
    status: JarvisRunStatus,
    completionIdentity?: string,
  ) => Promise<unknown> | unknown;
  onError?: (error: unknown) => void;
}

const COPY: Partial<Record<JarvisRunStatus, readonly [string, string]>> = {
  awaiting_approval: ['Jarvis task needs approval', 'Open VibeSpace to review the pending action.'],
  partial: ['Jarvis task needs input', 'Open VibeSpace to provide the requested input.'],
  completed: ['Jarvis task completed', 'Open VibeSpace to view the verified result.'],
  failed: ['Jarvis task failed', 'Open VibeSpace to review the failure and next step.'],
  timed_out: ['Jarvis task timed out', 'Open VibeSpace to review the timeout and next step.'],
  cancelled: ['Jarvis task stopped', 'Open VibeSpace to resume when ready.'],
};

const TASK_TITLE_PREFIX: Partial<Record<JarvisRunStatus, string>> = {
  awaiting_approval: 'Approval needed',
  partial: 'Input needed',
  completed: 'Completed',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Stopped',
};

function displayText(value: string | undefined, limit: number): string | undefined {
  if (!value || hasDetectedSecret(value)) return undefined;
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  const characters = Array.from(text);
  return characters.length > limit
    ? `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`
    : text;
}

export function notificationVariant(status: JarvisRunStatus) {
  if (status === 'completed') return 'task_completed' as const;
  if (status === 'partial' || status === 'awaiting_approval') {
    return 'task_attention' as const;
  }
  if (status === 'failed' || status === 'timed_out') return 'task_failed' as const;
  if (status === 'cancelled') return 'task_stopped' as const;
  return undefined;
}

async function defaultNotify(
  title: string,
  body: string,
  status: JarvisRunStatus,
  completionIdentity?: string,
): Promise<void> {
  const settings = useUIStore.getState();
  if (!settings.notificationMaster || !settings.doneNotifications.tasks) return;
  if (status === 'completed') {
    await notifyDone('tasks', title, body, {
      allowFallbackToast: true,
      variant: notificationVariant(status),
      ...(completionIdentity ? { completionIdentity } : {}),
    });
    return;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('jarvis:task-notification', { detail: { title, status } }),
    );
  }
  await nativeNotify(title, body, {
    fallbackToast: true,
    silent: settings.notificationSound === false,
    variant: notificationVariant(status),
  });
}

export function startJarvisTaskRunNotifications(bindings: TaskRunNotificationBindings): () => void {
  const notify = bindings.notify ?? defaultNotify;
  const highestSequenceByRun = new Map<string, number>();
  return bindings.subscribe((event) => {
    if (event.type !== 'run_state') return;
    const highestSequence = highestSequenceByRun.get(event.runId);
    if (highestSequence !== undefined && event.seq <= highestSequence) return;
    highestSequenceByRun.set(event.runId, event.seq);
    const status = event.status as JarvisRunStatus | undefined;
    if (!status) return;
    const copy = COPY[status];
    if (!copy) return;
    const completionIdentity = status === 'completed' ? `jarvis-run:${event.runId}` : undefined;
    const state = useJarvisTaskRunStore.getState();
    const send = async () => {
      let title = copy[0];
      let body = copy[1];
      if (bindings.accountId && state.accountScope) {
        const run = await jarvisRunRepo
          .getById(bindings.accountId, event.runId)
          .catch(() => undefined);
        if (state.accountScope !== useJarvisTaskRunStore.getState().accountScope) return;
        if (run?.accountId === bindings.accountId) {
          const projection = useJarvisTaskRunStore.getState().runs[event.runId];
          const taskName = projection?.canonical ? displayText(projection.goal, 48) : undefined;
          if (taskName && taskName !== 'Jarvis task') {
            title = `${TASK_TITLE_PREFIX[status] ?? copy[0]}: ${taskName}`;
          }
          if (run.chatId) {
            const chat = await chatRepo.getById(run.chatId as ChatId).catch(() => undefined);
            const workspace = chat
              ? await workspaceRepo.getById(chat.workspace_id).catch(() => undefined)
              : undefined;
            if (state.accountScope !== useJarvisTaskRunStore.getState().accountScope) return;
            if (
              workspace?.owner_id === bindings.accountId &&
              (!run.workspaceId || run.workspaceId === chat?.workspace_id)
            ) {
              const chatName = displayText(chat?.title, 56);
              if (chatName) body = displayText(`Chat: ${chatName}. ${body}`, 112) ?? body;
            }
          }
        }
      }
      await notify(title, body, status, completionIdentity);
    };
    void send().catch((error) => {
      if (bindings.onError) bindings.onError(error);
      else console.warn('[jarvis-task] notification unavailable', error);
    });
  });
}
