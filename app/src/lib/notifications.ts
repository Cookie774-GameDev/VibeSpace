import { notify } from '@/lib/tauri';
import { useUIStore, type DoneNotificationKey } from '@/stores/ui';

export const DONE_NOTIFICATION_LABELS: Record<DoneNotificationKey, string> = {
  jarvis: 'Jarvis done',
  terminal: 'Terminal done',
  tasks: 'Task done',
  contextMaps: 'Context map done',
  skills: 'Skills done',
};

const DONE_NOTIFICATION_DEDUPE_MS = 4_000;
const recentDoneNotifications = new Map<string, number>();

export interface NotifyDoneOptions {
  /** Allow in-app toast when OS notifications are unavailable (explicit test only). */
  allowFallbackToast?: boolean;
}

export function getAiCompletionInstruction(): string {
  if (!useUIStore.getState().aiCompletionCue) return '';
  return [
    'Completion behavior:',
    'When the user request is fully handled, close with a concise confirmation that the task is done.',
    'If something is blocked or incomplete, say exactly what remains instead of implying completion.',
  ].join('\n');
}

function shouldSkipDuplicateDoneNotification(
  kind: DoneNotificationKey,
  title: string,
  body?: string,
): boolean {
  const key = `${kind}\0${title}\0${body ?? ''}`;
  const now = Date.now();
  const last = recentDoneNotifications.get(key);
  if (last !== undefined && now - last < DONE_NOTIFICATION_DEDUPE_MS) {
    return true;
  }
  recentDoneNotifications.set(key, now);
  if (recentDoneNotifications.size > 64) {
    for (const [entryKey, ts] of recentDoneNotifications) {
      if (now - ts > DONE_NOTIFICATION_DEDUPE_MS) {
        recentDoneNotifications.delete(entryKey);
      }
    }
  }
  return false;
}

/** @internal Test helper */
export function resetDoneNotificationDedupeForTests(): void {
  recentDoneNotifications.clear();
}

export async function notifyDone(
  kind: DoneNotificationKey,
  title: string,
  body?: string,
  options: NotifyDoneOptions = {},
): Promise<void> {
  const state = useUIStore.getState();
  if (!state.notificationMaster || !state.doneNotifications[kind]) return;
  if (shouldSkipDuplicateDoneNotification(kind, title, body)) return;

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jarvis:done-notification', {
      detail: { kind, title, body },
    }));
  }

  await notify(title || DONE_NOTIFICATION_LABELS[kind], body, {
    fallbackToast: options.allowFallbackToast === true,
  });
}
