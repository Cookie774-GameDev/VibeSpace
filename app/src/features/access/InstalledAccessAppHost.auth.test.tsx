import * as React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMock = vi.hoisted(() => ({
  authListener: null as ((event: string, session: unknown) => void) | null,
  createRuntime: vi.fn(),
  getSession: vi.fn(),
  loadViewModel: vi.fn(),
  onAuthStateChange: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: authMock.getSession,
      onAuthStateChange: authMock.onAuthStateChange,
      signOut: authMock.signOut,
    },
  }),
}));

vi.mock('@/features/auth/SignInDialog', () => ({
  SignInDialog: ({ open, initialMode }: { open: boolean; initialMode?: string }) =>
    open ? (
      <div role="dialog" aria-label="Cloud authentication" data-mode={initialMode}>
        Authentication dialog
      </div>
    ) : null,
}));

vi.mock('./installedAccessRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./installedAccessRuntime')>();
  return {
    ...actual,
    createInstalledAccessRuntime: authMock.createRuntime,
  };
});

import { InstalledAccessAppHost } from './AccessAppHost';
import { useAuthStore } from '@/stores/auth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function session(userId: string) {
  return {
    user: { id: userId, email: `${userId}@example.test` },
    expires_at: 2_000_000_000,
  };
}

function activeViewModel() {
  return {
    host: {
      displayState: 'active',
      featureTier: 'free',
      usable: true,
      capturedAt: 1_785_000_000_000,
    },
  };
}

function blockedViewModel() {
  return {
    host: {
      displayState: 'expired',
      featureTier: 'pro',
      usable: false,
      capturedAt: 1_785_000_000_000,
    },
    paywall: {
      displayState: 'expired',
      featureTier: 'pro',
    },
  };
}

function createLifecycleProbe(label: string) {
  const events: string[] = [];
  function Probe({ children }: React.PropsWithChildren) {
    React.useEffect(() => {
      events.push(`${label}:mount`);
      return () => {
        events.push(`${label}:cleanup`);
      };
    }, []);
    return <div data-testid={`${label}-probe`}>{children}</div>;
  }
  return { events, Probe };
}

describe('InstalledAccessAppHost signed-out production boot', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_ACCESS_GATE_ENABLED', 'true');
    authMock.getSession.mockReset();
    authMock.loadViewModel.mockReset();
    authMock.onAuthStateChange.mockReset();
    authMock.signOut.mockReset();
    authMock.unsubscribe.mockReset();
    authMock.createRuntime.mockReset();
    authMock.authListener = null;
    authMock.loadViewModel.mockResolvedValue(activeViewModel());
    authMock.createRuntime.mockImplementation(() => ({ loadViewModel: authMock.loadViewModel }));
    authMock.getSession.mockResolvedValue({ data: { session: null }, error: null });
    authMock.signOut.mockResolvedValue({ error: null });
    authMock.onAuthStateChange.mockImplementation((listener) => {
      authMock.authListener = listener;
      return {
        data: { subscription: { unsubscribe: authMock.unsubscribe } },
      };
    });
    useAuthStore.setState({ cloudSession: null, plan: 'free' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('keeps sign-in and account creation reachable before Access checks the workspace', async () => {
    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );

    expect(await screen.findByRole('heading', { name: 'Sign in to VibeSpace' })).toBeTruthy();
    expect(screen.queryByText('Protected workspace')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      screen.getByRole('dialog', { name: 'Cloud authentication' }).getAttribute('data-mode'),
    ).toBe('signin');

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      screen.getByRole('dialog', { name: 'Cloud authentication' }).getAttribute('data-mode'),
    ).toBe('signup');
  });

  it('fails closed and reloads Access when two accounts share the same feature tier', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    const accountB = deferred<ReturnType<typeof activeViewModel>>();
    authMock.createRuntime.mockImplementation(() => ({
      loadViewModel: vi.fn(() =>
        useAuthStore.getState().cloudSession?.user_id === 'account-b'
          ? accountB.promise
          : Promise.resolve(activeViewModel()),
      ),
    }));

    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );
    expect(await screen.findByText('Protected workspace')).toBeTruthy();

    act(() => authMock.authListener?.('SIGNED_IN', session('account-b')));
    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Checking your access status/i);

    await act(async () => accountB.resolve(activeViewModel()));
    expect(await screen.findByText('Protected workspace')).toBeTruthy();
  });

  it('ignores a delayed bootstrap session after a newer auth event', async () => {
    const initial = deferred<{ data: { session: ReturnType<typeof session> }; error: null }>();
    authMock.getSession.mockReturnValue(initial.promise);

    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );
    await waitFor(() => expect(authMock.authListener).not.toBeNull());

    act(() => authMock.authListener?.('SIGNED_IN', session('account-b')));
    await waitFor(() => expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-b'));

    await act(async () =>
      initial.resolve({ data: { session: session('account-a') }, error: null }),
    );
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-b');
  });

  it('keeps the authenticated runtime boundary mounted while keyed Access reloads for a new account', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    const accountB = deferred<ReturnType<typeof activeViewModel>>();
    authMock.createRuntime.mockImplementation(() => ({
      loadViewModel: vi.fn(() =>
        useAuthStore.getState().cloudSession?.user_id === 'account-b'
          ? accountB.promise
          : Promise.resolve(activeViewModel()),
      ),
    }));
    const boundary = createLifecycleProbe('runtime-boundary');
    const workspace = createLifecycleProbe('workspace');

    const view = render(
      React.createElement(
        InstalledAccessAppHost,
        { authenticatedBoundary: boundary.Probe },
        <workspace.Probe>Protected workspace</workspace.Probe>,
      ),
    );

    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(boundary.events).toEqual(['runtime-boundary:mount']);
    expect(workspace.events).toEqual(['workspace:mount']);

    act(() => authMock.authListener?.('SIGNED_IN', session('account-b')));
    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(boundary.events).toEqual(['runtime-boundary:mount']);
    expect(workspace.events).toEqual(['workspace:mount', 'workspace:cleanup']);

    await act(async () => accountB.resolve(activeViewModel()));
    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(boundary.events).toEqual(['runtime-boundary:mount']);
    expect(workspace.events).toEqual(['workspace:mount', 'workspace:cleanup', 'workspace:mount']);

    view.unmount();
    expect(boundary.events).toEqual(['runtime-boundary:mount', 'runtime-boundary:cleanup']);
    expect(workspace.events).toEqual([
      'workspace:mount',
      'workspace:cleanup',
      'workspace:mount',
      'workspace:cleanup',
    ]);
  });

  it('unmounts the authenticated runtime boundary once when the cloud session signs out', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    const boundary = createLifecycleProbe('runtime-boundary');
    const workspace = createLifecycleProbe('workspace');

    render(
      React.createElement(
        InstalledAccessAppHost,
        { authenticatedBoundary: boundary.Probe },
        <workspace.Probe>Protected workspace</workspace.Probe>,
      ),
    );

    expect(await screen.findByText('Protected workspace')).toBeTruthy();
    expect(boundary.events).toEqual(['runtime-boundary:mount']);

    act(() => authMock.authListener?.('SIGNED_OUT', null));
    expect(await screen.findByRole('heading', { name: 'Sign in to VibeSpace' })).toBeTruthy();
    expect(boundary.events).toEqual(['runtime-boundary:mount', 'runtime-boundary:cleanup']);
    expect(workspace.events).toEqual(['workspace:mount', 'workspace:cleanup']);

    act(() => authMock.authListener?.('SIGNED_OUT', null));
    expect(boundary.events).toEqual(['runtime-boundary:mount', 'runtime-boundary:cleanup']);
    expect(workspace.events).toEqual(['workspace:mount', 'workspace:cleanup']);
  });

  it('moves focus to the signed-out heading once after the workspace unmounts', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });

    render(
      <React.StrictMode>
        <InstalledAccessAppHost>
          <button type="button">Protected workspace</button>
        </InstalledAccessAppHost>
      </React.StrictMode>,
    );

    const workspaceButton = await screen.findByRole('button', { name: 'Protected workspace' });
    workspaceButton.focus();
    expect(document.activeElement).toBe(workspaceButton);
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      act(() => authMock.authListener?.('SIGNED_OUT', null));
      const signedOutHeading = await screen.findByRole('heading', { name: 'Sign in to VibeSpace' });
      expect(signedOutHeading.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(signedOutHeading);
      expect(focusSpy).toHaveBeenCalledTimes(1);

      act(() => authMock.authListener?.('SIGNED_OUT', null));
      expect(document.activeElement).toBe(signedOutHeading);
      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Cloud authentication' })).toBeNull();
    } finally {
      focusSpy.mockRestore();
    }
  });

  it('does not republish an already signed-out store state', async () => {
    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );
    expect(await screen.findByRole('heading', { name: 'Sign in to VibeSpace' })).toBeTruthy();

    let storeNotifications = 0;
    const unsubscribe = useAuthStore.subscribe(() => {
      storeNotifications += 1;
    });
    try {
      act(() => authMock.authListener?.('SIGNED_OUT', null));
      expect(storeNotifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('preserves the installed account and plan when sign out returns an error', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    authMock.loadViewModel.mockResolvedValue(blockedViewModel());
    authMock.signOut.mockResolvedValue({ error: { message: 'raw provider detail' } });
    useAuthStore.setState({ plan: 'pro' });

    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sign Out' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sign out could not be completed. Please try again.');
    expect(alert.textContent).not.toContain('raw provider detail');
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-a');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(authMock.loadViewModel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('heading', { name: 'Sign in to VibeSpace' })).toBeNull();
  });

  it('does not let delayed installed account A sign out clear account B', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    authMock.loadViewModel.mockResolvedValue(blockedViewModel());
    const pending = deferred<{ error: null }>();
    authMock.signOut.mockReturnValue(pending.promise);
    useAuthStore.setState({ plan: 'pro' });

    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sign Out' }));
    act(() => authMock.authListener?.('SIGNED_IN', session('account-b')));
    await waitFor(() => expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-b'));
    await act(async () => pending.resolve({ error: null }));

    expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-b');
    expect(useAuthStore.getState().plan).toBe('free');
    expect(screen.queryByRole('heading', { name: 'Sign in to VibeSpace' })).toBeNull();
  });

  it('waits for authoritative SIGNED_OUT before publishing installed sign out', async () => {
    authMock.getSession.mockResolvedValue({ data: { session: session('account-a') }, error: null });
    authMock.loadViewModel.mockResolvedValue(blockedViewModel());
    useAuthStore.setState({ plan: 'pro' });

    render(
      <InstalledAccessAppHost>
        <p>Protected workspace</p>
      </InstalledAccessAppHost>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Sign Out' }));
    await waitFor(() => expect(authMock.signOut).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-a');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(screen.queryByRole('heading', { name: 'Sign in to VibeSpace' })).toBeNull();
  });

  it('bypasses account-keyed Access while the installed access gate is disabled', async () => {
    vi.stubEnv('VITE_ACCESS_GATE_ENABLED', 'false');
    useAuthStore.setState({
      cloudSession: {
        user_id: 'account-a',
        email: 'account-a@example.test',
        expires_at: 2_000_000_000,
      },
      plan: 'free',
    });
    const boundary = createLifecycleProbe('runtime-boundary');
    const workspace = createLifecycleProbe('workspace');

    render(
      React.createElement(
        InstalledAccessAppHost,
        { authenticatedBoundary: boundary.Probe },
        <workspace.Probe>Protected workspace</workspace.Probe>,
      ),
    );
    expect(await screen.findByText('Protected workspace')).toBeTruthy();

    act(() => {
      useAuthStore.setState({
        cloudSession: {
          user_id: 'account-b',
          email: 'account-b@example.test',
          expires_at: 2_000_000_000,
        },
      });
    });

    expect(boundary.events).toEqual(['runtime-boundary:mount']);
    expect(workspace.events).toEqual(['workspace:mount']);
    expect(authMock.getSession).not.toHaveBeenCalled();
    expect(authMock.onAuthStateChange).not.toHaveBeenCalled();
    expect(authMock.loadViewModel).not.toHaveBeenCalled();
  });
});
