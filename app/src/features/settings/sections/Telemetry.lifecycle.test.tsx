import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AccountTelemetryConsent,
  AccountTelemetryResult,
} from '@/features/telemetry/accountTelemetryConsent';
import { telemetryConsentStore } from '@/features/telemetry/telemetryConsent';
import { Telemetry } from './Telemetry';

const fixture = vi.hoisted(() => ({
  account: { cloudSession: { user_id: 'a' } as { user_id: string } | null },
  states: {} as Record<string, AccountTelemetryConsent>,
  read: vi.fn(),
  update: vi.fn(),
  enqueue: vi.fn(),
  flush: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  withdrawal: {
    pending: [] as { accountId: string; revision: string }[],
    storageError: false,
    error: null,
  },
  listeners: new Set<() => void>(),
  exporter: { enabled: false, queued: 0, acknowledged: 0, sending: false, storageError: false },
}));
vi.mock('@/stores/auth', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof fixture.account) => unknown) => selector(fixture.account),
    {
      getState: () => fixture.account,
    },
  ),
}));
vi.mock('@/features/telemetry/accountTelemetryConsent', () => ({
  getAccountTelemetryConsent: fixture.read,
  updateAccountTelemetryConsent: fixture.update,
}));
vi.mock('@/features/telemetry/telemetryWithdrawal', () => ({
  telemetryWithdrawalQueue: {
    getSnapshot: () => fixture.withdrawal,
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    enqueue: fixture.enqueue,
    flush: fixture.flush,
  },
}));
vi.mock('@/features/telemetry/optionalTelemetryRuntime', () => ({
  optionalTelemetryExporter: { getSnapshot: () => fixture.exporter, subscribe: () => () => {} },
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: fixture.success, error: fixture.error },
}));

function consent(policy: string, enabled = false): AccountTelemetryConsent {
  return {
    enabled,
    eligible: enabled,
    policyVersion: policy,
    noticeUrl: `https://example.test/${policy}`,
    discountPercent: 10,
    requiredDataClasses: ['product_usage', 'diagnostics', 'tool_outcomes'],
  };
}
function deferred() {
  let resolve!: (result: AccountTelemetryResult | undefined) => void;
  const promise = new Promise<AccountTelemetryResult | undefined>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
const notice = () =>
  screen.getByRole('link', { name: 'Read the financial-incentive and telemetry notice' });
async function showAccount(
  view: ReturnType<typeof render>,
  id: string,
  state: AccountTelemetryConsent,
) {
  fixture.account.cloudSession = { user_id: id };
  fixture.states[id] = state;
  view.rerender(<Telemetry />);
  await waitFor(() => expect(notice()).toHaveProperty('href', state.noticeUrl));
}

beforeEach(() => {
  localStorage.clear();
  telemetryConsentStore.resetForTests();
  telemetryConsentStore.updateConsent({
    productUsage: true,
    diagnostics: true,
    toolOutcomes: true,
  });
  fixture.account.cloudSession = { user_id: 'a' };
  fixture.states = { a: consent('a-initial'), b: consent('b-current') };
  fixture.withdrawal = { pending: [], storageError: false, error: null };
  fixture.listeners.clear();
  fixture.read
    .mockReset()
    .mockImplementation(async (id: string) => ({ ok: true, state: fixture.states[id] }));
  fixture.update.mockReset();
  fixture.flush.mockReset().mockResolvedValue({ ok: false, error: 'offline' });
  fixture.enqueue.mockReset().mockImplementation((accountId: string) => {
    fixture.withdrawal = {
      ...fixture.withdrawal,
      pending: [{ accountId, revision: 'synthetic-withdrawal' }],
    };
    fixture.listeners.forEach((listener) => listener());
    return true;
  });
  fixture.success.mockReset();
  fixture.error.mockReset();
});
afterEach(() => cleanup());

describe('Telemetry account and mutation lifetimes', () => {
  it.each(['success', 'failure'] as const)(
    'ignores an old enrollment %s after account A-to-B-to-A',
    async (outcome) => {
      const old = deferred();
      fixture.update.mockReturnValue(old.promise);
      const view = render(<Telemetry />);
      fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
      expect(fixture.update).toHaveBeenCalledWith(true, fixture.states.a, 'a');
      await showAccount(view, 'b', consent('b-current'));
      const current = consent('a-new-policy');
      await showAccount(view, 'a', current);
      await act(async () => {
        old.resolve(
          outcome === 'success'
            ? { ok: true, state: consent('a-initial', true) }
            : { ok: false, error: 'stale_error' },
        );
        await old.promise;
      });
      expect(notice()).toHaveProperty('href', current.noticeUrl);
      expect(screen.queryByRole('button', { name: 'Withdraw 10% reward consent' })).toBeNull();
      expect(screen.queryByText(/stale_error/)).toBeNull();
      expect(fixture.success).not.toHaveBeenCalled();
      expect(fixture.error).not.toHaveBeenCalled();
    },
  );

  it('lets a new account enroll and prevents an older result clearing its busy state', async () => {
    const first = deferred();
    const second = deferred();
    fixture.update.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
    await showAccount(view, 'b', consent('b-current'));
    const button = screen.getByRole('button', { name: 'Enable 10% reward' });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);
    expect(fixture.update).toHaveBeenCalledTimes(2);
    expect(button).toHaveProperty('disabled', true);
    await act(async () => {
      first.resolve({ ok: true, state: consent('a-initial', true) });
      await first.promise;
    });
    expect(button).toHaveProperty('disabled', true);
    expect(fixture.success).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve({ ok: true, state: consent('b-current', true) });
      await second.promise;
    });
    expect(screen.getByRole('button', { name: 'Withdraw 10% reward consent' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(fixture.success).toHaveBeenCalledTimes(1);
  });

  it('does not apply an old withdrawal response after account A-to-B-to-A', async () => {
    fixture.states.a = consent('a-initial', true);
    const old = deferred();
    fixture.flush.mockReturnValue(old.promise);
    const view = render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw 10% reward consent' }));
    expect(telemetryConsentStore.getSnapshot().consent).toEqual({
      productUsage: false,
      diagnostics: false,
      toolOutcomes: false,
    });
    await showAccount(view, 'b', consent('b-current'));
    const current = consent('a-new-policy');
    await showAccount(view, 'a', current);
    await act(async () => {
      old.resolve({
        ok: true,
        state: { ...consent('a-initial'), withdrawal: { status: 'pending' } },
      });
      await old.promise;
    });
    expect(notice()).toHaveProperty('href', current.noticeUrl);
    expect(fixture.withdrawal.pending[0].accountId).toBe('a');
  });

  it('does not notify from an old mount after the same account has reopened Settings', async () => {
    const old = deferred();
    fixture.update.mockReturnValue(old.promise);
    const first = render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
    first.unmount();
    fixture.states.a = consent('a-reopened');
    render(<Telemetry />);
    await screen.findByRole('button', { name: 'Enable 10% reward' });
    await act(async () => {
      old.resolve({ ok: true, state: consent('a-initial', true) });
      await old.promise;
    });
    expect(notice()).toHaveProperty('href', fixture.states.a.noticeUrl);
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it('retains withdrawal compensation when consent is revoked during enrollment', async () => {
    const pending = deferred();
    fixture.update.mockReturnValue(pending.promise);
    render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke optional telemetry' }));
    const enqueued = fixture.enqueue.mock.calls.length;
    await act(async () => {
      pending.resolve({ ok: true, state: consent('a-initial', true) });
      await pending.promise;
    });
    expect(telemetryConsentStore.getSnapshot().consent).toEqual({
      productUsage: false,
      diagnostics: false,
      toolOutcomes: false,
    });
    expect(fixture.enqueue.mock.calls.length).toBeGreaterThan(enqueued);
    expect(fixture.flush).toHaveBeenCalledWith('a');
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it('does not replace a newer same-account withdrawal after local classes are re-enabled', async () => {
    const old = deferred();
    fixture.update.mockReturnValue(old.promise);
    const withdrawn = consent('a-after-withdrawal');
    fixture.flush.mockResolvedValue({ ok: true, state: withdrawn });
    render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke optional telemetry' }));
    await waitFor(() => expect(notice()).toHaveProperty('href', withdrawn.noticeUrl));
    act(() =>
      telemetryConsentStore.updateConsent({
        productUsage: true,
        diagnostics: true,
        toolOutcomes: true,
      }),
    );
    await act(async () => {
      old.resolve({ ok: true, state: consent('a-initial', true) });
      await old.promise;
    });
    expect(notice()).toHaveProperty('href', withdrawn.noticeUrl);
    expect(screen.queryByRole('button', { name: 'Withdraw 10% reward consent' })).toBeNull();
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it('shows the current request failure and releases its own busy state', async () => {
    fixture.update.mockResolvedValue({ ok: false, error: 'current_request_failed' });
    render(<Telemetry />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable 10% reward' }));
    await screen.findByText(/current_request_failed/);
    expect(screen.getByRole('button', { name: 'Enable 10% reward' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(fixture.error).toHaveBeenCalledExactlyOnceWith(
      'Could not update reward consent',
      'current_request_failed',
    );
    expect(fixture.success).not.toHaveBeenCalled();
  });
});
