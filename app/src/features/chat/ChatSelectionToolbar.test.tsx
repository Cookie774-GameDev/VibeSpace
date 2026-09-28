import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatSelectionToolbar } from './ChatSelectionToolbar';
import { CHAT_ANNOTATION_ATTACH_EVENT } from './chatAnnotations';

function renderSelection() {
  const rootRef = createRef<HTMLDivElement>();
  render(
    <div ref={rootRef}>
      <div data-tour="chat-thread">
        <span>Selected reply text</span>
      </div>
      <ChatSelectionToolbar chatId="chat-one" rootRef={rootRef} />
    </div>,
  );
  const text = screen.getByText('Selected reply text').firstChild!;
  const range = document.createRange();
  range.selectNodeContents(text);
  range.getBoundingClientRect = () => ({ top: 80, bottom: 98, left: 40 }) as DOMRect;
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(rootRef.current!);
  return rootRef;
}

describe('ChatSelectionToolbar', () => {
  it('attaches highlighted chat text to the matching composer without sending', () => {
    const onAttach = vi.fn();
    window.addEventListener(CHAT_ANNOTATION_ATTACH_EVENT, onAttach);
    renderSelection();
    fireEvent.click(screen.getByRole('button', { name: 'Attach to Chat' }));
    expect(onAttach).toHaveBeenCalledOnce();
    expect((onAttach.mock.calls[0]![0] as CustomEvent).detail).toEqual({
      chatId: 'chat-one',
      text: 'Selected reply text',
      anchor: { top: 106, left: 40 },
    });
    expect(screen.queryByRole('toolbar', { name: 'Selected chat text' })).toBeNull();
    window.removeEventListener(CHAT_ANNOTATION_ATTACH_EVENT, onAttach);
  });

  it('offers Copy and Attach to Chat without a duplicate Ask Jarvis action', () => {
    renderSelection();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach to Chat' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask Jarvis' })).toBeNull();
  });
});
