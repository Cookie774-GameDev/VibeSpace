import type { Message } from '@/types';

export const RESUME_ORIGINAL_REQUEST_PREFIX =
  'Continue the original user request below from the retained conversation. Preserve its constraints and permission limits. Reuse completed work; do not perform extra checks or actions unless the original request requires them.\n\nOriginal user request:\n';

const LEGACY_CONTINUATION =
  'Continue the interrupted task from the retained conversation and any progress in this persistent session. Check what is already complete before doing more work; do not repeat completed actions.';

type RetainedMessage = Pick<Message, 'id' | 'chat_id' | 'role' | 'parts'>;

/** Reuse actual retained user text; never summarize it or infer a task from tool output. */
export function buildComposerResumeRequest(
  chatId: string,
  history: readonly RetainedMessage[],
  cancellationKey?: string | null,
): string | undefined {
  const requests = history
    .filter((message) => String(message.chat_id) === chatId && message.role === 'user')
    .map((message) => ({
      id: String(message.id),
      text: message.parts.flatMap((part) => part.kind === 'text' ? [part.text] : []).join('\n'),
    }))
    .filter(({ text }) => text.trim().length > 0 && text !== LEGACY_CONTINUATION);
  // Runtime resumes can have a transient cancellation ID, not a persisted message ID.
  const retained = requests.find(({ id }) => id === cancellationKey) ?? requests.at(-1);
  if (!retained) return undefined;
  return retained.text.startsWith(RESUME_ORIGINAL_REQUEST_PREFIX)
    ? retained.text
    : RESUME_ORIGINAL_REQUEST_PREFIX + retained.text;
}
