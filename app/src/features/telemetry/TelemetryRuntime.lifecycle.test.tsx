import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { TelemetryRuntime } from './TelemetryRuntime';
import { createTelemetryWithdrawalQueue } from './telemetryWithdrawal';
import type { AccountTelemetryResult } from './accountTelemetryConsent';

const fixture = vi.hoisted(() => ({
  queue: undefined as unknown as ReturnType<typeof createTelemetryWithdrawalQueue>,
  stopExporter: vi.fn(),
  cloudClient: vi.fn(() => null),
}));
vi.mock('@/stores/auth', async () => {
  const { create } = await import('zustand');
  return {
    useAuthStore: create<{ cloudSession: { user_id: string } | null }>(() => ({
      cloudSession: null,
    })),
  };
});
vi.mock('./telemetryWithdrawal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./telemetryWithdrawal')>();
  return {
    ...actual,
    telemetryWithdrawalQueue: {
      getSnapshot: () => fixture.queue.getSnapshot(),
      flush: (...args: Parameters<typeof fixture.queue.flush>) => fixture.queue.flush(...args),
    },
  };
});
vi.mock('./optionalTelemetryRuntime', () => ({
  startOptionalTelemetryRuntime: () => fixture.stopExporter,
}));
vi.mock('@/lib/supabase/client', () => ({ getSupabaseClient: fixture.cloudClient }));
let fetchSpy: MockInstance<typeof fetch>;

const reconciled: AccountTelemetryResult = {
  ok: true,
  state: {
    enabled: false,
    eligible: false,
    policyVersion: 'test-policy',
    noticeUrl: 'https://example.test/notice',
    discountPercent: 10,
    requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
    withdrawal: { status: 'reconciled' },
  },
};
const setAccount = (id: string | null) => {
  useAuthStore.setState({ cloudSession: id ? ({ user_id: id } as never) : null });
};
function deferred() {
  let resolve!: (value: AccountTelemetryResult) => void;
  const promise = new Promise<AccountTelemetryResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const first = deferred();
  const dispatched: string[] = [];
  const values = new Map<string, string>();
  fixture.queue = createTelemetryWithdrawalQueue(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    async (account) => {
      dispatched.push(account);
      return account === 'a' ? first.promise : reconciled;
    },
  );
  fixture.queue.enqueue('a');
  fixture.queue.enqueue('b');
  setAccount('a');
  const view = render(<TelemetryRuntime />);
  expect(dispatched).toEqual(['a']);
  act(() => setAccount('b'));
  expect(dispatched).toEqual(['a']);
  return { first, dispatched, view };
}
beforeEach(() => {
  localStorage.clear();
  fixture.stopExporter.mockClear();
  fixture.cloudClient.mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  setAccount(null);
});
afterEach(() => {
  cleanup();
  setAccount(null);
  expect(fixture.cloudClient).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it('keeps a retired account withdrawal queued after logout while another account settles', async () => {
  const { first, dispatched } = setup();
  act(() => setAccount(null));
  await act(async () => {
    first.resolve(reconciled);
  });
  expect(dispatched).toEqual(['a']);
  expect(fixture.queue.getSnapshot().pending.map((row) => row.accountId)).toEqual(['b']);
});

it('keeps a queued withdrawal durable after its runtime unmounts', async () => {
  const { first, dispatched, view } = setup();
  view.unmount();
  await act(async () => {
    first.resolve(reconciled);
  });
  expect(dispatched).toEqual(['a']);
  expect(fixture.queue.getSnapshot().pending.map((row) => row.accountId)).toEqual(['b']);
});

it('dispatches the still-current account after the preceding withdrawal settles', async () => {
  const { first, dispatched } = setup();
  await act(async () => {
    first.resolve(reconciled);
  });
  expect(dispatched).toEqual(['a', 'b']);
  expect(fixture.queue.getSnapshot().pending).toEqual([]);
});

it('allows a fresh remount to retry the withdrawal retired by unmount', async () => {
  const { first, dispatched, view } = setup();
  view.unmount();
  await act(async () => {
    first.resolve(reconciled);
  });
  expect(dispatched).toEqual(['a']);
  render(<TelemetryRuntime />);
  await act(async () => {});
  expect(dispatched).toEqual(['a', 'b']);
  expect(fixture.queue.getSnapshot().pending).toEqual([]);
});

it('retires a queued retry across batched account ABA but allows a fresh online retry', async () => {
  const { first, dispatched } = setup();
  act(() => {
    setAccount('c');
    setAccount('b');
  });
  await act(async () => {
    first.resolve(reconciled);
  });
  expect(dispatched).toEqual(['a']);
  expect(fixture.queue.getSnapshot().pending.map((row) => row.accountId)).toEqual(['b']);
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
  expect(dispatched).toEqual(['a', 'b']);
  expect(fixture.queue.getSnapshot().pending).toEqual([]);
});
