import type { Message } from '@/types';

/** Bounded observed chat history, never model reasoning or arbitrary filesystem contents. */
export function collectCaoLearningEvidence(
  messages: readonly Message[],
  chatIds: readonly string[],
) {
  const allowed = new Set(chatIds);
  const candidates = messages
    .filter(
      (message) =>
        allowed.has(message.chat_id) &&
        message.role !== 'system' &&
        !(
          message.role === 'user' &&
          message.parts.some(
            (part) => part.kind === 'text' && part.text.startsWith('[CAO acting for user]'),
          )
        ),
    )
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
  const records: string[] = [];
  const sourceIds: string[] = [];
  let size = 0;
  let truncated = candidates.length > 200;
  for (const message of candidates.slice(0, 200)) {
    if (message.parts.length > 64) truncated = true;
    const parts = message.parts.slice(0, 64).flatMap<{ kind: string; text: string }>((part) => {
      if (part.kind === 'text') {
        if (part.text.length > 6000) truncated = true;
        return [{ kind: part.kind, text: redact(part.text).slice(0, 6000) }];
      }
      if (
        [
          'tool_call',
          'tool_result',
          'action_proposal',
          'file_ref',
          'question_answer',
          'permission_request',
          'plan_review',
          'chat_handoff',
        ].includes(part.kind)
      ) {
        const text = redact(
          JSON.stringify(part, (key, value) =>
            /password|secret|token|authorization|api.?key/i.test(key) ? '[redacted]' : value,
          ),
        );
        if (text.length > 3000) truncated = true;
        return [{ kind: part.kind, text: text.slice(0, 3000) }];
      }
      return [];
    });
    if (!parts.length) continue;
    const record = JSON.stringify({
      messageId: message.id,
      chatId: message.chat_id,
      role: message.role,
      agentId: message.agent_id,
      occurredAt: message.created_at,
      parts,
    });
    if (size + record.length + 1 > 80000) {
      truncated = true;
      continue;
    }
    records.push(record);
    sourceIds.push(message.id);
    size += record.length + 1;
  }
  return { text: records.reverse().join('\n'), sourceIds: sourceIds.reverse(), truncated };
}

function redact(text: string): string {
  return text
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,})\b/g,
      '[redacted]',
    )
    .replace(
      /\b(?:Bearer\s+\S+|Authorization\s*:\s*[^\r\n]+|Cookie\s*:\s*[^\r\n]+)/gi,
      '[redacted]',
    )
    .replace(
      /\b(password|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret)\s*(?:[:=]|\bis\b)\s*\S+/gi,
      '$1=[redacted]',
    );
}
