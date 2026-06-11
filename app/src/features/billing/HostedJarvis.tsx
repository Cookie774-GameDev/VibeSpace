import { useEffect, useState } from 'react';
import {
  Cloud,
  Loader2,
  Mail,
  LogOut,
  Zap,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabaseClient, type TypedSupabaseClient } from '@/lib/supabase/client';
import type { Profile, Tier } from '@/lib/supabase/types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/**
 * Settings panel for the hosted $5/month Jarvis tier. The integrator wires
 * this into the SettingsModal alongside Account, Providers, etc.
 *
 * Local-first contract: if the app backend env vars aren't wired, render a
 * maintainer-facing setup card rather than blowing up.
 */

function readEnv(key: string): string | undefined {
  try {
    return (import.meta.env as unknown as Record<string, string | undefined>)[key];
  } catch {
    return undefined;
  }
}

const STRIPE_URL = readEnv('VITE_STRIPE_CHECKOUT_URL');

// Labels + descriptions for every tier in the `Tier` union. The set
// expanded when the Stripe billing migration added paid sub-tiers
// (starter / pro / ultra); keeping the records exhaustive here keeps
// `Record<Tier, string>` honest. The original 'plus' tier survives as
// the legacy hosted-proxy plan so existing subscribers don't lose
// their label.
const TIER_LABELS: Record<Tier, string> = {
  free: 'Free',
  starter: 'Starter',
  plus: 'Plus',
  pro: 'Pro',
  ultra: 'Ultra',
  'byok-only': 'BYOK only',
};

const TIER_DESCRIPTIONS: Record<Tier, string> = {
  free: 'Up to 50 hosted requests this month.',
  starter: 'Entry paid tier — modest hosted quota.',
  plus: '$5/month. Up to 1,500 hosted requests.',
  pro: 'Professional tier — bumped quota + priority routing.',
  ultra: 'Ultra tier — highest quota, fastest routing.',
  'byok-only': 'Hosted proxy off. Requests use your own API keys.',
};

export function HostedJarvis() {
  const client = getSupabaseClient();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Hosted Jarvis</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Optional. Skip API key management - run requests through our hosted
          DeepSeek proxy for $5/month. BYOK still works in parallel.
        </p>
      </header>

      {!client ? <SetupCard /> : <Panel client={client} />}
    </div>
  );
}

function SetupCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-ui-strong">
          <Cloud className="h-4 w-4 text-accent-cyan" />
          Hosted Jarvis isn&apos;t available in this build
        </CardTitle>
        <CardDescription>
          Official VibeSpace releases include the app backend configuration.
          This build is missing it, so Jarvis stays local-only with BYOK keys.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-secondary">
        <p className="text-metadata text-muted-foreground mt-2">
          Maintainers building from source should set the Jarvis app Supabase URL and anon key
          at build time. End users should not create or connect their own Supabase project.
        </p>
      </CardContent>
    </Card>
  );
}

function Panel({ client }: { client: TypedSupabaseClient }) {
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [usage, setUsage] = useState<number>(0);
  const [refreshing, setRefreshing] = useState(false);

  // Subscribe to auth state changes so the panel reacts to sign-in/out
  // performed elsewhere in the app (e.g. existing SignInDialog).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data } = await client.auth.getSession();
      if (cancelled) return;
      setSession(data.session);
      setLoading(false);
    })();

    const sub = client.auth.onAuthStateChange((_event, s) => {
      if (cancelled) return;
      setSession(s);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      sub.data.subscription.unsubscribe();
    };
  }, [client]);

  // Reload profile + usage whenever the session changes.
  useEffect(() => {
    if (!session) {
      setProfile(null);
      setUsage(0);
      return;
    }

    let cancelled = false;
    setRefreshing(true);

    (async () => {
      const [p, u] = await Promise.all([
        loadOrCreateProfile(client, session),
        loadUsage(client, session.user.id),
      ]);
      if (cancelled) return;
      setProfile(p);
      setUsage(u);
      setRefreshing(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [client, session]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-secondary text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading session...
      </div>
    );
  }

  if (!session) {
    return <SignInCard client={client} />;
  }

  return (
    <SignedInPanel
      client={client}
      user={session.user}
      profile={profile}
      usage={usage}
      refreshing={refreshing}
      onProfileChange={setProfile}
    />
  );
}

function SignInCard({ client }: { client: TypedSupabaseClient }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    const trimmed = email.trim();
    if (!trimmed) {
      toast.warning('Email required', 'Enter your email to receive a magic link.');
      return;
    }
    setBusy(true);
    const { error } = await client.auth.signInWithOtp({ email: trimmed });
    setBusy(false);
    if (error) {
      toast.error('Sign in failed', error.message);
      return;
    }
    toast.success('Magic link sent', `Check ${trimmed} to finish signing in.`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to VibeSpace Cloud</CardTitle>
        <CardDescription>
          We&apos;ll email a single-use magic link. No password needed.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hosted-email">Email</Label>
          <Input
            id="hosted-email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void send();
              }
            }}
            disabled={busy}
          />
        </div>
        <div>
          <Button variant="accent" size="sm" onClick={send} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working...
              </>
            ) : (
              <>
                <Mail className="h-3.5 w-3.5" /> Send magic link
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface SignedInProps {
  client: TypedSupabaseClient;
  user: User;
  profile: Profile | null;
  usage: number;
  refreshing: boolean;
  onProfileChange: (p: Profile | null) => void;
}

function SignedInPanel({
  client,
  user,
  profile,
  usage,
  refreshing,
  onProfileChange,
}: SignedInProps) {
  const tier: Tier = profile?.tier ?? 'free';
  const quota = profile?.monthly_quota ?? 50;
  const isBYOK = tier === 'byok-only';
  const isPlus = tier === 'plus';
  const usagePct = isBYOK
    ? 0
    : Math.min(100, Math.round((usage / Math.max(1, quota)) * 100));

  const [toggling, setToggling] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function toggleBYOK(on: boolean) {
    if (!profile) return;
    setToggling(true);
    const newTier: Tier = on ? 'byok-only' : 'free';
    // Switching off BYOK drops to free quota. Re-upgrade to Plus if desired.
    const newQuota = on ? profile.monthly_quota : 50;
    const { data, error } = await client
      .from('profiles')
      .update({ tier: newTier, monthly_quota: newQuota })
      .eq('id', user.id)
      .select()
      .single();
    setToggling(false);
    if (error) {
      toast.error('Could not update', error.message);
      return;
    }
    onProfileChange(data);
    toast.success(
      on ? 'BYOK only mode enabled' : 'Hosted proxy re-enabled',
      on
        ? 'Requests will use your own API keys from Providers.'
        : 'Welcome back to the hosted tier.',
    );
  }

  function handleUpgrade() {
    if (STRIPE_URL) {
      window.open(STRIPE_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    // eslint-disable-next-line no-console
    console.warn('[hosted-jarvis] VITE_STRIPE_CHECKOUT_URL not set');
    toast.info(
      'Stripe checkout coming soon',
      'Once billing is wired, this button starts your subscription.',
    );
  }

  async function handleSignOut() {
    setSigningOut(true);
    const { error } = await client.auth.signOut();
    setSigningOut(false);
    if (error) {
      toast.error('Sign out failed', error.message);
      return;
    }
    toast.success('Signed out');
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Label>Tier</Label>
            <p className="text-metadata text-muted-foreground">
              {TIER_DESCRIPTIONS[tier]}
            </p>
          </div>
          <Badge variant={isPlus ? 'accent' : isBYOK ? 'outline' : 'secondary'}>
            {TIER_LABELS[tier]}
          </Badge>
        </div>

        {!isBYOK && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-secondary text-muted-foreground">
              <span>Used this month</span>
              <span className="font-mono">
                {refreshing ? '...' : `${usage} / ${quota}`}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={usagePct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Hosted usage this month"
            >
              <div
                className={cn(
                  'h-full transition-all',
                  usagePct >= 90 ? 'bg-warning' : 'bg-accent-gradient',
                )}
                style={{ width: `${usagePct}%` }}
              />
            </div>
          </div>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <Label>Plus subscription</Label>
        {isPlus ? (
          <div className="flex items-center gap-2 text-secondary text-success">
            <Sparkles className="h-4 w-4" />
            You&apos;re on Plus. Thanks for supporting Jarvis.
          </div>
        ) : (
          <>
            <p className="text-metadata text-muted-foreground">
              Bumps your monthly quota from 50 to 1,500 hosted requests.
              Cancel any time.
            </p>
            <div>
              <Button variant="accent" size="sm" onClick={handleUpgrade}>
                <Zap className="h-3.5 w-3.5" />
                Upgrade to Plus ($5/month)
                {STRIPE_URL && <ExternalLink className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3 max-w-xl">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="byok-toggle">BYOK only</Label>
            <p className="text-metadata text-muted-foreground">
              Skip the hosted proxy. Requests use the keys you saved in
              Providers.{isPlus && ' Toggling on ends Plus benefits.'}
            </p>
          </div>
          <Switch
            id="byok-toggle"
            checked={isBYOK}
            onCheckedChange={toggleBYOK}
            disabled={toggling || !profile}
            aria-label="BYOK only mode"
          />
        </div>
      </section>

      <Separator />

      <section className="flex items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-secondary text-muted-foreground">Signed in as</span>
          <span className="text-ui-strong text-foreground truncate">
            {user.email ?? user.id}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          disabled={signingOut}
        >
          {signingOut ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogOut className="h-3.5 w-3.5" />
          )}
          Sign out
        </Button>
      </section>
    </div>
  );
}

async function loadOrCreateProfile(
  client: TypedSupabaseClient,
  session: Session,
): Promise<Profile | null> {
  const { user } = session;
  const { data: existing, error: selErr } = await client
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (selErr) {
    // eslint-disable-next-line no-console
    console.warn('[hosted-jarvis] profile fetch failed', selErr);
    return null;
  }
  if (existing) return existing;

  const { data: created, error: insErr } = await client
    .from('profiles')
    .insert({
      id: user.id,
      email: user.email ?? null,
      tier: 'free',
      monthly_quota: 50,
    })
    .select()
    .single();
  if (insErr) {
    // eslint-disable-next-line no-console
    console.warn('[hosted-jarvis] profile create failed', insErr);
    return null;
  }
  return created;
}

async function loadUsage(
  client: TypedSupabaseClient,
  userId: string,
): Promise<number> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count, error } = await client
    .from('usage_log')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'ok')
    .gte('ts', monthStart.toISOString());
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[hosted-jarvis] usage fetch failed', error);
    return 0;
  }
  return count ?? 0;
}
