import { useState, type ReactNode } from 'react';
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

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Mode = 'magic' | 'password';

/**
 * Lightweight Supabase sign-in form. Two modes:
 *   - magic: email-only, calls signInWithOtp
 *   - password: email + password
 *
 * Gracefully degrades when the Supabase client isn't configured.
 */
export function SignInDialog({ open, onOpenChange }: SignInDialogProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('magic');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const NOT_CONFIGURED =
    'Cloud sync not configured. Add Supabase URL + key in .env.local to enable.';

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
    if (mode === 'password' && !password) {
      setError('Enter a password.');
      return;
    }

    setBusy(true);
    const client = await loadSupabaseClient();
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
          <DialogTitle>Sign in to Jarvis Cloud</DialogTitle>
          <DialogDescription>
            Optional. Enables sync across devices via Supabase. You can keep using Jarvis fully
            offline without it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5 self-start">
          <ModeButton current={mode} value="magic" onSelect={setMode}>
            Magic link
          </ModeButton>
          <ModeButton current={mode} value="password" onSelect={setMode}>
            Password
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

          {mode === 'password' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signin-password">Password</Label>
              <Input
                id="signin-password"
                type="password"
                autoComplete="current-password"
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
 * Lazily load the Supabase client. Returns `null` if the helper module or
 * env vars haven't been wired yet.
 *
 * The dynamic `import()` is wrapped in try/catch so the bundler doesn't
 * blow up in scaffolds where `@/lib/supabase` hasn't been created yet.
 */
async function loadSupabaseClient(): Promise<SupabaseLikeClient | null> {
  try {
    // @ts-ignore - optional module, may not exist during early scaffolding
    const mod: { getSupabaseClient?: () => SupabaseLikeClient | null } = await import(
      '@/lib/supabase'
    );
    return mod.getSupabaseClient?.() ?? null;
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
  };
};
