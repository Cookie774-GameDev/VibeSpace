/**
 * Admin — visible only when `useAppAdmin()` is true (env allowlist or
 * Supabase `app_admins` row). Summarizes unlimited access and how to manage
 * the server-side admin list.
 */
import { Shield, Infinity, Cloud, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useAppAdmin, fetchCloudAdminStatus } from '@/lib/admin';
import { useAuthStore } from '@/stores/auth';
import { useEffect, useState } from 'react';
import { effectivePlan } from '@/lib/entitlements';

export function Admin() {
  const admin = useAppAdmin();
  const plan = useAuthStore((s) => s.plan);
  const cloudUserId = useAuthStore((s) => s.cloudSession?.user_id);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email);
  const [cloudListed, setCloudListed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!cloudUserId) {
      setCloudListed(null);
      return;
    }
    void fetchCloudAdminStatus(cloudUserId).then(setCloudListed);
  }, [cloudUserId]);

  if (!admin) {
    return (
      <p className="text-secondary text-muted-foreground">
        Admin tools are not available for this account.
      </p>
    );
  }

  const activePlan = effectivePlan(plan, true);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-accent-cyan" />
          <h2 className="text-ui-strong text-foreground">Admin access</h2>
          <Badge variant="outline" className="border-accent-cyan/40 text-accent-cyan">
            Active
          </Badge>
        </div>
        <p className="mt-2 text-secondary text-muted-foreground">
          You have full Jarvis access — no plan paywalls, unlimited cloud voice budget when
          signed in, and all premium features unlocked.
        </p>
      </div>

      <div className="rounded-md border border-border bg-panel p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-foreground">
          <Infinity className="h-4 w-4 text-accent-cyan" />
          <span className="text-ui-strong">Effective plan</span>
          <Badge>{activePlan}</Badge>
        </div>
        <ul className="text-secondary text-muted-foreground list-disc pl-5 space-y-1">
          <li>System voice and cloud TTS without quota blocks</li>
          <li>Phone Jarvis and hosted features per your entitlements config</li>
          <li>Deepgram BYOK in Settings → Voice uses your own API credits</li>
        </ul>
      </div>

      <Separator />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          <span className="text-ui-strong text-foreground">Supabase admin list</span>
        </div>
        <p className="text-secondary text-muted-foreground">
          Server-side admins live in the <code className="text-foreground">app_admins</code> table.
          Rows are checked via the <code className="text-foreground">is_app_admin</code> RPC when you
          sign in with cloud sync.
        </p>
        {cloudUserId ? (
          <p className="text-metadata text-muted-foreground">
            Signed in as {cloudEmail ?? cloudUserId}
            {cloudListed === true ? ' · listed in app_admins' : cloudListed === false ? ' · env/local admin only' : ''}
          </p>
        ) : (
          <p className="text-metadata text-muted-foreground">
            Sign in with cloud sync to use the Supabase admin list, or rely on env admin emails /
            IDs.
          </p>
        )}
        <p className="text-metadata text-muted-foreground">
          To add someone in Supabase SQL:{' '}
          <code className="block mt-1 rounded bg-muted px-2 py-1 text-foreground text-xs">
            insert into public.app_admins (user_id) select id from auth.users where email =
            &apos;you@example.com&apos;;
          </code>
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <span className="text-ui-strong text-foreground">Deepgram voice</span>
        </div>
        <p className="text-secondary text-muted-foreground">
          Paste your Deepgram API key under Settings → Voice → Deepgram. Jarvis speaks through Aura
          voices using your account credits; the key stays in the OS keychain.
        </p>
      </div>
    </div>
  );
}
