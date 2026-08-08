import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageBubble } from './MessageBubble';
import type { Message } from '@/types';
import { TooltipProvider } from '@/components/ui/tooltip';

afterEach(cleanup);

describe('MessageBubble compact pasted attachments', () => {
  it('renders a user-pasted image as a bracketed attachment with an on-demand preview', () => {
    const message = {
      id: 'message-image',
      chat_id: 'chat-image',
      role: 'user',
      created_at: 1,
      updated_at: 1,
      parts: [
        { kind: 'text', text: 'See this.' },
        { kind: 'image', url: 'data:image/png;base64,aGVsbG8=', alt: 'design.png' },
      ],
    } as Message;
    const rendered = render(
      <TooltipProvider>
        <MessageBubble message={message} />
      </TooltipProvider>,
    );

    expect(screen.getByText('[Image: design.png]')).toBeTruthy();
    expect(rendered.container.querySelector('details img[alt="design.png"]')).toBeTruthy();
  });
});
