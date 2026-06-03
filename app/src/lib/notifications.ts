import { notify } from '@/lib/tauri';
import { useUIStore, type DoneNotificationKey } from '@/stores/ui';

export const DONE_NOTIFICATION_LABELS: Record<DoneNotificationKey, string> = {
  jarvis: 'Jarvis done',
  terminal: 'Terminal done',
  tasks: 'Task done',
  contextMaps: 'Context map done',
  skills: 'Skills done',
};

export function getAiCompletionInstruction(): string {
  if (!useUIStore.getState().aiCompletionCue) return '';
  return [
    'Completion behavior:',
    'When the user request is fully handled, close with a concise confirmation that the task is done.',
    'If something is blocked or incomplete, say exactly what remains instead of implying completion.',
  ].join('\n');
}

export async function notifyDone(
  kind: DoneNotificationKey,
  title: string,
  body?: string,
): Promise<void> {
  const state = useUIStore.getState();
  if (!state.notificationMaster || !state.doneNotifications[kind]) return;

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('jarvis:done-notification', {
      detail: { kind, title, body },
    }));
  }

  await notify(title || DONE_NOTIFICATION_LABELS[kind], body);
}
