import { isDefaultChatTitle } from '@/features/chat/chatLifecycle';
import { hasDetectedSecret } from '@/lib/security/secretDetector';

export type ChatNotificationStatus = 'completed' | 'failed' | 'stopped';

const TITLE_LIMIT = 64;
const BODY_LIMIT = 112;

function safeText(value: string | undefined, limit: number): string | undefined {
  if (!value || hasDetectedSecret(value)) return undefined;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return undefined;
  const characters = Array.from(clean);
  return characters.length > limit
    ? `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`
    : clean;
}

export function chatNotificationCopy(input: {
  status: ChatNotificationStatus;
  agentName: string;
  chatTitle?: string;
  taskText?: string;
}): { title: string; body: string } {
  const prefix =
    input.status === 'completed' ? 'Finished' : input.status === 'failed' ? 'Failed' : 'Stopped';
  const task = safeText(input.taskText, TITLE_LIMIT - prefix.length - 2);
  const agent = safeText(input.agentName, TITLE_LIMIT - prefix.length - 2) ?? 'Jarvis';
  const title = `${prefix}: ${task ?? agent}`;
  const chat = isDefaultChatTitle(input.chatTitle) ? undefined : safeText(input.chatTitle, 48);
  const nextStep =
    input.status === 'completed'
      ? 'Open VibeSpace to view the reply.'
      : input.status === 'failed'
        ? 'Open VibeSpace to review the failure.'
        : 'Open VibeSpace to resume when ready.';
  const body = chat ? `Chat: ${chat}. ${nextStep}` : nextStep;
  return { title, body: safeText(body, BODY_LIMIT) ?? nextStep };
}
