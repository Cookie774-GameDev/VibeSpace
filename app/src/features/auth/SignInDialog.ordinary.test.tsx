import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  signOut: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  getSession: vi.fn(),
}));
const toastSuccess = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/client', () => ({
  isCloudSyncConfigured: () => true,
  getSupabaseClient: () => ({ auth }),
}));

vi.mock('@/components/ui/toast', () => ({
  toast: { success: toastSuccess, error: vi.fn(), info: vi.fn() },
}));

import { SignInDialog } from './SignInDialog';

const EMAIL = 'owner@example.test';
const PASSWORD = 'SecurePass9';

function session(email = EMAIL, id = 'user-a', accessToken = 'token-a') {
  return { access_token: accessToken, user: { id, email } };
}

function enterEmail(value = EMAIL) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value } });
}

function enterPassword(value = PASSWORD) {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value } });
}

function chooseSignup() {
  fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
}

function chooseEmailCode() {
  fireEvent.click(screen.getByRole('button', { name: 'Email code' }));
}

function submitNamed(name: RegExp) {
  const button = screen
    .getAllByRole('button', { name })
    .find((candidate) => !candidate.hasAttribute('aria-pressed'));
  if (!button) throw new Error(`Submit button not found for ${name}`);
  fireEvent.click(button);
}

function enterSignupCredentials(confirmation = PASSWORD) {
  chooseSignup();
  enterEmail();
  enterPassword();
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: confirmation },
  });
}

function enterOtp() {
  fireEvent.change(screen.getByLabelText('Digit 1 of 6'), {
    target: { value: '123456' },
  });
}

describe('SignInDialog ordinary authentication', () => {
  beforeEach(() => {
    auth.signUp.mockReset().mockResolvedValue({
      data: {
        user: { id: 'user-a', email: EMAIL, identities: [{ id: 'identity-a' }] },
        session: null,
      },
      error: null,
    });
    auth.signInWithPassword
      .mockReset()
      .mockResolvedValue({ data: { session: session() }, error: null });
    auth.signInWithOtp.mockReset().mockResolvedValue({ data: {}, error: null });
    auth.verifyOtp.mockReset().mockResolvedValue({ data: { session: session() }, error: null });
    auth.resend.mockReset().mockResolvedValue({ data: {}, error: null });
    auth.signOut.mockReset().mockResolvedValue({ error: null });
    auth.resetPasswordForEmail.mockReset().mockResolvedValue({ data: {}, error: null });
    auth.updateUser.mockReset().mockResolvedValue({ data: {}, error: null });
    auth.getSession.mockReset().mockResolvedValue({ data: { session: session() }, error: null });
    toastSuccess.mockReset();
  });

  it('requires matching password confirmation before signup reaches Supabase', () => {
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials('Different9');

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect(screen.getByRole('alert').textContent).toMatch(/passwords do not match/i);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null, false],
    ['wrong-account', session('other@example.test', 'user-b'), true],
  ])(
    'fails closed when password sign-in returns a %s session',
    async (_label, returnedSession, signsOut) => {
      auth.signInWithPassword.mockResolvedValueOnce({
        data: { session: returnedSession },
        error: null,
      });
      auth.getSession.mockResolvedValueOnce({
        data: { session: returnedSession },
        error: null,
      });
      const onOpenChange = vi.fn();
      render(<SignInDialog open onOpenChange={onOpenChange} />);
      enterEmail();
      enterPassword();

      submitNamed(/^sign in$/i);

      expect((await screen.findByRole('alert')).textContent).toMatch(/could not be verified/i);
      if (signsOut) {
        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
      } else {
        expect(auth.signOut).not.toHaveBeenCalled();
      }
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it('fails closed when immediate signup returns a different account session', async () => {
    auth.signUp.mockResolvedValueOnce({
      data: {
        user: { email: 'other@example.test', identities: [{ id: 'identity-b' }] },
        session: session('other@example.test', 'user-b'),
      },
      error: null,
    });
    auth.getSession.mockResolvedValueOnce({
      data: { session: session('other@example.test', 'user-b') },
      error: null,
    });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be verified/i);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['signup', () => enterSignupCredentials()],
    [
      'email',
      () => {
        chooseEmailCode();
        enterEmail();
      },
    ],
  ])('requires an exact session after %s OTP verification', async (kind, begin) => {
    auth.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: null });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    begin();
    fireEvent.click(
      screen.getByRole('button', {
        name: kind === 'signup' ? /create account/i : /send code/i,
      }),
    );
    await screen.findByLabelText('Digit 1 of 6');
    enterOtp();

    fireEvent.click(screen.getByRole('button', { name: /verify & continue/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be verified/i);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalledWith(
      kind === 'signup' ? 'Account verified' : 'Signed in',
      expect.anything(),
    );
  });

  it('uses generic copy for an existing-account signup response', async () => {
    auth.signUp.mockResolvedValueOnce({
      data: { user: { identities: [] }, session: null },
      error: null,
    });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    const copy = (await screen.findByRole('alert')).textContent ?? '';
    expect(copy).not.toMatch(/already|exists|registered|sent/i);
    expect(copy).toMatch(/unable to complete sign-up/i);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('does not claim delivery for an ambiguous initial signup response', async () => {
    auth.signUp.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: null,
    });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    const copy = (await screen.findByRole('alert')).textContent ?? '';
    expect(copy).toMatch(/unable to complete sign-up/i);
    expect(copy).not.toMatch(/sent|inbox|on the way/i);
    expect(screen.queryByLabelText('Digit 1 of 6')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['missing user id', { email: EMAIL, identities: [{ id: 'identity-a' }] }],
    ['wrong user email', { id: 'user-a', email: 'other@example.test', identities: [{}] }],
  ])('rejects an unbound signup verification response with %s', async (_label, user) => {
    auth.signUp.mockResolvedValueOnce({ data: { user, session: null }, error: null });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();

    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/unable to complete sign-up/i);
    expect(screen.queryByLabelText('Digit 1 of 6')).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('does not claim resend success when the signup fallback is ambiguous', async () => {
    auth.resend.mockResolvedValueOnce({
      data: {},
      error: new Error('resend unavailable'),
    });
    auth.signUp
      .mockResolvedValueOnce({
        data: {
          user: { id: 'user-a', email: EMAIL, identities: [{ id: 'identity-a' }] },
          session: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { user: { identities: [] }, session: null },
        error: null,
      });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await screen.findByLabelText('Digit 1 of 6');
    toastSuccess.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /resend code/i }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('describes a successful resend as conditional rather than delivered', async () => {
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await screen.findByLabelText('Digit 1 of 6');
    toastSuccess.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /resend code/i }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/request.*accepted/i);
    expect(status.textContent).not.toMatch(/sent|on the way/i);
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringMatching(/request accepted/i),
      expect.not.stringMatching(/sent|on the way/i),
    );
  });

  it('clears signup secrets and invalidates work when Back returns to credentials', async () => {
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterSignupCredentials();
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await screen.findByLabelText('Digit 1 of 6');
    enterOtp();

    fireEvent.click(screen.getByRole('button', { name: /back/i }));

    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Confirm password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByDisplayValue('123456')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('invalidates a delayed completion when the user selects another mode', async () => {
    let resolveSignIn:
      | ((value: { data: { session: ReturnType<typeof session> }; error: null }) => void)
      | undefined;
    auth.signInWithPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    render(<SignInDialog open onOpenChange={onOpenChange} />);
    enterEmail();
    enterPassword();
    submitNamed(/^sign in$/i);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    await act(async () => {
      resolveSignIn?.({ data: { session: session() }, error: null });
    });

    expect(screen.getByRole('heading', { name: /create your account/i })).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('cleans up a stale returned session without signing out a newer session', async () => {
    let resolveSignIn:
      | ((value: { data: { session: ReturnType<typeof session> }; error: null }) => void)
      | undefined;
    auth.signInWithPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    auth.getSession.mockResolvedValueOnce({
      data: { session: session(EMAIL, 'user-a', 'token-newer') },
      error: null,
    });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterEmail();
    enterPassword();
    submitNamed(/^sign in$/i);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    await act(async () => {
      resolveSignIn?.({ data: { session: session(EMAIL, 'user-a', 'token-old') }, error: null });
    });

    expect(auth.getSession).toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('signs out a stale returned session when the current token still belongs to that attempt', async () => {
    let resolveSignIn:
      | ((value: { data: { session: ReturnType<typeof session> }; error: null }) => void)
      | undefined;
    const staleSession = session(EMAIL, 'user-a', 'token-stale');
    auth.signInWithPassword.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      }),
    );
    auth.getSession.mockResolvedValueOnce({
      data: { session: staleSession },
      error: null,
    });
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterEmail();
    enterPassword();
    submitNamed(/^sign in$/i);
    await waitFor(() => expect(auth.signInWithPassword).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole('button', { name: 'Sign up' }));
    await act(async () => {
      resolveSignIn?.({ data: { session: staleSession }, error: null });
    });

    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('clears email on mode transitions and disables locally invalid submissions', () => {
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    enterEmail('not-an-email');

    expect(screen.getByText(/enter a valid email address/i)).toBeTruthy();
    expect(
      (
        screen
          .getAllByRole('button', { name: /^sign in$/i })
          .find((candidate) => !candidate.hasAttribute('aria-pressed')) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: /forgot password/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    chooseSignup();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('');
    expect(
      (screen.getByRole('button', { name: /create account/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    enterEmail();
    enterPassword();
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'Different9' },
    });
    expect(screen.getByText(/passwords do not match/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /create account/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('exposes stable labelled names and standard autocomplete tokens', () => {
    render(<SignInDialog open onOpenChange={vi.fn()} />);
    const emailInput = screen.getByLabelText('Email');
    const passwordInput = screen.getByLabelText('Password');
    expect(emailInput.getAttribute('id')).toBe('signin-email');
    expect(emailInput.getAttribute('name')).toBe('email');
    expect(emailInput.getAttribute('autocomplete')).toBe('email');
    expect(passwordInput.getAttribute('id')).toBe('signin-password');
    expect(passwordInput.getAttribute('name')).toBe('password');
    expect(passwordInput.getAttribute('autocomplete')).toBe('current-password');

    chooseSignup();
    const signupPassword = screen.getByLabelText('Password');
    const confirmation = screen.getByLabelText('Confirm password');
    expect(signupPassword.getAttribute('autocomplete')).toBe('new-password');
    expect(confirmation.getAttribute('name')).toBe('password-confirmation');
    expect(confirmation.getAttribute('autocomplete')).toBe('new-password');
  });
});
