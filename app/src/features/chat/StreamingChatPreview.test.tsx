import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamingChatPreview } from './StreamingChatPreview';
import { clearAccountPreviews, clearPreview, setPreview } from './streamingPreviewStore';
vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ localUserId: 'preview-user', cloudSession: null }),
}));
afterEach(() => {
  clearAccountPreviews('preview-user');
  clearAccountPreviews('other-user');
});
it('renders each public checkpoint before completion and removes it when committed', () => {
  render(<StreamingChatPreview chatId="chat-a" />);
  const base = {
    accountId: 'preview-user',
    chatId: 'chat-a',
    runId: 'run-a',
    requestId: 'request-a',
    updatedAt: 1,
  };
  act(() => setPreview({ ...base, text: 'I am reading the file.' }));
  expect(screen.getByText('I am reading the file.')).toBeTruthy();
  act(() =>
    setPreview({ ...base, updatedAt: 2, text: 'I am reading the file. I found the issue.' }),
  );
  expect(screen.getByText(/I found the issue/)).toBeTruthy();
  act(() => clearPreview('preview-user', 'run-a'));
  expect(screen.queryByText(/I found the issue/)).toBeNull();
});
it('never renders another account or chat preview', () => {
  act(() => {
    setPreview({
      accountId: 'other-user',
      chatId: 'chat-a',
      runId: 'run-b',
      requestId: 'b',
      updatedAt: 3,
      text: 'Private other account.',
    });
    setPreview({
      accountId: 'preview-user',
      chatId: 'chat-b',
      runId: 'run-c',
      requestId: 'c',
      updatedAt: 4,
      text: 'Private other chat.',
    });
  });
  const { container } = render(<StreamingChatPreview chatId="chat-a" />);
  expect(container.textContent).toBe('');
});

it('interleaves live checkpoints with their native tool receipts', () => {
  const { container } = render(<StreamingChatPreview chatId="chat-a" fallback={<div>Aggregate fallback</div>} />);
  act(() => setPreview({ accountId: 'preview-user', chatId: 'chat-a', runId: 'ordered', requestId: 'request',
    updatedAt: 1, text: 'First checkpoint. Second checkpoint.', segments: [
      { kind: 'text', id: 'one', text: 'First checkpoint.' },
      { kind: 'tool', id: 'read', name: 'read', status: 'completed', fileLabel: 'game.ts' },
      { kind: 'text', id: 'two', text: 'Second checkpoint.' },
    ] }));
  const preview = container.querySelector('[data-streaming-chat-preview]')!;
  expect(preview.children[0].textContent).toContain('First checkpoint.');
  expect(preview.children[1].textContent).toMatch(/action|read/i);
  expect(preview.children[2].textContent).toContain('Second checkpoint.');
  expect(screen.queryByText('Aggregate fallback')).toBeNull();
});
