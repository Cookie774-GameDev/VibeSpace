import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamingChatPreview } from './StreamingChatPreview';
import { clearAccountPreviews, clearPreview, setPreview } from './streamingPreviewStore';
vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ localUserId: 'preview-user', cloudSession: null }),
}));
afterEach(() => {
  act(() => {
    clearAccountPreviews('preview-user');
    clearAccountPreviews('other-user');
  });
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


it('renders actual public tool details during a tool-only live turn', () => {
  const { container } = render(<StreamingChatPreview chatId="chat-a" />);
  act(() => setPreview({ accountId: 'preview-user', chatId: 'chat-a', runId: 'detail-run', requestId: 'detail-request',
    updatedAt: 10, text: '', segments: [{ kind: 'tool', id: 'detail-call', name: 'command', status: 'completed',
      details: { command: 'node verify.cjs', arguments: { command: 'node verify.cjs' }, exitCode: 0,
        output: { text: '16 checks passed', mode: 'replace', complete: true, omittedBytes: 0 },
        changes: [{ path: 'invoice.cjs', kind: 'update', diff: '-return null\n+return rows', complete: true }] } }] }));
  fireEvent.click(screen.getByRole('button', { name: /Show activity details/ }));
  expect(container.textContent).toContain('node verify.cjs');
  expect(container.textContent).toContain('16 checks passed');
  fireEvent.click(screen.getByRole('button', { name: /Edited files/ }));
  expect(container.textContent).toContain('-return null');
  expect(container.textContent).toContain('+return rows');
});

it('records correlated publication-to-commit duration, not model or paint latency', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  const before = appActivityLog.snapshot().sequence;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    setPreview({ accountId: 'preview-user', chatId: 'timing-chat', runId: 'timing-run',
      requestId: 'timing-request', updatedAt: 5, text: 'Diagnostic timing text' });
    clock.mockReturnValue(104);
    const { rerender } = render(<StreamingChatPreview chatId="timing-chat" />);
    const rows = () => appActivityLog.snapshot(before).events.filter(row => row.kind === 'ui.preview');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ phase: 'committed', durationMs: 4,
      data: { requestId: 'timing-request', chatId: 'timing-chat', uiCommitMs: 4 } });
    expect(JSON.stringify(rows())).not.toContain('Diagnostic timing text');
    rerender(<StreamingChatPreview chatId="timing-chat" />);
    expect(rows()).toHaveLength(1);
  } finally { clock.mockRestore(); }
});
