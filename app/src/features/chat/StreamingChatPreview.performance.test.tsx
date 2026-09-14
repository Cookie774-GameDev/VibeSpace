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
