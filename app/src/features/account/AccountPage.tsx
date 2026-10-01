import * as React from 'react';
import {
  ShieldCheck,
  CreditCard,
  Activity,
  Phone,
  Crown,
  ExternalLink,
  MessageSquare,
  Smartphone,
  RefreshCw,
  Loader2,
  KeyRound,
  User2,
  LifeBuoy,
  BookOpen,
  Mail,
  MessageCircle,
  Download,
  ScrollText,
  Sparkles,
  Cat,
} from 'lucide-react';
import { Account } from '@/features/settings/sections/Account';
import { PetAccountPanel } from '@/features/pets/PetAccountPanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/stores/auth';
import { PLANS, PLAN_ORDER, effectivePlan, type PlanId } from '@/lib/entitlements';
import { useAppAdmin } from '@/lib/admin';
import {
  callCheckoutSession,
  callCustomerPortal,
  isBackendBillingConfigured,
} from '@/lib/billing/checkout';
import {
  CREDITS_PER_PHONE_MINUTE,
  CREDITS_PER_SMS,
  formatUsageResetDate,
  getCombinedUsage,
  unifiedCreditCopy,
  unifiedCreditsFromCombined,
  usagePercent,
  type BillingPlanId,
  type CombinedUsage,
} from '@/features/billing/planLimits';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  ACCOUNT_TABS,
  resolveAccountTab,
  resolveAccountTabFromSearch,
  type AccountTabId,
} from './accountTabs';
import { AccountSecurityPanel } from './AccountSecurityPanel';
import './sakura-account.css';

const UPGRADE_ORDER: PlanId[] = ['starter', 'pro', 'ultra', 'apex'];

const TAB_ICONS: Record<AccountTabId, React.ReactNode> = {
  profile: <User2 className="h-3.5 w-3.5" />,
  usage: <Activity className="h-3.5 w-3.5" />,
  billing: <CreditCard className="h-3.5 w-3.5" />,
  pets: <Cat className="h-3.5 w-3.5" />,
  support: <LifeBuoy className="h-3.5 w-3.5" />,
};

export function AccountPage() {
  const plan = useAuthStore((s) => s.plan);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email);
  const cloudUserId = useAuthStore((s) => s.cloudSession?.user_id);
  const localUserId = useAuthStore((s) => s.localUserId);
  const displayName = useAuthStore((s) => s.displayName);
  const defaultProvider = useAuthStore((s) => s.defaultProvider);
  const apiKeys = useAuthStore((s) => s.apiKeys);

  const admin = useAppAdmin();
  const activePlanId = effectivePlan(plan, admin);
  const activePlan = PLANS[activePlanId];
  const configuredKeyCount = Object.values(apiKeys).filter(Boolean).length;

  const [tab, setTab] = React.useState<AccountTabId>(() =>
    resolveAccountTabFromSearch(window.location.search),
  );
  const [usage, setUsage] = React.useState<CombinedUsage | null>(null);
  const [usageLoading, setUsageLoading] = React.useState(false);
  const [usageError, setUsageError] = React.useState<string | null>(null);
  const accountRef = React.useRef(cloudUserId?.trim() ?? '');
  const accountGeneration = React.useRef(0);

  React.useLayoutEffect(() => {
    accountRef.current = cloudUserId?.trim() ?? '';
    accountGeneration.current += 1;
    setUsage(null);
    setUsageError(null);
    setUsageLoading(Boolean(accountRef.current));
  }, [cloudUserId]);

  const loadUsage = React.useCallback(async () => {
    const operationAccount = cloudUserId?.trim() ?? '';
    if (!operationAccount) {
      setUsage(null);
      setUsageError(null);
      setUsageLoading(false);
      return;
    }
    const operationGeneration = accountGeneration.current;
    const isCurrentOperation = () =>
      accountRef.current === operationAccount &&
      accountGeneration.current === operationGeneration &&
      (useAuthStore.getState().cloudSession?.user_id.trim() ?? '') === operationAccount;
    setUsageLoading(true);
    setUsageError(null);
    try {
      const data = await getCombinedUsage();
      if (!isCurrentOperation()) return;
      if (!data) {
        setUsage(null);
        setUsageError('Could not load usage. Check your connection and try again.');
      } else {
        setUsage(data);
      }
    } catch {
      if (!isCurrentOperation()) return;
      setUsage(null);
      setUsageError('Could not load usage. Try again in a moment.');
    } finally {
      if (isCurrentOperation()) setUsageLoading(false);
    }
  }, [cloudUserId]);

  React.useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  // Prefetch usage when opening the Usage tab.
  React.useEffect(() => {
    if (tab === 'usage') void loadUsage();
  }, [tab, loadUsage]);

  const nextTier = React.useMemo(
    () => UPGRADE_ORDER.find((tier) => PLANS[tier].priceUsd > PLANS[activePlanId].priceUsd),
    [activePlanId],
  );

  const openUpgrade = async (tier?: PlanId) => {
    const target = tier ?? nextTier;
    if (!target) {
      toast.info('Top tier active', 'You already have access to every VibeSpace feature.');
      return;
    }
    if (!cloudUserId) {
      toast.info('Sign in required', 'Sign in with a cloud account before upgrading.');
      setTab('profile');
      return;
    }
    if (!isBackendBillingConfigured()) {
      toast.info(
        'Checkout not configured',
        'Supabase billing functions are missing for this build.',
      );
      return;
    }
    const operationAccount = cloudUserId.trim();
    const operationGeneration = accountGeneration.current;
    const isCurrentOperation = () =>
      accountRef.current === operationAccount &&
      accountGeneration.current === operationGeneration &&
      (useAuthStore.getState().cloudSession?.user_id.trim() ?? '') === operationAccount;
    const result = await callCheckoutSession(target);
    if (!isCurrentOperation()) return;
    if (!result.ok) {
      toast.error('Checkout unavailable', result.error);
      return;
    }
    try {
      await openExternal(result.url);
    } catch (err) {
      if (!isCurrentOperation()) return;
      toast.error(
        'Could not open checkout',
        err instanceof Error ? err.message : 'Open Stripe manually.',
      );
    }
  };

  const openPortal = async () => {
    if (!cloudUserId) {
      toast.info('Sign in required', 'Sign in to manage billing in Stripe.');
      setTab('profile');
      return;
    }
    const operationAccount = cloudUserId.trim();
    const operationGeneration = accountGeneration.current;
    const isCurrentOperation = () =>
      accountRef.current === operationAccount &&
      accountGeneration.current === operationGeneration &&
      (useAuthStore.getState().cloudSession?.user_id.trim() ?? '') === operationAccount;
    const result = await callCustomerPortal();
    if (!isCurrentOperation()) return;
    if (!result.ok) {
      toast.error('Billing portal unavailable', result.error);
      return;
    }
    try {
      await openExternal(result.url);
    } catch (err) {
      if (!isCurrentOperation()) return;
      toast.error('Could not open portal', err instanceof Error ? err.message : 'Try again.');
    }
  };

  const usagePlan = (usage?.plan as BillingPlanId | undefined) ?? (activePlanId as BillingPlanId);
  const resetLabel = formatUsageResetDate(usage?.reset_date);
  const who = displayName?.trim() || cloudEmail || 'You';

  return (
    <main
      className="mc7f-account-page h-full overflow-y-auto bg-background [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none"
      data-warm-account-tab={tab}
    >
      <div
        className="relative mx-auto flex w-full max-w-6xl flex-col gap-0 overflow-hidden px-4 pb-10 pt-5 sm:px-6"
        data-warm-surface="account-scene-shell"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 hidden [html[data-theme=warm]_&]:block"
          data-warm-decoration="account-shared-scene"
        >
          <img
            src="/assets/themes/warm/account-center/account-lake-panorama-v3-extended-selected.webp"
            alt=""
            decoding="async"
            draggable={false}
          />
        </div>
        {/* Hero */}
        <header
          className="relative overflow-hidden rounded-3xl border border-border bg-slate-950 p-5 shadow-2xl sm:p-6 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/60 [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:shadow-none"
          data-sakura-surface="account-hero"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(217,119,87,0.22),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(6,182,212,0.14),transparent_40%)] [html[data-theme=monochrome]_&]:hidden" />
          <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-accent-copper/40 bg-accent-copper/10 px-3 py-1 text-metadata font-semibold uppercase tracking-[0.18em] text-accent-copper">
                <ShieldCheck className="h-3.5 w-3.5" />
                Account Center
              </div>
              <h1 className="font-display text-hero truncate text-white">Hey, {who}</h1>
              <p className="mt-1.5 max-w-2xl text-secondary leading-relaxed text-slate-300">
                Manage your profile, live usage, plan, and support — all in one place.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-accent-copper/35 bg-accent-copper/15 text-accent-copper">
                <Crown className="mr-1 h-3.5 w-3.5" />
                {activePlan.label}
              </Badge>
              {cloudUserId ? (
                <Badge variant="success">Signed in</Badge>
              ) : (
                <Badge variant="outline" className="border-white/20 text-slate-200">
                  Signed out
                </Badge>
              )}
              {admin && <Badge variant="success">Admin</Badge>}
            </div>
          </div>
        </header>

        {/* Tabs shell */}
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(resolveAccountTab(v))}
          className="mt-5 flex flex-col gap-4"
        >
          <div className="sticky top-0 z-20 -mx-1 overflow-x-auto px-1 pb-1">
            <TabsList
              data-sakura-surface="account-tabs"
              className={cn(
                'flex h-auto w-full min-w-max items-stretch gap-1 rounded-2xl border border-border/80',
                'bg-panel/90 p-1.5 shadow-soft backdrop-blur-md [html[data-theme=monochrome]_&]:backdrop-blur-none',
              )}
            >
              {ACCOUNT_TABS.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className={cn(
                    'flex-1 gap-1.5 rounded-xl px-3.5 py-2.5 text-secondary',
                    'data-[state=active]:bg-elevated data-[state=active]:text-foreground',
                    'data-[state=active]:shadow-sm data-[state=active]:ring-1 data-[state=active]:ring-accent-copper/30',
                  )}
                >
                  {TAB_ICONS[t.id]}
                  <span>{t.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="profile" className="mt-0 focus-visible:ring-0">
            <PanelCard
              title="Profile"
              subtitle="Edit how Jarvis addresses you, preview your avatar, and manage cloud sign-in."
              icon={<User2 className="h-5 w-5 text-accent-copper" />}
              warmSurface="profile"
            >
              <Account profileOnly />
              <AccountSecurityPanel
                key={cloudUserId?.trim() || 'signed-out'}
                accountId={cloudUserId?.trim() ?? ''}
              />
            </PanelCard>
          </TabsContent>

          <TabsContent value="usage" className="mt-0 focus-visible:ring-0">
            <PanelCard
              title="Usage"
              subtitle="One shared credit pool for DeepSeek chat, phone calls, and SMS."
              icon={<Activity className="h-5 w-5 text-accent-cyan" />}
              action={
                cloudUserId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadUsage()}
                    disabled={usageLoading}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', usageLoading && 'animate-spin')} />
                    Refresh
                  </Button>
                ) : null
              }
            >
              {!cloudUserId ? (
                <EmptyState
                  title="Sign in to view usage"
                  body="Your shared company credit pool appears after you sign in with a cloud account."
                  cta={
                    <Button
                      type="button"
                      variant="accent"
                      size="sm"
                      onClick={() => setTab('profile')}
                    >
                      Go to Profile
                    </Button>
                  }
                />
              ) : usageLoading && !usage ? (
                <div
                  className="flex items-center justify-center gap-2 py-14 text-muted-foreground"
                  data-sakura-state="loading"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-secondary">Loading usage…</span>
                </div>
              ) : usageError && !usage ? (
                <div
                  className="rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-4"
                  data-sakura-state="error"
                >
                  <p className="text-sm text-foreground">{usageError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => void loadUsage()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  {usage?.admin_unlimited && (
                    <Badge variant="success" className="w-fit">
                      Admin unlimited
                    </Badge>
                  )}
                  <UnifiedUsageBar
                    pool={unifiedCreditsFromCombined(usage)}
                    plan={usagePlan}
                    adminUnlimited={Boolean(usage?.admin_unlimited)}
                  />
                  <p className="text-metadata text-muted-foreground">
                    Plan: <span className="text-foreground/90">{usagePlan}</span>
                    {resetLabel ? ` · Resets ${resetLabel}` : null}
                    {usageError ? ' · Showing last loaded data' : null}
                  </p>
                  <div className="grid gap-2 border-t border-border/60 pt-4 sm:grid-cols-2">
                    <LocalChip
                      icon={<KeyRound className="h-3.5 w-3.5" />}
                      label="This device · API keys"
                      value={String(configuredKeyCount)}
                    />
                    <LocalChip
                      icon={<Activity className="h-3.5 w-3.5" />}
                      label="This device · Default provider"
                      value={defaultProvider}
                    />
                  </div>
                </div>
              )}
            </PanelCard>
          </TabsContent>

          <TabsContent value="billing" className="mt-0 focus-visible:ring-0">
            <PanelCard
              title="Billing & plans"
              subtitle="Your current tier, upgrades, and Stripe customer portal."
              icon={<CreditCard className="h-5 w-5 text-accent-copper" />}
            >
              <div className="flex flex-col gap-4">
                <div
                  className="rounded-2xl border border-border/70 bg-background/60 p-4"
                  data-sakura-surface="dense"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-ui-strong text-foreground">{activePlan.label}</p>
                      <p className="mt-1 text-metadata text-muted-foreground">
                        {activePlan.tagline}
                      </p>
                      <p className="mt-2 text-secondary text-muted-foreground">
                        {admin
                          ? 'Admin access unlocks paid capabilities on this device.'
                          : `$${activePlan.priceUsd}/mo · DeepSeek, phone, Deepgram voice, and SMS budgets reset monthly.`}
                      </p>
                    </div>
                    <Badge variant={admin ? 'success' : 'outline'}>
                      {admin ? 'Admin unlocked' : `$${activePlan.priceUsd}/mo`}
                    </Badge>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="accent"
                      size="sm"
                      onClick={() => void openUpgrade()}
                      disabled={!nextTier || (!isBackendBillingConfigured() && !admin)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {nextTier ? `Upgrade to ${PLANS[nextTier].label}` : 'All features active'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void openPortal()}
                    >
                      Manage subscription
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {PLAN_ORDER.filter((id) => id !== 'free').map((id) => {
                    const p = PLANS[id];
                    const current = id === activePlanId;
                    return (
                      <div
                        key={id}
                        className={cn(
                          'rounded-2xl border p-4 transition-colors',
                          current
                            ? 'border-accent-copper/45 bg-accent-copper/10 shadow-soft'
                            : 'border-border/70 bg-background/45 hover:bg-background/70',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-ui-strong text-foreground">{p.label}</p>
                          <span className="text-metadata text-muted-foreground">
                            ${p.priceUsd}/mo
                          </span>
                        </div>
                        <p className="mt-1 text-metadata text-muted-foreground">{p.tagline}</p>
                        {current ? (
                          <Badge variant="success" className="mt-3">
                            Current plan
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-3"
                            onClick={() => void openUpgrade(id)}
                          >
                            Choose {p.label}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </PanelCard>
          </TabsContent>

          <TabsContent value="pets" className="mt-0 focus-visible:ring-0">
            <PanelCard
              title="Pets"
              subtitle="Your desktop companion — show, hide, and learn how to use the mini panel."
              icon={<Cat className="h-5 w-5 text-accent-copper" />}
            >
              <PetAccountPanel />
            </PanelCard>
          </TabsContent>

          <TabsContent value="support" className="mt-0 focus-visible:ring-0">
            <PanelCard
              title="Support"
              subtitle="Help, docs, downloads, and device details for this install."
              icon={<LifeBuoy className="h-5 w-5 text-sky-400" />}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <SupportCard
                  icon={<Mail className="h-4 w-4" />}
                  title="Email support"
                  body="Reach us at support@vibespaceos.com for account or billing questions."
                  actionLabel="Copy email"
                  onAction={async () => {
                    try {
                      await navigator.clipboard.writeText('support@vibespaceos.com');
                      toast.success('Copied', 'support@vibespaceos.com');
                    } catch {
                      toast.info('Email', 'support@vibespaceos.com');
                    }
                  }}
                />
                <SupportCard
                  icon={<MessageCircle className="h-4 w-4" />}
                  title="Security reports"
                  body="Please do not open public issues for security bugs. Email security@vibespaceos.com."
                  actionLabel="Copy security email"
                  onAction={async () => {
                    try {
                      await navigator.clipboard.writeText('security@vibespaceos.com');
                      toast.success('Copied', 'security@vibespaceos.com');
                    } catch {
                      toast.info('Email', 'security@vibespaceos.com');
                    }
                  }}
                />
                <SupportCard
                  icon={<BookOpen className="h-4 w-4" />}
                  title="Documentation"
                  body="Setup guides, plan reference, and product docs on GitHub."
                  actionLabel="Open docs"
                  onAction={() =>
                    void openExternal('https://github.com/Cookie774-GameDev/VibeSpace#readme')
                  }
                />
                <SupportCard
                  icon={<Sparkles className="h-4 w-4" />}
                  title="Usage & plans"
                  body="Check live DeepSeek / phone / SMS meters, or upgrade your tier."
                  actionLabel="Open usage"
                  onAction={() => setTab('usage')}
                />
                <LinkRow
                  icon={<Download className="h-4 w-4" />}
                  title="Downloads"
                  body="Get the latest VibeSpace installer."
                  href="https://github.com/Cookie774-GameDev/VibeSpace/blob/main/DOWNLOAD.md"
                />
                <LinkRow
                  icon={<ScrollText className="h-4 w-4" />}
                  title="License"
                  body="Open-source license for this project."
                  href="https://github.com/Cookie774-GameDev/VibeSpace/blob/main/LICENSE"
                />
                <LocalChip
                  icon={<KeyRound className="h-3.5 w-3.5" />}
                  label="Local user id"
                  value={localUserId ?? 'not assigned'}
                />
                <LocalChip
                  icon={<Activity className="h-3.5 w-3.5" />}
                  label="Default provider"
                  value={defaultProvider}
                />
                <LocalChip
                  icon={<User2 className="h-3.5 w-3.5" />}
                  label="Display name"
                  value={displayName?.trim() || 'Not set'}
                />
                <LocalChip
                  icon={<Mail className="h-3.5 w-3.5" />}
                  label="Cloud email"
                  value={cloudEmail ?? 'Not signed in'}
                />
              </div>
            </PanelCard>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function PanelCard({
  title,
  subtitle,
  icon,
  action,
  warmSurface,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  warmSurface?: 'profile';
  children: React.ReactNode;
}) {
  return (
    <section
      className="sakura-account-panel rounded-3xl border border-border bg-panel p-5 shadow-soft sm:p-6"
      data-warm-surface={warmSurface}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/70 bg-elevated">
            {icon}
          </div>
          <div className="min-w-0">
            <h2 className="text-page-title text-foreground">{title}</h2>
            <p className="mt-1 text-secondary text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ title, body, cta }: { title: string; body: string; cta?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/80 bg-background/40 px-5 py-10 text-center">
      <p className="text-ui-strong text-foreground">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-secondary text-muted-foreground">{body}</p>
      {cta ? <div className="mt-4 flex justify-center">{cta}</div> : null}
    </div>
  );
}

function SupportCard({
  icon,
  title,
  body,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-border/70 bg-background/55 p-4">
      <div className="mb-2 flex items-center gap-2 text-accent-copper">
        {icon}
        <p className="text-ui-strong text-foreground">{title}</p>
      </div>
      <p className="flex-1 text-metadata leading-relaxed text-muted-foreground">{body}</p>
      <Button type="button" variant="outline" size="sm" className="mt-3 w-fit" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}

function LinkRow({
  icon,
  title,
  body,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <button
      type="button"
      onClick={() => void openExternal(href)}
      className="flex items-start gap-3 rounded-2xl border border-border/70 bg-background/55 p-4 text-left transition-colors hover:bg-background/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="mt-0.5 text-accent-copper">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-ui-strong text-foreground">
          {title}
          <ExternalLink className="h-3 w-3 text-muted-foreground" />
        </span>
        <span className="mt-1 block text-metadata text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

function UnifiedUsageBar({
  pool,
  plan,
  adminUnlimited,
}: {
  pool: ReturnType<typeof unifiedCreditsFromCombined>;
  plan: BillingPlanId;
  adminUnlimited: boolean;
}) {
  if (adminUnlimited || (pool && !Number.isFinite(pool.included))) {
    return (
      <div className="rounded-2xl border border-border/70 bg-background/55 p-4">
        <p className="text-metadata uppercase tracking-wide text-muted-foreground">
          Company credits
        </p>
        <p className="mt-2 text-ui-strong text-foreground">Unlimited</p>
        <p className="mt-1 text-metadata text-muted-foreground">
          Admin cloud budget not metered here.
        </p>
      </div>
    );
  }

  const notOnPlan = plan === 'free' || !pool || pool.included <= 0;
  const pct = pool ? pool.percent : 0;
  const copy = unifiedCreditCopy(pool, plan);

  return (
    <div className="rounded-2xl border border-border/70 bg-background/55 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-metadata uppercase tracking-wide text-muted-foreground">
            Shared company credits
          </p>
          {notOnPlan ? (
            <p className="mt-2 text-ui-strong text-foreground">Not on this plan</p>
          ) : (
            <p className="mt-2 text-ui-strong text-foreground">
              {pool!.used.toLocaleString()}{' '}
              <span className="text-secondary font-normal text-muted-foreground">
                / {pool!.included.toLocaleString()} credits
              </span>
            </p>
          )}
        </div>
        {!notOnPlan && (
          <p className="text-metadata tabular-nums text-muted-foreground">{pct}% used</p>
        )}
      </div>

      {!notOnPlan && (
        <div
          className="mt-3 h-3 overflow-hidden rounded-full bg-muted ring-1 ring-border/40 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:bg-background [html[data-theme=monochrome]_&]:ring-foreground/30"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Shared company credit usage"
        >
          <div
            className={cn(
              'h-full rounded-full transition-all duration-300 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:transition-none',
              pct >= 90 ? 'bg-destructive/85' : pct >= 70 ? 'bg-amber-400/90' : 'bg-accent-cyan/85',
            )}
            style={{ width: `${Math.max(pct, 0)}%` }}
          />
        </div>
      )}

      <p className="mt-3 text-metadata leading-relaxed text-muted-foreground">{copy}</p>

      {!notOnPlan && pool && (
        <div className="mt-4 grid gap-2 border-t border-border/50 pt-3 sm:grid-cols-3">
          <SpendChip
            icon={<MessageSquare className="h-3.5 w-3.5" />}
            label="DeepSeek"
            value={`${pool.deepseekUsed.toLocaleString()} cr`}
          />
          <SpendChip
            icon={<Phone className="h-3.5 w-3.5" />}
            label="Phone"
            value={`${pool.phoneMinutesUsed.toLocaleString()} min · ${
              pool.phoneMinutesUsed * CREDITS_PER_PHONE_MINUTE
            } cr`}
          />
          <SpendChip
            icon={<Smartphone className="h-3.5 w-3.5" />}
            label="SMS"
            value={`${pool.smsUsed.toLocaleString()} · ${pool.smsUsed * CREDITS_PER_SMS} cr`}
          />
        </div>
      )}
    </div>
  );
}

function SpendChip({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-muted/30 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-secondary font-medium tabular-nums text-foreground">{value}</p>
    </div>
  );
}

function LocalChip({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-background/40 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/80">
        {icon}
        {label}
      </p>
      <p className="mt-1 truncate text-secondary font-medium text-foreground">{value}</p>
    </div>
  );
}
