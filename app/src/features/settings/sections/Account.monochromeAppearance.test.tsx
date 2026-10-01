import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { Account } from './Account';

// Sign-in dialog is owned by auth and must not perform network side effects
// inside this visual contract test (MC-034 / Account Center profile surface).
vi.mock('@/features/auth/SignInDialog', () => ({ SignInDialog: () => null }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => null,
}));

describe('Account profile MonoChrome appearance', () => {
  beforeEach(() => {
    useAuthStore.setState({
      displayName: 'Ada Lovelace',
      localUserId: 'local-user-fixture',
      cloudSession: null,
    });
  });

  afterEach(cleanup);

  it('gates radius, background-image, and shadow under exact monochrome only', () => {
    render(<Account profileOnly />);

    const root = document.querySelector<HTMLElement>('.mc7f-account-profile');
    expect(root).not.toBeNull();
    const className = root?.className ?? '';

    expect(className).toContain('[html[data-theme=monochrome]_&_*]:rounded-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:bg-none');
    expect(className).toContain('[html[data-theme=monochrome]_&_*]:shadow-none');

    // Ordinary-theme layout and the exact-theme accent rail stay intact.
    expect(className).toContain('flex flex-col gap-6');
    expect(className).toContain('[html[data-theme=monochrome]_&]:border-l-foreground/20');
    expect(className).not.toMatch(/gradient|blur/);

    // Meaningful product surface and copy are preserved on Account Center.
    expect(screen.getByText('Display name')).toBeTruthy();
    expect(screen.getByText('Local user ID')).toBeTruthy();
    expect(screen.getByTestId('account-profile-save')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /Pet/i })).toBeNull();
  });
});
