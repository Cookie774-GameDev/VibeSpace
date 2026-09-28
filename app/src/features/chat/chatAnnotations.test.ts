import { describe, expect, it } from 'vitest';
import { appendChatAnnotations } from './chatAnnotations';

describe('appendChatAnnotations', () => {
  it('includes selected text and comments in the sent message in display order', () => {
    expect(
      appendChatAnnotations('Please compare these', [
        { id: 'one', text: 'first\nline', comment: 'Why?' },
        { id: 'two', text: 'second', comment: '' },
      ]),
    ).toBe(
      'Please compare these\n\nAnnotation 1:\n> first\n> line\nComment: Why?\n\nAnnotation 2:\n> second',
    );
  });

  it('allows a selected quote with no separate prompt', () => {
    expect(appendChatAnnotations('', [{ id: 'one', text: 'selected', comment: 'Explain' }])).toBe(
      'Annotation 1:\n> selected\nComment: Explain',
    );
  });
});
