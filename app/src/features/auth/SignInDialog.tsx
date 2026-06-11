import { useEffect, useState, type ReactNode } from 'react';
import { Mail, Loader2, AlertTriangle } from 'lucide-react';
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

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which tab to open on. Defaults to 'signin'. */
  initialMode?: Mode;
}

type Mode = 'signin' | 'signup' | 'magic';

/**
 * Lightweight Supabase auth form. Three modes:
 *   - signin: email + password (existing account)
 *   - signup: email + password (create a new account)
 *   - magic:  email-only, calls signInWithOtp
 *
 * Gracefully degrades when the Supabase client isn't configured.
 */
export function SignInDialog({ open, onOpenChange, initialMode }: SignInDialogProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>(initialMode ?? 'signin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Open on the requested tab each time the dialog is shown.
  useEffect(() => {
    if (open) {
      setMode(initialMode ?? 'signin');
      setError(null);
    }
  }, [open, initialMode]);

  const NOT_CONFIGURED =
    'VibeSpace Cloud is not configured in this build. Install the official VibeSpace release, or ask the build maintainer to configure the app backend.';

  function reset() {
    setEmail('');
    setPassword('');
    setBusy(false);
    setError(null);
  }

  async function handleSubmit() {
    setError(null);
    if (!email.trim()) {
      setError('Enter your email to continue.');
      return;
    }
    if (mode !== 'magic' && !password) {
      setError('Enter a password.');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }

    setBusy(true);
    const client = loadSupabaseClient();
    if (!client) {
      setBusy(false);
      setError(NOT_CONFIGURED);
      return;
    }

    try {
      if (mode === 'magic') {
        const { error: e } = await client.auth.signInWithOtp({ email: email.trim() });
        if (e) throw e;
        toast.success('Magic link sent', `Check ${email.trim()} to finish signing in.`);
        onOpenChange(false);
        reset();
      } else if (mode === 'signup') {
        const { data, error: e } = await client.auth.signUp({
          email: email.trim(),
          password,
        });
        if (e) throw e;
        // When email confirmation is required, Supabase returns a user with no
        // active session. Tell the user to confirm; otherwise they're in.
        if (data?.session) {
          toast.success('Account created', 'You are signed in. Cloud sync is enabled.');
        } else {
          toast.success('Check your email', `Confirm ${email.trim()} to finish creating your account.`);
        }
        onOpenChange(false);
        reset();
      } else {
        const { error: e } = await client.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (e) throw e;
        toast.success('Signed in', 'Cloud sync is now enabled.');
        onOpenChange(false);
        reset();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign in failed.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

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
          <DialogTitle>{mode === 'signup' ? 'Create your account' : 'Sign in'}</DialogTitle>
          <DialogDescription>
            {mode === 'signup'
              ? 'Create a Jarvis account to save your workspace and manage your plan across devices.'
              : 'Welcome back. Sign in to access your account, plan, and synced workspace.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5 self-start">
          <ModeButton current={mode} value="signin" onSelect={setMode}>
            Sign in
          </ModeButton>
          <ModeButton current={mode} value="signup" onSelect={setMode}>
            Create account
          </ModeButton>
          <ModeButton current={mode} value="magic" onSelect={setMode}>
            Magic link
          </ModeButton>
        </div>

        <div className="flex flex-col gap-3">
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
                if (e.key === 'Enter' && mode === 'magic') {
                  e.preventDefault();
                  void handleSubmit();
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
                    void handleSubmit();
                  }
                }}
                disabled={busy}
              />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-secondary text-destructive">{error}</p>
            </div>
          )}
        </div>

        <Separator />

        <DialogFooter className="!justify-between sm:!justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="accent" onClick={handleSubmit} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Working...
              </>
            ) : mode === 'magic' ? (
              <>
                <Mail className="h-3.5 w-3.5" />
                Send magic link
              </>
            ) : mode === 'signup' ? (
              <>Create account</>
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

/**
 * Look up the Supabase client through the typed wrapper.
 *
 * The wrapper itself is statically imported across the rest of the
 * cloud-sync code paths (CallService, hosted-tier settings, bridge
 * lifecycle), so going through it here keeps the SignIn flow on the
 * same chunk boundary instead of fighting Vite's chunk consolidation
 * with a redundant dynamic import.
 *
 * Returns `null` when env vars aren't wired up — the dialog falls back
 * to its `setupRequired` state in that case.
 */
function loadSupabaseClient(): SupabaseLikeClient | null {
  try {
    return (getSupabaseClient() as unknown as SupabaseLikeClient | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Minimal structural type covering only the methods this dialog calls.
 * Keeps us decoupled from the @supabase/supabase-js shape until the helper is wired.
 */
type SupabaseLikeClient = {
  auth: {
    signInWithOtp: (opts: { email: string }) => Promise<{ error: { message: string } | null }>;
    signInWithPassword: (opts: {
      email: string;
      password: string;
    }) => Promise<{ error: { message: string } | null }>;
    signUp: (opts: {
      email: string;
      password: string;
    }) => Promise<{ data: { session: unknown | null } | null; error: { message: string } | null }>;
  };
};
