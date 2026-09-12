import { describe, expect, it } from 'vitest';
import {
  chatReferenceToken,
  inlineChatSegments,
  insertChatReference,
  readableReferenceText,
} from './inlineChatReference';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';
const ref = (id: string, title: string) =>
  ({ source: { chatId: id, title } }) as ChatHandoffProjectionV1;
describe('inline chat references', () => {
  it('inserts at the caret without replacing surrounding text or other chats', () => {
    const first = insertChatReference('Compare these please', 'sales', 8);
    const second = insertChatReference(first.text, 'support', first.caret);
    expect(
      readableReferenceText(second.text, [ref('sales', 'Sales'), ref('support', 'Support')]),
    ).toBe('Compare “Sales” “Support” these please');
  });
  it('deduplicates the same chat while distinguishing duplicate titles', () => {
    const first = insertChatReference('', 'a', 0);
    expect(insertChatReference(first.text, 'a', 0).text).toBe(first.text);
    const text = first.text + chatReferenceToken('b');
    expect(
      inlineChatSegments(text, [ref('a', 'Sales'), ref('b', 'Sales')])
        .filter((s) => s.reference)
        .map((s) => s.reference!.source.chatId),
    ).toEqual(['a', 'b']);
  });
  it('does not grant a reference from an unrecognized pasted marker', () => {
    expect(inlineChatSegments(chatReferenceToken('foreign'), [])).toEqual([
      { text: chatReferenceToken('foreign') },
    ]);
  });
});
