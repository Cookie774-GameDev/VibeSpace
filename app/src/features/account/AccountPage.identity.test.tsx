import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CombinedUsage } from '@/features/billing/planLimits';

const mocks = vi.hoisted(() => ({
  callCheckoutSession: vi.fn(),
  callCustomerPortal: vi.fn(),
  getCombinedUsage: vi.fn(),
  openExternal: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/features/settings/sections/Account', () => ({
  Account: () => <div>Account profile</div>,
}));

vi.mock('@/features/pets/PetAccountPanel', () => ({
  PetAccountPanel: () => <div>Pet account</div>,
}));

vi.mock('@/lib/admin', () => ({
  useAppAdmin: () => false,
}));

vi.mock('@/lib/billing/checkout', () => ({
  callCheckoutSession: mocks.callCheckoutSession,
  callCustomerPortal: mocks.callCustomerPortal,
  isBackendBillingConfigured: () => true,
}));

vi.mock('@/features/billing/planLimits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/billing/planLimits')>();
  return {
    ...actual,
    getCombinedUsage: mocks.getCombinedUsage,
  };
});

vi.mock('@/lib/tauri', () => ({
  openExternal: mocks.openExternal,
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { AccountPage } from './AccountPage';
import { useAuthStore } from '@/stores/auth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function usage(plan: CombinedUsage['plan'], included: number, used: number): CombinedUsage {
  const bucket = {
    included: 0,
    used: 0,
    remaining: 0,
    remaining_now: 0,
    window_5h_remaining: 0,
    window_weekly_remaining: 0,
    available: false,
  };
  return {
    plan,
    admin_unlimited: false,
    reset_date: null,
    message: bucket,
    call: bucket,
    sms: bucket,
    credits_included: included,
    credits_used: used,
    credits_remaining: included - used,
  };
}

function setAccount(userId: string) {
  useAuthStore.setState({
    cloudSession: {
      user_id: userId,
      email: `${userId}@example.test`,
      expires_at: 2_000_000_000,
    },
    plan: 'free',
  });
}

describe('AccountPage account ownership', () => {
  beforeEach(() => {
    mocks.callCheckoutSession.mockReset();
    mocks.callCustomerPortal.mockReset();
    mocks.getCombinedUsage.mockReset();
    mocks.openExternal.mockReset();
    mocks.toastError.mockReset();
    useAuthStore.setState({ cloudSession: null, plan: 'free' });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('clears Account A usage immediately and ignores its delayed result after switching to B', async () => {
    window.history.replaceState({}, '', '/?tab=usage');
    const accountA = deferred<CombinedUsage | null>();
    const accountB = deferred<CombinedUsage | null>();
    let accountACalls = 0;
    mocks.getCombinedUsage.mockImplementation(() => {
      if (useAuthStore.getState().cloudSession?.user_id !== 'account-a') {
        return accountB.promise;
      }
      accountACalls += 1;
      return accountACalls <= 2 ? Promise.resolve(usage('starter', 100, 25)) : accountA.promise;
    });
    setAccount('account-a');
    render(<AccountPage />);

    expect(
      (
        await screen.findByRole('progressbar', { name: 'Shared company credit usage' })
      ).getAttribute('aria-valuenow'),
    ).toBe('25');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    act(() => setAccount('account-b'));
    expect(screen.queryByRole('progressbar', { name: 'Shared company credit usage' })).toBeNull();
    expect(screen.getByText('Loading usage…')).toBeTruthy();

    await act(async () => accountA.resolve(usage('starter', 100, 25)));
    expect(screen.queryByRole('progressbar', { name: 'Shared company credit usage' })).toBeNull();

    await act(async () => accountB.resolve(usage('pro', 200, 40)));
    expect(
      (
        await screen.findByRole('progressbar', { name: 'Shared company credit usage' })
      ).getAttribute('aria-valuenow'),
    ).toBe('20');
  });

  it.each([
    {
      label: 'Manage subscription',
      invoke: () => mocks.callCustomerPortal,
      result: { ok: true as const, url: 'https://billing.example.test/portal-a' },
    },
    {
      label: 'Choose Orbit',
      invoke: () => mocks.callCheckoutSession,
      result: { ok: true as const, url: 'https://billing.example.test/checkout-a' },
    },
  ])('does not open or toast a delayed $label result after A switches to B', async (entry) => {
    window.history.replaceState({}, '', '/?tab=billing');
    mocks.getCombinedUsage.mockResolvedValue(null);
    const pending = deferred<typeof entry.result>();
    entry.invoke().mockReturnValue(pending.promise);
    setAccount('account-a');
    render(<AccountPage />);

    fireEvent.click(await screen.findByRole('button', { name: entry.label }));
    act(() => setAccount('account-b'));
    await act(async () => pending.resolve(entry.result));

    await waitFor(() => expect(mocks.openExternal).not.toHaveBeenCalled());
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
