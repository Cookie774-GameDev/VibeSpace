import * as React from 'react';
import { ShieldCheck, CreditCard, Activity, Phone, Crown, ExternalLink } from 'lucide-react';
import { Account } from '@/features/settings/sections/Account';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import {
  PLANS,
  effectivePlan,
  isAdminIdentity,
  planAllowsJarvisCall,
  planVoiceQuota,
  type PlanId,
} from '@/lib/entitlements';
import { getCheckoutUrl, isStripeConfigured } from '@/lib/billing/stripe';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';

const UPGRADE_ORDER: PlanId[] = ['starter', 'pro', 'ultra'];

export function AccountPage() {
  const plan = useAuthStore((s) => s.plan);
  const email = useAuthStore((s) => s.email);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email);
  const localUserId = useAuthStore((s) => s.localUserId);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const apiKeys = useAuthStore((s) => s.apiKeys);

  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const activePlanId = effectivePlan(plan, admin);
  const activePlan = PLANS[activePlanId];
  const voiceQuota = planVoiceQuota(activePlanId);
  const jarvisCallEnabled = planAllowsJarvisCall(activePlanId, admin);
  const configuredKeyCount = Object.values(apiKeys).filter(Boolean).length;

  const nextTier = React.useMemo(
    () => UPGRADE_ORDER.find((tier) => PLANS[tier].priceUsd > PLANS[activePlanId].priceUsd),
    [activePlanId],
  );

  const openUpgrade = async () => {
    if (!nextTier) {
      toast.info('Top tier active', 'You already have access to every VibeSpace feature.');
      return;
    }
    const checkoutUrl = getCheckoutUrl(nextTier);
    if (!checkoutUrl) {
      toast.info('Checkout not configured', 'Billing URLs are missing for this build.');
      return;
    }
    try {
      await openExternal(checkoutUrl);
    } catch (err) {
      toast.error('Could not open checkout', err instanceof Error ? err.message : 'Open Stripe manually.');
    }
  };

  return (
    <main className="h-full overflow-y-auto bg-background p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="relative overflow-hidden rounded-3xl border border-border bg-slate-950 p-6 shadow-2xl">
          <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top_right,rgba(168,85,247,0.25),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(6,182,212,0.16),transparent_38%)]" />
          <div className="relative z-10 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent-copper/40 bg-accent-copper/10 px-3 py-1 text-metadata font-semibold uppercase tracking-[0.2em] text-accent-copper">
                <ShieldCheck className="h-3.5 w-3.5" />
                Account Center
              </div>
              <h1 className="font-display text-hero text-white">VibeSpace account</h1>
              <p className="mt-2 max-w-2xl text-secondary leading-relaxed text-slate-300">
                Sign in, review billing and usage, and verify admin access from one production surface.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-purple-500/40 bg-purple-500/15 text-purple-200">
                <Crown className="mr-1 h-3.5 w-3.5" />
                {activePlan.label}
              </Badge>
              {admin && <Badge variant="success">Admin access</Badge>}
            </div>
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className="rounded-3xl border border-border bg-panel p-5 shadow-soft">
            <Account />
          </section>

          <aside className="flex flex-col gap-5">
            <section className="rounded-3xl border border-border bg-elevated p-5 shadow-soft">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-page-title text-foreground">Billing</h2>
                  <p className="mt-1 text-secondary text-muted-foreground">
                    Current access and upgrade controls.
                  </p>
                </div>
                <CreditCard className="h-5 w-5 text-accent-copper" />
              </div>

              <div className="rounded-2xl border border-border/70 bg-background/60 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-ui-strong text-foreground">{activePlan.label}</p>
                    <p className="mt-1 text-metadata text-muted-foreground">{activePlan.tagline}</p>
                  </div>
                  <Badge variant={admin ? 'success' : 'outline'}>
                    {admin ? 'Admin unlocked' : `$${activePlan.priceUsd}/mo`}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant="accent"
                  size="sm"
                  className="mt-4 w-full"
                  onClick={openUpgrade}
                  disabled={!nextTier || (!isStripeConfigured() && !admin)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {nextTier ? `Upgrade to ${PLANS[nextTier].label}` : 'All features active'}
                </Button>
              </div>
            </section>

            <section className="rounded-3xl border border-border bg-elevated p-5 shadow-soft">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-page-title text-foreground">Usage</h2>
                  <p className="mt-1 text-secondary text-muted-foreground">
                    Local account summary for linked providers and voice access.
                  </p>
                </div>
                <Activity className="h-5 w-5 text-accent-cyan" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <UsageCard label="Default provider" value={defaultProvider} />
                <UsageCard label="Linked API keys" value={String(configuredKeyCount)} />
                <UsageCard label="Voice quota" value={Number.isFinite(voiceQuota) ? `${voiceQuota} min/mo` : 'Unlimited'} />
                <UsageCard label="Jarvis Call" value={jarvisCallEnabled ? 'Enabled' : 'Plan required'} icon={<Phone className="h-3.5 w-3.5" />} />
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}

function UsageCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/55 p-3">
      <p className="flex items-center gap-1.5 text-metadata uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </p>
      <p className="mt-2 text-ui-strong text-foreground">{value}</p>
    </div>
  );
}
