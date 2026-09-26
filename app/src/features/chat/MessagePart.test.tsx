import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessagePart } from './MessagePart';
import type { Part } from '@/types/chat';

const receipt = (state: Extract<Part, { kind: 'codex_native_queue_receipt' }>['state']): Part => ({
  kind: 'codex_native_queue_receipt',
  version: 1,
  state,
  submissionId: 'private-submission',
  threadId: 'private-thread',
  addedDuringTurnId: 'private-turn',
  clientUserMessageId: 'private-message',
});

describe('native Codex queue receipt', () => {
  it('keeps accepted pending and review states visible without showing provider IDs', () => {
    const view = render(<MessagePart allParts={[]} part={receipt('pending')} />);
    expect(screen.getByRole('status').textContent).toContain('Queued on Codex');
    view.rerender(<MessagePart allParts={[]} part={receipt('review_required')} />);
    expect(screen.getByRole('status').textContent).toContain('needs review');
    expect(view.container.textContent).not.toContain('private-');
    view.rerender(<MessagePart allParts={[]} part={receipt('started')} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
