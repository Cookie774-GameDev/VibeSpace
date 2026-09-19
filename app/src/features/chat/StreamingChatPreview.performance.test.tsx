import { act, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { classifyPreviewCommitTiming, StreamingChatPreview } from './StreamingChatPreview';
import { clearAccountPreviews, setPreview, subscribeChatPreviews } from './streamingPreviewStore';
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

it('reports reversed preview clock ordering instead of clamping it to zero', () => {
  expect(classifyPreviewCommitTiming(10, 15)).toEqual({ uiCommitMs: 5 });
  expect(classifyPreviewCommitTiming(15, 10)).toEqual({ resultCode: 'clock_order_invalid' });
});

it('renders public text when a legacy producer also supplies only tool segments', () => {
  setPreview({
    accountId: 'perf-user',
    chatId: 'text-with-tool',
    requestId: 'r-public',
    runId: 'run-public',
    text: 'START_P4F8',
    updatedAt: 1,
    segments: [{ kind: 'tool', id: 'call-public', name: 'read', status: 'started' }],
  });
  const view = render(<StreamingChatPreview chatId="text-with-tool" />);
  expect(view.getByText('START_P4F8')).toBeTruthy();
  expect(ledger).toHaveBeenCalledTimes(1);
});

it('does not duplicate public prose already present in ordered segments', () => {
  setPreview({
    accountId: 'perf-user',
    chatId: 'text-once',
    requestId: 'r-once',
    runId: 'run-once',
    text: 'START_ONCE',
    updatedAt: 1,
    segments: [
      { kind: 'text', id: 'part-once', text: 'START_ONCE' },
      { kind: 'tool', id: 'call-once', name: 'read', status: 'started' },
    ],
  });
  const view = render(<StreamingChatPreview chatId="text-once" />);
  expect(view.getAllByText('START_ONCE')).toHaveLength(1);
});

it('makes the latest public text visible before ordinary store subscribers run', () => {
  const view = render(<StreamingChatPreview chatId="fast-visible" fallback={<div>Waiting</div>} />);
  const observations: string[] = [];
  const stop = subscribeChatPreviews('perf-user', 'fast-visible', () => {
    observations.push(
      view.container.querySelector('[data-streaming-fast-preview-tail="true"]')?.textContent ?? '',
    );
  });
  try {
    act(() =>
      setPreview({
        accountId: 'perf-user',
        chatId: 'fast-visible',
        requestId: 'fast-request',
        runId: 'fast-run',
        text: 'VISIBLE_BEFORE_REACT',
        updatedAt: 1,
        segments: [{ kind: 'text', id: 'fast-text', text: 'VISIBLE_BEFORE_REACT' }],
      }),
    );
    expect(observations).toEqual(['VISIBLE_BEFORE_REACT']);
    const host = view.container.querySelector('[data-streaming-fast-preview-tail="true"]');
    expect(host?.textContent).toBe('VISIBLE_BEFORE_REACT');
    expect(Number(host?.getAttribute('data-preview-fast-commit-ms'))).toBeGreaterThanOrEqual(0);
  } finally {
    stop();
  }
});

it('records the first fast visible commit once per run after visibility is committed', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  const rows: Array<Record<string, unknown>> = [];
  const stop = appActivityLog.subscribe((event) => {
    if (event.kind !== 'ui.preview.fast') return;
    const data = event.data as Record<string, unknown>;
    if (data.chatId === 'fast-diagnostic') rows.push(data);
  });
  try {
    render(<StreamingChatPreview chatId="fast-diagnostic" />);
    act(() => {
      setPreview({
        accountId: 'perf-user',
        chatId: 'fast-diagnostic',
        requestId: 'fast-diag-request',
        runId: 'fast-diag-run',
        text: 'FIRST',
        updatedAt: 1,
        segments: [{ kind: 'text', id: 'fast-diag-text', text: 'FIRST' }],
      });
      setPreview({
        accountId: 'perf-user',
        chatId: 'fast-diagnostic',
        requestId: 'fast-diag-request',
        runId: 'fast-diag-run',
        text: 'SECOND',
        updatedAt: 2,
        segments: [{ kind: 'text', id: 'fast-diag-text', text: 'SECOND' }],
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: 'fast-diag-request',
      runId: 'fast-diag-run',
    });
    expect(typeof rows[0]?.uiCommitMs).toBe('number');
  } finally {
    stop();
  }
});

it('reports skipped initial publications instead of treating the first commit as lossless', async () => {
  const { appActivityLog } = await import('@/lib/diagnostics/appActivityLog');
  const rows: Array<Record<string, unknown>> = [];
  const stop = appActivityLog.subscribe((event) => {
    const data = event.data;
    if (event.kind === 'ui.preview' && data && typeof data === 'object' && !Array.isArray(data)) {
      const row = data as Record<string, unknown>;
      if (row.chatId === 'initial-coalesce') rows.push(row);
    }
  });
  try {
    render(<StreamingChatPreview chatId="initial-coalesce" />);
    act(() => {
      for (let i = 1; i <= 3; i += 1)
        setPreview({
          accountId: 'perf-user',
          chatId: 'initial-coalesce',
          requestId: 'r-initial',
          runId: 'run-initial',
          text: `Public ${i}`,
          updatedAt: i,
        });
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.coalescedRevisions).toBe(2);
  } finally {
    stop();
  }
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
