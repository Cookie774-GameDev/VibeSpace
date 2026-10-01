import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { Account } from './Account';

const mocks = vi.hoisted(() => {
  const maybeSingle = vi.fn();
  const selectEq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq: selectEq }));
  const updateEq = vi.fn();
  const update = vi.fn(() => ({ eq: updateEq }));
  const from = vi.fn(() => ({ update, select }));
  const updateUser = vi.fn(async () => ({ data: {}, error: null }));
  const signOut = vi.fn<() => Promise<{ error: unknown | null }>>(async () => ({ error: null }));
  const toastSuccess = vi.fn();
  const toastError = vi.fn();
  const getSupabaseClient = vi.fn(() => ({
    from,
    auth: { updateUser, signOut },
  }));
  return {
    maybeSingle,
    selectEq,
    select,
    updateEq,
    update,
    from,
    updateUser,
    signOut,
    toastSuccess,
    toastError,
    getSupabaseClient,
  };
});
const {
  maybeSingle,
  selectEq,
  select,
  updateEq,
  update,
  from,
  updateUser,
  signOut,
  toastSuccess,
  toastError,
  getSupabaseClient,
} = mocks;

vi.mock('@/features/auth/SignInDialog', () => ({ SignInDialog: () => null }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => mocks.getSupabaseClient(),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setSignedIn(userId = 'user-cloud-1') {
  useAuthStore.setState({
    displayName: 'Original',
    localUserId: 'local-1',
    cloudSession: {
      user_id: userId,
      email: `${userId}@example.test`,
      expires_at: Date.now() / 1000 + 3600,
    },
    plan: 'pro',
  });
}

describe('Account profile editing', () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    selectEq.mockClear();
    select.mockClear();
    updateEq.mockReset();
    update.mockClear();
    from.mockClear();
    updateUser.mockClear();
    signOut.mockReset();
    signOut.mockResolvedValue({ error: null });
    toastSuccess.mockReset();
    toastError.mockReset();
    getSupabaseClient.mockClear();
    getSupabaseClient.mockImplementation(() => ({
      from,
      auth: { updateUser, signOut },
    }));
    maybeSingle.mockResolvedValue({ data: null, error: null });
    updateEq.mockResolvedValue({ data: null, error: null });
    useAuthStore.setState({
      displayName: 'Original',
      localUserId: 'local-1',
      cloudSession: null,
    });
  });

  afterEach(cleanup);

  it('keeps draft edits dirty until Save and persists locally without cloud', async () => {
    getSupabaseClient.mockReturnValue(null as never);
    render(<Account profileOnly />);

    const input = screen.getByTestId('account-display-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });

    expect(screen.getByTestId('account-profile-save-status').textContent).toMatch(/Unsaved/i);
    expect(useAuthStore.getState().displayName).toBe('Original');

    fireEvent.click(screen.getByTestId('account-profile-save'));

    await waitFor(() => {
      expect(useAuthStore.getState().displayName).toBe('New Name');
    });
    expect(from).not.toHaveBeenCalled();
    expect(screen.getByTestId('account-profile-save-status').textContent).toMatch(
      /Saved on this device/i,
    );
  });

  it('writes display_name through Supabase profiles when signed in', async () => {
    useAuthStore.setState({
      displayName: 'Original',
      localUserId: 'local-1',
      cloudSession: {
        user_id: 'user-cloud-1',
        email: 'ada@example.com',
        expires_at: Date.now() / 1000 + 3600,
      },
    });

    render(<Account profileOnly />);

    await waitFor(() => {
      expect(from).toHaveBeenCalledWith('profiles');
    });

    fireEvent.change(screen.getByTestId('account-display-name-input'), {
      target: { value: 'Ada Cloud' },
    });
    fireEvent.click(screen.getByTestId('account-profile-save'));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ display_name: 'Ada Cloud' });
      expect(updateEq).toHaveBeenCalledWith('id', 'user-cloud-1');
      expect(useAuthStore.getState().displayName).toBe('Ada Cloud');
    });
    expect(screen.getByTestId('account-profile-save-status').textContent).toMatch(
      /Saved to cloud/i,
    );
  });

  it('surfaces cloud save errors without fake success', async () => {
    updateEq.mockResolvedValue({ data: null, error: { message: 'rls denied' } });
    useAuthStore.setState({
      displayName: 'Original',
      cloudSession: {
        user_id: 'user-cloud-1',
        email: 'ada@example.com',
        expires_at: Date.now() / 1000 + 3600,
      },
    });

    render(<Account profileOnly />);
    fireEvent.change(screen.getByTestId('account-display-name-input'), {
      target: { value: 'Blocked' },
    });
    fireEvent.click(screen.getByTestId('account-profile-save'));

    await waitFor(() => {
      expect(screen.getByTestId('account-profile-save-status').textContent).toMatch(/rls denied/i);
    });
    expect(useAuthStore.getState().displayName).toBe('Original');
    expect((screen.getByTestId('account-profile-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('preserves the signed-in account when sign out returns an error', async () => {
    setSignedIn();
    signOut.mockResolvedValue({ error: { message: 'network detail must stay private' } });
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Sign out failed',
        'Your session is still active. Check your connection and try again.',
      ),
    );
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('user-cloud-1');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('preserves the signed-in account when sign out throws', async () => {
    setSignedIn();
    signOut.mockRejectedValue(new Error('raw provider failure'));
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Sign out failed',
        'Your session is still active. Check your connection and try again.',
      ),
    );
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('user-cloud-1');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('fails closed when cloud sign out is unavailable', async () => {
    setSignedIn();
    getSupabaseClient.mockReturnValue(null as never);
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'Sign out failed',
        'Your session is still active. Check your connection and try again.',
      ),
    );
    expect(signOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().cloudSession?.user_id).toBe('user-cloud-1');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('keeps sign out single-flight and exposes its pending state', async () => {
    setSignedIn();
    const pending = deferred<{ error: null }>();
    signOut.mockReturnValue(pending.promise);
    render(<Account profileOnly />);

    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Sign out' });
    fireEvent.click(button);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Signing out…' }).disabled).toBe(
      true,
    );
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(signOut).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve({ error: null }));
    await waitFor(() => expect(useAuthStore.getState().cloudSession).toBeNull());
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the authoritative signed-out store publication', async () => {
    setSignedIn();
    const pending = deferred<{ error: null }>();
    signOut.mockReturnValue(pending.promise);
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    let storeNotifications = 0;
    const unsubscribe = useAuthStore.subscribe(() => {
      storeNotifications += 1;
    });
    try {
      act(() => useAuthStore.setState({ cloudSession: null, plan: 'free' }));
      expect(storeNotifications).toBe(1);
      storeNotifications = 0;

      await act(async () => pending.resolve({ error: null }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(storeNotifications).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('clears only the matching account after confirmed sign out', async () => {
    setSignedIn();
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(useAuthStore.getState().cloudSession).toBeNull());
    expect(useAuthStore.getState().plan).toBe('free');
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith(
      'Signed out',
      'You have been signed out of your account.',
    );
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed account A sign out clear or announce into account B', async () => {
    setSignedIn('account-a');
    const pending = deferred<{ error: null }>();
    signOut.mockReturnValue(pending.promise);
    render(<Account profileOnly />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    act(() => {
      useAuthStore.setState({
        cloudSession: {
          user_id: 'account-b',
          email: 'account-b@example.test',
          expires_at: Date.now() / 1000 + 3600,
        },
        plan: 'pro',
      });
    });
    await act(async () => pending.resolve({ error: null }));

    expect(useAuthStore.getState().cloudSession?.user_id).toBe('account-b');
    expect(useAuthStore.getState().plan).toBe('pro');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
