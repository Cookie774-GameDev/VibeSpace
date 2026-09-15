import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamingChatPreview } from './StreamingChatPreview';
import { clearAccountPreviews, setPreview } from './streamingPreviewStore';
const { ledger } = vi.hoisted(() => ({ ledger: vi.fn(() => null) }));
vi.mock('./activity-ledger/AssistantActivityLedger', () => ({ AssistantActivityLedger: ledger }));
vi.mock('@/stores/auth', () => ({
  useAuthStore: (select: (value: unknown) => unknown) =>
    select({ localUserId: 'perf-user', cloudSession: null }),
}));
afterEach(() => {
  act(() => clearAccountPreviews('perf-user'));
  ledger.mockClear();
});

it('does not rebuild five unchanged tool cards during 100 prose-only deltas', () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({
    kind: 'tool' as const,
    id: `call-${i}`,
    name: 'vibespace_context',
    status: 'completed' as const,
    details: Object.freeze({ arguments: { operation: 'search' } }),
  }));
  const base = {
    accountId: 'perf-user',
    chatId: 'perf-chat',
    requestId: 'perf-request',
    runId: 'perf-run',
    text: '',
    updatedAt: 1,
    segments: tools,
  };
  setPreview(base);
  render(<StreamingChatPreview chatId="perf-chat" />);
  expect(ledger).toHaveBeenCalledTimes(5);
  for (let i = 0; i < 100; i++) {
    act(() =>
      setPreview({
        ...base,
        updatedAt: i + 2,
        text: `delta-${i}`,
        segments: [...tools, { kind: 'text', id: 'prose', text: `delta-${i}` }],
      }),
    );
  }
  expect(ledger).toHaveBeenCalledTimes(5);
  const changed = tools.map((tool, i) =>
    i === 2
      ? { ...tool, details: { ...tool.details, exitCode: 1 }, status: 'failed' as const }
      : tool,
  );
  act(() => setPreview({ ...base, segments: changed, updatedAt: 150 }));
  expect(ledger).toHaveBeenCalledTimes(6);
});

it('accounts for every coalesced publication instead of silently dropping it', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  const events: Array<Record<string, unknown>> = [];
  const unsubscribe = appActivityLog.subscribe((event) => {
    if (event.kind === 'ui.preview') events.push(event as unknown as Record<string, unknown>);
  });
  try {
    const base = {
      accountId: 'perf-user',
      chatId: 'perf-chat-coalesce',
      requestId: 'perf-request',
      runId: 'perf-run-coalesce',
      text: '',
      updatedAt: 1,
    };
    render(<StreamingChatPreview chatId="perf-chat-coalesce" />);
    act(() => {
      setPreview({ ...base, updatedAt: 2, text: 'delta-1' });
    });
    // Multiple synchronous publications coalesce into one React commit; the
    // skipped revisions must still be reported, never assigned zero latency.
    act(() => {
      setPreview({ ...base, updatedAt: 3, text: 'delta-2' });
      setPreview({ ...base, updatedAt: 4, text: 'delta-3' });
      setPreview({ ...base, updatedAt: 5, text: 'delta-4' });
    });
    const committed = events.filter((event) => event.phase === 'committed');
    expect(committed).toHaveLength(2);
    const data = committed[1].data as Record<string, unknown>;
    expect(data.coalescedRevisions).toBe(2);
    expect(typeof data.publicationRevision).toBe('number');
  } finally {
    unsubscribe();
  }
});

it('does not count another chat’s publications as missed updates for this chat', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  const events: Array<Record<string, unknown>> = [];
  const unsubscribe = appActivityLog.subscribe((event) => {
    if (event.kind === 'ui.preview') events.push(event as unknown as Record<string, unknown>);
  });
  try {
    render(<StreamingChatPreview chatId="chat-a" />);
    const a = {
      accountId: 'perf-user',
      chatId: 'chat-a',
      requestId: 'req-a',
      runId: 'run-a',
      text: '',
      updatedAt: 1,
    };
    const b = {
      accountId: 'perf-user',
      chatId: 'chat-b',
      requestId: 'req-b',
      runId: 'run-b',
      text: '',
      updatedAt: 1,
    };
    // A revision 1, three B publications, then A again: actual missed A = 0.
    act(() => setPreview({ ...a, updatedAt: 2, text: 'a1' }));
    act(() => {
      setPreview({ ...b, updatedAt: 2, text: 'b1' });
      setPreview({ ...b, updatedAt: 3, text: 'b2' });
      setPreview({ ...b, updatedAt: 4, text: 'b3' });
    });
    act(() => setPreview({ ...a, updatedAt: 3, text: 'a2' }));
    const aCommits = events.filter(
      (event) =>
        event.phase === 'committed' &&
        (event.data as Record<string, unknown> | undefined)?.chatId === 'chat-a',
    );
    expect(aCommits).toHaveLength(2);
    expect((aCommits[0].data as Record<string, unknown>).coalescedRevisions).toBe(0);
    expect((aCommits[1].data as Record<string, unknown>).coalescedRevisions).toBe(0);
  } finally {
    unsubscribe();
  }
});
