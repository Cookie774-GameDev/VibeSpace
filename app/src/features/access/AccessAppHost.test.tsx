import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AccessViewModel } from './accessViewModel';
import {
  AccessAppHost,
  isAccessGateEnabled,
  isInstalledTransportUnavailable,
  type AccessAppRuntime,
  type AccessAppHostProps,
} from './AccessAppHost';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function viewModel(overrides: Partial<AccessViewModel> = {}): AccessViewModel {
  const displayState = overrides.displayState ?? 'active';
  const usable = overrides.usable ?? true;
  const featureTier = overrides.featureTier ?? 'free';
  const capturedAt = overrides.capturedAt ?? 1_785_000_000_000;
  return {
    state: overrides.state ?? 'active',
    displayState,
    usable,
    locked: overrides.locked ?? false,
    failClosed: overrides.failClosed ?? false,
    checkoutNeeded: overrides.checkoutNeeded ?? false,
    capabilities: {
      use: usable,
      mutation: usable,
      ai: usable,
      terminals: usable,
      tools: usable,
      calls: usable,
      scheduling: usable,
      account: true,
      billing: true,
      legal: true,
      localRead: true,
      export: true,
      backup: true,
    },
    warning: null,
    featurePlan: { active: featureTier !== 'free', manageable: true },
    featureTier,
    capturedAt,
    trialDaysRemaining: null,
    graceDaysRemaining: null,
    trialEndsAt: null,
    paidThroughDate: null,
    graceEndsAt: null,
    host: { displayState, featureTier, usable, capturedAt },
    banner: { visible: false, displayState },
    paywall: { visible: !usable, displayState, featureTier },
    ...overrides,
  };
}

function runtime(overrides: Partial<AccessAppRuntime> = {}): AccessAppRuntime {
  return {
    loadViewModel: vi.fn(async () => viewModel()),
    createCheckoutUrl: vi.fn(async () => 'https://billing.example.test/checkout'),
    createPortalUrl: vi.fn(async () => 'https://billing.example.test/portal'),
    openExternalUrl: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    backupLocalData: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderHost(hostRuntime: AccessAppRuntime, overrides: Partial<AccessAppHostProps> = {}) {
  return render(
    <AccessAppHost enabled runtime={hostRuntime} {...overrides}>
      <p>Protected workspace</p>
    </AccessAppHost>,
  );
}

describe('isAccessGateEnabled', () => {
  it('fails closed for production builds even without explicit enablement', () => {
    expect(isAccessGateEnabled({ PROD: true })).toBe(true);
    expect(isAccessGateEnabled({ PROD: false, MODE: 'production' })).toBe(true);
    expect(isAccessGateEnabled({ PROD: true, VITE_ACCESS_GATE_ENABLED: 'false' })).toBe(true);
  });

  it('keeps development disabled by default and honors explicit opt-in', () => {
    expect(isAccessGateEnabled({ PROD: false })).toBe(false);
    expect(isAccessGateEnabled({ PROD: false, VITE_ACCESS_GATE_ENABLED: 'false' })).toBe(false);
    expect(isAccessGateEnabled({ PROD: false, VITE_ACCESS_GATE_ENABLED: ' true ' })).toBe(true);
  });
});

describe('installed Access transport classification', () => {
  it('permits offline fallback only for definitive network transport failures', () => {
    expect(isInstalledTransportUnavailable(new TypeError('Failed to fetch'))).toBe(true);
    expect(
      isInstalledTransportUnavailable({
        code: '',
        message: 'TypeError: Failed to fetch',
        details: 'TypeError: Failed to fetch',
      }),
    ).toBe(true);
    expect(isInstalledTransportUnavailable(new Error('permission denied'))).toBe(false);
    expect(isInstalledTransportUnavailable({ code: '42501', message: 'permission denied' })).toBe(
      false,
    );
    expect(isInstalledTransportUnavailable(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });
});

describe('AccessAppHost', () => {
  it('does not load access or alter children while the explicit gate is disabled', () => {
    const hostRuntime = runtime();

    renderHost(hostRuntime, { enabled: false });

    expect(screen.getByText('Protected workspace')).toBeTruthy();
    expect(hostRuntime.loadViewModel).not.toHaveBeenCalled();
  });

  it('shows no protected workspace until an enabled authoritative decision resolves', async () => {
    const pending = deferred<AccessViewModel>();
    const hostRuntime = runtime({ loadViewModel: vi.fn(() => pending.promise) });

    renderHost(hostRuntime);

    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(screen.getByRole('heading', { name: 'VibeSpace Access' })).toBeTruthy();

    await act(async () => pending.resolve(viewModel()));

    expect(screen.getByText('Protected workspace')).toBeTruthy();
  });

  it('keeps a locked feature-tier account blocked with export recovery available', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
          featureTier: 'apex',
        }),
      ),
    });

    renderHost(hostRuntime);

    expect(await screen.findByText(/access is locked/i)).toBeTruthy();
    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(document.body.textContent).toMatch(/apex feature plan does not include app access/i);

    fireEvent.click(screen.getByRole('button', { name: /export|backup/i }));
    await act(async () => undefined);
    expect(hostRuntime.backupLocalData).toHaveBeenCalledTimes(1);
  });

  it('reports a completed locked-mode backup without unlocking or hiding billing', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
        }),
      ),
    });

    renderHost(hostRuntime);
    await screen.findByText(/access is locked/i);

    fireEvent.click(screen.getByRole('button', { name: /export|backup/i }));

    expect((await screen.findByRole('status')).textContent).toMatch(/backup file was created/i);
    expect(screen.queryByText('Protected workspace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await act(async () => undefined);
    expect(hostRuntime.openExternalUrl).toHaveBeenCalledWith('https://billing.example.test/portal');
    expect(hostRuntime.loadViewModel).toHaveBeenCalledTimes(1);
  });

  it('reports backup artifact failure while keeping the locked recovery screen available', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
        }),
      ),
      backupLocalData: vi.fn(async () => {
        throw new Error('artifact unavailable');
      }),
    });

    renderHost(hostRuntime);
    fireEvent.click(await screen.findByRole('button', { name: /export|backup/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /local data could not be backed up/i,
    );
    expect(screen.getByRole('button', { name: /manage billing/i })).toBeTruthy();
    expect(screen.queryByText('artifact unavailable')).toBeNull();
    expect(screen.queryByText('Protected workspace')).toBeNull();
  });

  it('opens only the gateway-issued checkout and portal URLs', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
        }),
      ),
    });

    renderHost(hostRuntime);
    await screen.findByText(/access is locked/i);

    fireEvent.click(screen.getByRole('button', { name: /subscribe to vibespace access/i }));
    await act(async () => undefined);
    expect(hostRuntime.openExternalUrl).toHaveBeenCalledWith(
      'https://billing.example.test/checkout',
    );

    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    await act(async () => undefined);
    expect(hostRuntime.openExternalUrl).toHaveBeenCalledWith('https://billing.example.test/portal');
  });

  it('does not open a delayed former-account checkout URL after keyed replacement', async () => {
    const pending = deferred<string>();
    const accountA = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
        }),
      ),
      createCheckoutUrl: vi.fn(() => pending.promise),
    });
    const accountB = runtime();
    const view = render(
      <AccessAppHost key="account-a" enabled runtime={accountA}>
        <p>Account A workspace</p>
      </AccessAppHost>,
    );
    await screen.findByText(/access is locked/i);

    fireEvent.click(screen.getByRole('button', { name: /subscribe to vibespace access/i }));
    const signal = vi.mocked(accountA.createCheckoutUrl).mock.calls[0]?.[0];
    view.rerender(
      <AccessAppHost key="account-b" enabled runtime={accountB}>
        <p>Account B workspace</p>
      </AccessAppHost>,
    );

    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve('https://billing.example.test/former-checkout'));
    expect(accountA.openExternalUrl).not.toHaveBeenCalled();
    expect(accountB.openExternalUrl).not.toHaveBeenCalled();
  });

  it('does not open a delayed former-account portal URL after keyed replacement', async () => {
    const pending = deferred<string>();
    const accountA = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
        }),
      ),
      createPortalUrl: vi.fn(() => pending.promise),
    });
    const accountB = runtime();
    const view = render(
      <AccessAppHost key="account-a" enabled runtime={accountA}>
        <p>Account A workspace</p>
      </AccessAppHost>,
    );
    await screen.findByText(/access is locked/i);

    fireEvent.click(screen.getByRole('button', { name: /manage billing/i }));
    const signal = vi.mocked(accountA.createPortalUrl).mock.calls[0]?.[0];
    view.rerender(
      <AccessAppHost key="account-b" enabled runtime={accountB}>
        <p>Account B workspace</p>
      </AccessAppHost>,
    );

    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve('https://billing.example.test/former-portal'));
    expect(accountA.openExternalUrl).not.toHaveBeenCalled();
    expect(accountB.openExternalUrl).not.toHaveBeenCalled();
  });

  it('does not publish a delayed former-account billing error after keyed replacement', async () => {
    const pending = deferred<string>();
    const accountA = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
        }),
      ),
      createCheckoutUrl: vi.fn(() => pending.promise),
    });
    const accountB = runtime();
    const view = render(
      <AccessAppHost key="account-a" enabled runtime={accountA}>
        <p>Account A workspace</p>
      </AccessAppHost>,
    );
    await screen.findByText(/access is locked/i);

    fireEvent.click(screen.getByRole('button', { name: /subscribe to vibespace access/i }));
    view.rerender(
      <AccessAppHost key="account-b" enabled runtime={accountB}>
        <p>Account B workspace</p>
      </AccessAppHost>,
    );
    await act(async () => pending.reject(new Error('former-account-secret-detail')));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/former-account-secret-detail/i)).toBeNull();
  });

  it('restores access only after a fresh authoritative check', async () => {
    const hostRuntime = runtime();
    vi.mocked(hostRuntime.loadViewModel)
      .mockResolvedValueOnce(
        viewModel({
          state: 'locked',
          displayState: 'locked',
          usable: false,
          locked: true,
          checkoutNeeded: true,
        }),
      )
      .mockResolvedValueOnce(viewModel());

    renderHost(hostRuntime);
    await screen.findByText(/access is locked/i);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /restore|check access/i }));
    });

    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(hostRuntime.loadViewModel).toHaveBeenCalledTimes(2);
  });

  it('signs out through the runtime and then rechecks access', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'unknown',
          displayState: 'unknown',
          usable: false,
          failClosed: true,
        }),
      ),
    });

    renderHost(hostRuntime);
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));
    await act(async () => undefined);

    expect(hostRuntime.signOut).toHaveBeenCalledTimes(1);
    expect(hostRuntime.loadViewModel).toHaveBeenCalledTimes(2);
  });

  it('opens configured legal URLs and reports missing configuration accessibly', async () => {
    const hostRuntime = runtime({
      loadViewModel: vi.fn(async () =>
        viewModel({
          state: 'unknown',
          displayState: 'unknown',
          usable: false,
          failClosed: true,
        }),
      ),
    });

    const view = renderHost(hostRuntime, {
      privacyUrl: 'https://legal.example.test/privacy',
      termsUrl: 'https://legal.example.test/terms',
    });
    await screen.findByText(/unable to determine your access status/i);

    fireEvent.click(screen.getByRole('button', { name: /privacy/i }));
    fireEvent.click(screen.getByRole('button', { name: /terms/i }));
    await act(async () => undefined);
    expect(hostRuntime.openExternalUrl).toHaveBeenCalledWith('https://legal.example.test/privacy');
    expect(hostRuntime.openExternalUrl).toHaveBeenCalledWith('https://legal.example.test/terms');

    view.rerender(
      <AccessAppHost enabled runtime={hostRuntime}>
        <p>Protected workspace</p>
      </AccessAppHost>,
    );
    fireEvent.click(screen.getByRole('button', { name: /privacy/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/privacy link is not configured/i);
  });

  it('fails closed with a bounded error screen when loading rejects', async () => {
    const hostRuntime = runtime();
    vi.mocked(hostRuntime.loadViewModel)
      .mockRejectedValueOnce(new Error('raw transport details'))
      .mockResolvedValueOnce(viewModel());

    renderHost(hostRuntime);

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Access could not be verified. Check your connection and try again.',
    );
    expect(screen.queryByText('raw transport details')).toBeNull();
    expect(screen.queryByText('Protected workspace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /restore|check access/i }));
    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(hostRuntime.loadViewModel).toHaveBeenCalledTimes(2);
  });
});
