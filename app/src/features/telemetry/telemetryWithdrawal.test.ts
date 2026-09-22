import { beforeEach, expect, it, vi } from 'vitest';
import { createTelemetryWithdrawalQueue } from './telemetryWithdrawal';
import type { AccountTelemetryResult } from './accountTelemetryConsent';
const state = {
  enabled: false,
  eligible: false,
  policyVersion: 'v1',
  noticeUrl: 'https://example.test/notice',
  discountPercent: 10,
  requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
  withdrawal: { status: 'reconciled' },
} as const;
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
});
const storage = () => ({
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
});
it('persists an offline withdrawal across restart and retries only that account', async () => {
  const offline = vi.fn(
    async (): Promise<AccountTelemetryResult> => ({ ok: false, error: 'offline' }),
  );
  const first = createTelemetryWithdrawalQueue(storage(), offline);
  first.enqueue('a');
  await first.flush('a');
  const online = vi.fn(async (): Promise<AccountTelemetryResult> => ({ ok: true, state }));
  const restarted = createTelemetryWithdrawalQueue(storage(), online);
  expect(restarted.getSnapshot().pending).toHaveLength(1);
  await restarted.flush('b');
  expect(online).not.toHaveBeenCalled();
  await restarted.flush('a');
  expect(online).toHaveBeenCalledWith('a');
  expect(restarted.getSnapshot().pending).toHaveLength(0);
  expect(createTelemetryWithdrawalQueue(storage(), online).getSnapshot().pending).toHaveLength(0);
});
it('does not erase a newer withdrawal with an older response', async () => {
  let finish!: (result: AccountTelemetryResult) => void;
  const send = vi.fn(
    () =>
      new Promise<AccountTelemetryResult>((resolve) => {
        finish = resolve;
      }),
  );
  const queue = createTelemetryWithdrawalQueue(storage(), send);
  queue.enqueue('a');
  const work = queue.flush('a');
  queue.enqueue('a');
  finish({ ok: true, state });
  await work;
  expect(queue.getSnapshot().pending).toHaveLength(1);
});
it('keeps an unconfirmed withdrawal and deduplicates concurrent transport calls', async () => {
  const send = vi.fn(
    async (): Promise<AccountTelemetryResult> => ({ ok: true, state: { ...state, enabled: true } }),
  );
  const queue = createTelemetryWithdrawalQueue(storage(), send);
  queue.enqueue('a');
  await Promise.all([queue.flush('a'), queue.flush('a')]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(queue.getSnapshot().pending).toHaveLength(1);
  expect(queue.getSnapshot().error).toBe('withdrawal_not_confirmed');
});

it('keeps retrying after local sharing is off until billing reconciliation is confirmed', async () => {
  const send = vi.fn(
    async (): Promise<AccountTelemetryResult> => ({
      ok: true,
      state: { ...state, withdrawal: { status: 'pending', requestRevision: 'revision-1' } },
    }),
  );
  const queue = createTelemetryWithdrawalQueue(storage(), send);
  queue.enqueue('a');
  await queue.flush('a');
  expect(queue.getSnapshot().pending).toHaveLength(1);
  send.mockResolvedValueOnce({ ok: true, state });
  await queue.flush('a');
  expect(queue.getSnapshot().pending).toHaveLength(0);
});
it('serializes distinct accounts without returning another account result', async () => {
  const send = vi.fn(
    async (accountId: string): Promise<AccountTelemetryResult> => ({
      ok: true,
      state: { ...state, policyVersion: accountId },
    }),
  );
  const queue = createTelemetryWithdrawalQueue(storage(), send);
  queue.enqueue('a');
  queue.enqueue('b');
  const [a, b] = await Promise.all([queue.flush('a'), queue.flush('b')]);
  expect(a?.ok && a.state.policyVersion).toBe('a');
  expect(b?.ok && b.state.policyVersion).toBe('b');
  expect(queue.getSnapshot().pending).toHaveLength(0);
});
it('reports persistence failure while retaining the in-memory retry', () => {
  const queue = createTelemetryWithdrawalQueue(
    {
      ...storage(),
      setItem: () => {
        throw Error('quota');
      },
    },
    async () => ({ ok: true, state }),
  );
  expect(queue.enqueue('a')).toBe(true);
  expect(queue.getSnapshot().storageError).toBe(true);
  expect(queue.getSnapshot().pending).toHaveLength(1);
});
it('ignores corrupt queue data without making requests', async () => {
  values.set('vibespace-telemetry-withdrawals-v1', 'not json');
  const send = vi.fn(async (): Promise<AccountTelemetryResult> => ({ ok: true, state }));
  const queue = createTelemetryWithdrawalQueue(storage(), send);
  await queue.flush('a');
  expect(send).not.toHaveBeenCalled();
});
