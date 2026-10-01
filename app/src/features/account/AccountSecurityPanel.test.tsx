import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateUser = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({ auth: { updateUser } }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

import { AccountSecurityPanel } from './AccountSecurityPanel';

describe('AccountSecurityPanel', () => {
  beforeEach(() => {
    updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it('changes the password only for the current authenticated session', async () => {
    render(<AccountSecurityPanel accountId="account-a" />);

    fireEvent.change(screen.getByLabelText('New account password'), {
      target: { value: 'SecurePass9' },
    });
    fireEvent.change(screen.getByLabelText('Confirm account password'), {
      target: { value: 'SecurePass9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));

    await waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ password: 'SecurePass9' });
    });
    expect(screen.getByRole('status').textContent).toMatch(/password updated/i);
  });

  it('never offers a password mutation without a cloud session', () => {
    render(<AccountSecurityPanel accountId="" />);

    expect(screen.queryByLabelText('New account password')).toBeNull();
    expect(screen.getByText(/sign in to change/i)).toBeTruthy();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('clears password fields and status when the cloud account changes', async () => {
    const { rerender } = render(<AccountSecurityPanel accountId="account-a" />);
    fireEvent.change(screen.getByLabelText('New account password'), {
      target: { value: 'SecurePass9' },
    });
    fireEvent.change(screen.getByLabelText('Confirm account password'), {
      target: { value: 'Different9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(screen.getByRole('alert').textContent).toMatch(/passwords do not match/i);

    rerender(<AccountSecurityPanel accountId="account-b" />);

    expect((screen.getByLabelText('New account password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Confirm account password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ignores a delayed password response after switching accounts', async () => {
    let resolveUpdate: ((value: { data: object; error: null }) => void) | undefined;
    updateUser.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    const { rerender } = render(<AccountSecurityPanel key="account-a" accountId="account-a" />);
    fireEvent.change(screen.getByLabelText('New account password'), {
      target: { value: 'SecurePass9' },
    });
    fireEvent.change(screen.getByLabelText('Confirm account password'), {
      target: { value: 'SecurePass9' },
    });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    await waitFor(() => expect(updateUser).toHaveBeenCalledTimes(1));

    rerender(<AccountSecurityPanel key="account-b" accountId="account-b" />);
    resolveUpdate?.({ data: {}, error: null });

    await waitFor(() => {
      expect(screen.queryByText('Password updated.')).toBeNull();
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
