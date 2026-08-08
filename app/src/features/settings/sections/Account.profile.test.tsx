import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { Account } from './Account';

const maybeSingle = vi.fn();
const selectEq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq: selectEq }));
const updateEq = vi.fn();
const update = vi.fn(() => ({ eq: updateEq }));
const from = vi.fn(() => ({ update, select }));
const updateUser = vi.fn(async () => ({ data: {}, error: null }));
const getSupabaseClient = vi.fn(() => ({
  from,
  auth: { updateUser, signOut: vi.fn() },
}));

vi.mock('@/features/auth/SignInDialog', () => ({ SignInDialog: () => null }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => getSupabaseClient(),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('Account profile editing', () => {
  beforeEach(() => {
    maybeSingle.mockReset();
    selectEq.mockClear();
    select.mockClear();
    updateEq.mockReset();
    update.mockClear();
    from.mockClear();
    updateUser.mockClear();
    getSupabaseClient.mockClear();
    getSupabaseClient.mockImplementation(() => ({
      from,
      auth: { updateUser, signOut: vi.fn() },
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
});
