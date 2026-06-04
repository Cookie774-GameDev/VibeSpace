import { useState } from 'react';
import { Mail, User2, Cloud, Copy, Check } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { SignInDialog } from '@/features/auth/SignInDialog';

/**
 * Account section - identity, cloud session, and the sign-in entry point.
 * Local-first: localUserId always exists. Cloud is opt-in via Jarvis Cloud.
 */
export function Account() {
  const displayName = useAuthStore((s) => s.displayName);
  const setDisplayName = useAuthStore((s) => s.setDisplayName);
  const localUserId = useAuthStore((s) => s.localUserId);
  const cloudSession = useAuthStore((s) => s.cloudSession);

  const [signInOpen, setSignInOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const cloudEmail = cloudSession?.email;

  function copyId() {
    if (!localUserId) return;
    navigator.clipboard?.writeText(localUserId).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => toast.error('Could not copy', 'Clipboard access was denied.'),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Account</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Local profile and optional cloud sync.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Label htmlFor="acct-name">Display name</Label>
        <div className="flex items-center gap-2 max-w-md">
          <User2 className="h-4 w-4 text-muted-foreground shrink-0" />
          <Input
            id="acct-name"
            placeholder="What should Jarvis call you?"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <p className="text-metadata text-muted-foreground">
          Used in greetings and the persona prompt.
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <Label>Local user ID</Label>
        <div className="flex items-center gap-2 max-w-md">
          <code className="flex-1 px-2.5 h-8 inline-flex items-center rounded-md border border-border bg-muted font-mono text-secondary text-muted-foreground select-all">
            {localUserId ?? 'not assigned'}
          </code>
          <Button
            variant="ghost"
            size="icon"
            onClick={copyId}
            disabled={!localUserId}
            aria-label="Copy local user id"
          >
            {copied ? <Check className="text-success" /> : <Copy />}
          </Button>
        </div>
        <p className="text-metadata text-muted-foreground">
          Generated locally. Used as the owner of your offline data.
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between max-w-md gap-3">
          <div className="flex flex-col gap-1">
            <Label className="flex items-center gap-2">
              <Cloud className="h-3.5 w-3.5" />
              Cloud sync
            </Label>
            <p className="text-metadata text-muted-foreground">
              Optional. Sync history and todos across devices through Jarvis Cloud.
            </p>
          </div>
          {cloudSession ? (
            <Badge variant="success">Signed in</Badge>
          ) : (
            <Badge variant="outline">Local only</Badge>
          )}
        </div>

        {cloudEmail && (
          <div className="flex items-center gap-2 text-secondary text-muted-foreground max-w-md">
            <Mail className="h-3.5 w-3.5" />
            <span>{cloudEmail}</span>
          </div>
        )}

        <div>
          <Button
            variant={cloudSession ? 'outline' : 'accent'}
            size="sm"
            onClick={() => setSignInOpen(true)}
          >
            {cloudSession ? 'Manage session' : 'Sign in to Jarvis Cloud'}
          </Button>
        </div>
      </section>

      <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />
    </div>
  );
}
