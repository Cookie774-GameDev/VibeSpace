import * as React from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { validatePassword } from '@/features/auth/authValidation';
import { formatAuthError } from '@/features/auth/authErrors';
import { getSupabaseClient } from '@/lib/supabase/client';

export function AccountSecurityPanel({ accountId }: { accountId: string }) {
  const normalizedAccountId = accountId.trim();
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [status, setStatus] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const accountRef = React.useRef(normalizedAccountId);
  const generationRef = React.useRef(0);

  React.useLayoutEffect(() => {
    accountRef.current = normalizedAccountId;
    generationRef.current += 1;
    setPassword('');
    setConfirmation('');
    setBusy(false);
    setStatus(null);
    setError(null);
    return () => {
      accountRef.current = '';
      generationRef.current += 1;
    };
  }, [normalizedAccountId]);

  if (!normalizedAccountId) {
    return (
      <section className="mt-5 rounded-2xl border border-border/70 bg-background/45 p-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-accent-copper" />
          <h3 className="text-ui-strong text-foreground">Account security</h3>
        </div>
        <p className="mt-2 text-secondary text-muted-foreground">
          Sign in to change your cloud account password.
        </p>
      </section>
    );
  }

  async function changePassword() {
    setStatus(null);
    setError(null);
    const validationError = validatePassword(password, 'signup');
    if (validationError) {
      setError(validationError);
      return;
    }
    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }

    const client = getSupabaseClient();
    if (!client) {
      setError('Cloud authentication is not configured in this build.');
      return;
    }

    const operationAccount = normalizedAccountId;
    const operationGeneration = generationRef.current;
    const isCurrentOperation = () =>
      accountRef.current === operationAccount && generationRef.current === operationGeneration;

    setBusy(true);
    try {
      const { error: updateError } = await client.auth.updateUser({ password });
      if (updateError) throw updateError;
      if (!isCurrentOperation()) return;
      setPassword('');
      setConfirmation('');
      setStatus('Password updated.');
      toast.success('Password updated', 'Your new password is active.');
    } catch (caught) {
      if (!isCurrentOperation()) return;
      const message = formatAuthError(caught, 'Could not update your password.');
      setError(message);
      toast.error('Password update failed', message);
    } finally {
      if (isCurrentOperation()) setBusy(false);
    }
  }

  return (
    <section className="mt-5 rounded-2xl border border-border/70 bg-background/45 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-accent-copper" />
        <h3 className="text-ui-strong text-foreground">Account security</h3>
      </div>
      <p className="mt-1 text-metadata text-muted-foreground">
        Change the password for the currently signed-in VibeSpace account.
      </p>
      <div className="mt-4 grid max-w-xl gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-new-password">New account password</Label>
          <Input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-confirm-password">Confirm account password</Label>
          <Input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || !password || !confirmation}
          onClick={() => void changePassword()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Change password
        </Button>
        {status ? (
          <span className="text-metadata text-success" role="status">
            {status}
          </span>
        ) : null}
        {error ? (
          <span className="text-metadata text-destructive" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </section>
  );
}
