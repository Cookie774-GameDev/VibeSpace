import { createRef, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineChatReferenceInput } from './InlineChatReferenceInput';
import { chatReferenceToken } from './inlineChatReference';
import type { ChatHandoffProjectionV1 } from './chatHandoffProjection';
afterEach(cleanup);
const references = [
  { source: { chatId: 'sales', title: 'Sales chat' } } as ChatHandoffProjectionV1,
];
describe('inline reference editor', () => {
  it('keeps a native textarea for ordinary messages', () => {
    render(
      <InlineChatReferenceInput
        references={[]}
        onOpenReference={() => {}}
        aria-label="Message"
        value="hello"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('textbox').tagName).toBe('TEXTAREA');
  });
  it('renders the reference inside the editable text, exposes selection and deletes it atomically', () => {
    const handle = createRef<HTMLTextAreaElement>();
    function Editor() {
      const [value, setValue] = useState(`Before ${chatReferenceToken('sales')} after`);
      return (
        <InlineChatReferenceInput
          ref={handle}
          references={references}
          onOpenReference={() => {}}
          aria-label="Message"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    }
    render(<Editor />);
    const root = screen.getByRole('textbox');
    expect(root.contains(screen.getByRole('button', { name: 'Reference Sales chat' }))).toBe(true);
    expect(root.textContent).toBe('Before Sales chat after');
    handle.current!.focus();
    handle.current!.setSelectionRange(
      7 + chatReferenceToken('sales').length,
      7 + chatReferenceToken('sales').length,
    );
    fireEvent.keyDown(root, { key: 'Backspace' });
    expect(handle.current!.value).toBe('Before  after');
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('opens and selects the whole reference when clicked', () => {
    const open = vi.fn(),
      handle = createRef<HTMLTextAreaElement>();
    render(
      <InlineChatReferenceInput
        ref={handle}
        references={references}
        onOpenReference={open}
        aria-label="Message"
        value={`A ${chatReferenceToken('sales')} B`}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reference Sales chat' }));
    expect(open).toHaveBeenCalledWith('sales');
    expect(handle.current!.selectionStart).toBe(2);
    expect(handle.current!.selectionEnd).toBe(2 + chatReferenceToken('sales').length);
  });
  it('pastes only plain text and keeps chat capabilities out of pasted HTML', () => {
    const handle = createRef<HTMLTextAreaElement>(),
      change = vi.fn();
    render(
      <InlineChatReferenceInput
        ref={handle}
        references={references}
        onOpenReference={() => {}}
        aria-label="Message"
        value={chatReferenceToken('sales')}
        onChange={change}
      />,
    );
    handle.current!.focus();
    handle.current!.setSelectionRange(0, 0);
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { getData: () => '<b>plain</b>', files: [] },
    });
    expect(handle.current!.value).toContain('<b>plain</b>');
    expect(screen.getByRole('textbox').querySelector('b')).toBeNull();
  });
});
