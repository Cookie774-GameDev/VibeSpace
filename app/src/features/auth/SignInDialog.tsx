import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Loader2, AlertTriangle, Mail } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { getSupabaseClient } from '@/lib/supabase/client';
import { OtpCodeInput } from './OtpCodeInput';
import {
  isCompleteOtpCode,
  normalizeOtpCode,
  validateEmail,
  validatePassword,
} from './authValidation';

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which tab to open on. Defaults to 'signin'. */
  initialMode?: Mode;
}

type Mode = 'signin' | 'signup' | 'magic';
type Phase = 'credentials' | 'verify';
type VerifyKind = 'signup' | 'email';

/**
 * Supabase auth form:
 *   - signin: email + password
 *   - signup: email + password, then 6-digit email verification code
 *   - magic:  email-only sign-in via 6-digit code (no password)
 */
export function SignInDialog({ open, onOpenChange, initialMode }: SignInDialogProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [mode, setMode] = useState<Mode>(initialMode ?? 'signin');
  const [phase, setPhase] = useState<Phase>('credentials');
  const [verifyKind, setVerifyKind] = useState<VerifyKind>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMode(initialMode ?? 'signin');
      setPhase('credentials');
      setOtpCode('');
      setError(null);
    }
  }, [open, initialMode]);

  const NOT_CONFIGURED =
    'VibeSpace Cloud is not configured in this build. Install the official VibeSpace release, or ask the build maintainer to configure the app backend.';

  function reset() {
    setEmail('');
    setPassword('');
    setOtpCode('');
    setPhase('credentials');
    setBusy(false);
    setError(null);
  }

  function selectMode(next: Mode) {
    setMode(next);
    setPhase('credentials');
    setOtpCode('');
    setError(null);
  }

  async function handleCredentialsSubmit() {
    setError(null);
    const trimmedEmail = email.trim();
    const emailError = validateEmail(trimmedEmail);
    if (emailError) {
      setError(emailError);
      return;
    }

    if (mode !== 'magic') {
      const passwordError = validatePassword(password, mode);
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }

    setBusy(true);
    const client = getSupabaseClient();
    if (!client) {
      setBusy(false);
      setError(NOT_CONFIGURED);
      return;
    }

    try {
      if (mode === 'magic') {
        const { error: otpError } = await client.auth.signInWithOtp({
          email: trimmedEmail,
          options: { shouldCreateUser: false },
        });
        if (otpError) throw otpError;
        setVerifyKind('email');
        setPhase('verify');
        setOtpCode('');
        toast.success('Code sent', `We emailed a 6-digit code to ${trimmedEmail}.`);
        return;
      }

      if (mode === 'signup') {
        const { data, error: signUpError } = await client.auth.signUp({
          email: trimmedEmail,
          password,
        });
        if (signUpError) throw signUpError;
        if (data.session) {
          toast.success('Account created', 'You are signed in. Cloud sync is enabled.');
          onOpenChange(false);
          reset();
          return;
        }
        setVerifyKind('signup');
        setPhase('verify');
        setOtpCode('');
        toast.success('Code sent', `We emailed a 6-digit code to ${trimmedEmail}.`);
        return;
      }

      const { error: signInError } = await client.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });
      if (signInError) throw signInError;
      toast.success('Signed in', 'Cloud sync is now enabled.');
      onOpenChange(false);
      reset();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign in failed.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifySubmit() {
    setError(null);
    const trimmedEmail = email.trim();
    const token = normalizeOtpCode(otpCode);
    if (!isCompleteOtpCode(token)) {
      setError('Enter the full 6-digit code from your email.');
      return;
    }

    setBusy(true);
    const client = getSupabaseClient();
    if (!client) {
      setBusy(false);
      setError(NOT_CONFIGURED);
      return;
    }

    try {
      const { error: verifyError } = await client.auth.verifyOtp({
        email: trimmedEmail,
        token,
        type: verifyKind,
      });
      if (verifyError) throw verifyError;

      toast.success(
        verifyKind === 'signup' ? 'Account created' : 'Signed in',
        verifyKind === 'signup'
          ? 'Your email is verified and cloud sync is enabled.'
          : 'Cloud sync is now enabled.',
      );
      onOpenChange(false);
      reset();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Verification failed.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function handleResendCode() {
    setError(null);
    const trimmedEmail = email.trim();
    const emailError = validateEmail(trimmedEmail);
    if (emailError) {
      setError(emailError);
      return;
    }

    setBusy(true);
    const client = getSupabaseClient();
    if (!client) {
      setBusy(false);
      setError(NOT_CONFIGURED);
      return;
    }

    try {
      if (verifyKind === 'signup') {
        if (!password) {
          setError('Go back and re-enter your password to resend the code.');
          return;
        }
        const { error: signUpError } = await client.auth.signUp({
          email: trimmedEmail,
          password,
        });
        if (signUpError) throw signUpError;
      } else {
        const { error: otpError } = await client.auth.signInWithOtp({
          email: trimmedEmail,
          options: { shouldCreateUser: false },
        });
        if (otpError) throw otpError;
      }
      setOtpCode('');
      toast.success('New code sent', `Check ${trimmedEmail} for a fresh 6-digit code.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not resend the code.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const verifying = phase === 'verify';
  const trimmedEmail = email.trim();

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {verifying
              ? 'Enter verification code'
              : mode === 'signup'
                ? 'Create your account'
                : 'Sign in'}
          </DialogTitle>
          <DialogDescription>
            {verifying ? (
              <>
                We sent a 6-digit code to{' '}
                <span className="font-medium text-foreground">{trimmedEmail}</span>. Paste it below
                to {verifyKind === 'signup' ? 'finish creating your account' : 'sign in'}.
              </>
            ) : mode === 'signup' ? (
              'Use a valid email and password. We will email you a verification code to confirm your account.'
            ) : mode === 'magic' ? (
              'Sign in without a password. We will email you a one-time 6-digit code.'
            ) : (
              'Welcome back. Sign in to access your account, plan, and synced workspace.'
            )}
          </DialogDescription>
        </DialogHeader>

        {!verifying && (
          <div className="flex items-center gap-1 rounded-md bg-muted p-0.5 self-start">
            <ModeButton current={mode} value="signin" onSelect={selectMode}>
              Sign in
            </ModeButton>
            <ModeButton current={mode} value="signup" onSelect={selectMode}>
              Create account
            </ModeButton>
            <ModeButton current={mode} value="magic" onSelect={selectMode}>
              Email code
            </ModeButton>
          </div>
        )}

        <div className="flex flex-col gap-3">
          {verifying ? (
            <div className="flex flex-col items-center gap-4 py-2">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-cyan/10 text-accent-cyan">
                <Mail className="h-5 w-5" />
              </div>
              <OtpCodeInput
                value={otpCode}
                onChange={setOtpCode}
                disabled={busy}
                autoFocus
                aria-invalid={Boolean(error)}
              />
              <p className="text-metadata text-muted-foreground text-center">
                Codes expire after one hour. You can paste the full code at once.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-secondary"
                disabled={busy}
                onClick={() => void handleResendCode()}
              >
                Resend code
              </Button>
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="signin-email">Email</Label>
                <Input
                  id="signin-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleCredentialsSubmit();
                    }
                  }}
                  disabled={busy}
                />
              </div>

              {mode !== 'magic' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="signin-password">Password</Label>
                  <Input
                    id="signin-password"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleCredentialsSubmit();
                      }
                    }}
                    disabled={busy}
                  />
                  {mode === 'signup' ? (
                    <p className="text-metadata text-muted-foreground">
                      At least 8 characters with letters and numbers.
                    </p>
                  ) : null}
                </div>
              )}
            </>
          )}

          {error && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/25 px-3 py-2.5"
              role="alert"
            >
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" aria-hidden />
              <p className="text-sm font-medium leading-snug text-foreground">{error}</p>
            </div>
          )}
        </div>

        <Separator />

        <DialogFooter className="!justify-between sm:!justify-between">
          {verifying ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPhase('credentials');
                setOtpCode('');
                setError(null);
              }}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button
            variant="accent"
            onClick={verifying ? handleVerifySubmit : handleCredentialsSubmit}
            disabled={busy || (verifying && !isCompleteOtpCode(otpCode))}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Working...
              </>
            ) : verifying ? (
              <>Verify & continue</>
            ) : mode === 'magic' ? (
              <>
                <Mail className="h-3.5 w-3.5" />
                Send code
              </>
            ) : mode === 'signup' ? (
              <>Send verification code</>
            ) : (
              <>Sign in</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeButton({
  current,
  value,
  onSelect,
  children,
}: {
  current: Mode;
  value: Mode;
  onSelect: (m: Mode) => void;
  children: ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={active}
      className={
        'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-2.5 py-1 text-secondary font-medium transition-all ' +
        (active
          ? 'bg-elevated text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}
