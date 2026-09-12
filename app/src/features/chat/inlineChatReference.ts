import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';

// Stable editor-only markers. The renderer exposes titles, and delivery removes markers.
export const chatReferenceToken = (id: string) => `⟦chat:${id}⟧`;
export type InlineChatSegment = { text: string; reference?: ChatHandoffProjectionV1 };
export function inlineChatSegments(
  text: string,
  references: readonly ChatHandoffProjectionV1[],
): InlineChatSegment[] {
  const byToken = new Map(
    references.map((reference) => [chatReferenceToken(reference.source.chatId), reference]),
  );
  const segments: InlineChatSegment[] = [];
  let start = 0;
  for (const match of text.matchAll(/⟦chat:[^⟧\r\n]+⟧/gu)) {
    const reference = byToken.get(match[0]);
    if (!reference) continue;
    if (match.index > start) segments.push({ text: text.slice(start, match.index) });
    segments.push({ text: match[0], reference });
    start = match.index + match[0].length;
  }
  if (start < text.length) segments.push({ text: text.slice(start) });
  return segments;
}
export function readableReferenceText(
  text: string,
  references: readonly ChatHandoffProjectionV1[],
) {
  return inlineChatSegments(text, references)
    .map((segment) => (segment.reference ? `“${segment.reference.source.title}”` : segment.text))
    .join('');
}
export function insertChatReference(text: string, id: string, position: number) {
  const token = chatReferenceToken(id);
  if (text.includes(token)) return { text, caret: text.indexOf(token) + token.length };
  const offset = Math.max(0, Math.min(position, text.length));
  const before = text.slice(0, offset),
    after = text.slice(offset);
  const inserted = `${before && !/\s$/u.test(before) ? ' ' : ''}${token}${after && /^\s/u.test(after) ? '' : ' '}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
