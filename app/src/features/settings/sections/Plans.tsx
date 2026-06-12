/**
 * Plans — Settings → Plans tab.
 *
 * Renders the four-tier ladder defined in `lib/entitlements.ts`:
 *   Spark (Free) · Orbit ($5) · Nova ($20) · Singularity ($100)
 */

import * as React from 'react';
import {
  Sparkles,
  KeyRound,
  ExternalLink,
  Crown,
  Check,
  Zap,
  Orbit,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import {
  PLANS,
  PLAN_ORDER,
  effectivePlan,
  type PlanDef,
  type PlanId,
} from '@/lib/entitlements';
import { useAppAdmin } from '@/lib/admin';
import { getCheckoutUrl, isStripeConfigured } from '@/lib/billing/stripe';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const PLAN_PAGE_BACKGROUNDS: Record<PlanId, string> = {
  free: 'bg-[radial-gradient(circle_at_top_left,rgba(6,182,212,0.18),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(20,184,166,0.1),transparent_36%),linear-gradient(180deg,rgba(8,47,73,0.14),transparent)]',
  starter: 'bg-[radial-gradient(circle_at_top_left,rgba(217,119,87,0.25),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(251,146,60,0.1),transparent_36%),linear-gradient(180deg,rgba(120,53,15,0.14),transparent)]',
  pro: 'bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.28),transparent_40%),radial-gradient(circle_at_bottom_right,rgba(252,211,77,0.12),transparent_36%),linear-gradient(180deg,rgba(146,64,14,0.16),transparent)]',
  ultra:
    'bg-[radial-gradient(circle_at_center,rgba(124,58,237,0.5),transparent_50%),radial-gradient(circle_at_top_right,rgba(59,130,246,0.32),transparent_38%),radial-gradient(circle_at_bottom_left,rgba(236,72,153,0.22),transparent_40%),linear-gradient(180deg,rgba(15,23,42,0.6),transparent)]',
};

export function Plans() {
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const currentPlan = useAuthStore((s) => s.plan);
  const admin = useAppAdmin();
  const activePlanId = effectivePlan(currentPlan, admin);
  const stripeReady = isStripeConfigured();

  const openProvidersTab = () => {
    window.dispatchEvent(
      new CustomEvent('jarvis:settings:tab', { detail: { tab: 'providers' } }),
    );
  };

  const handleUpgrade = async (tier: PlanId) => {
    const url = getCheckoutUrl(tier);
    if (!url) {
      toast.info(
        'Checkout coming soon',
        'Stripe links activate once the billing env vars are wired up.',
      );
      return;
    }
    try {
      await openExternal(url);
    } catch (err) {
      toast.error(
        'Could not open checkout',
        (err as Error).message ?? 'Open the URL manually.',
      );
    }
  };

  return (
    <div className={cn('relative -m-4 flex flex-col gap-6 rounded-[28px] p-4', PLAN_PAGE_BACKGROUNDS[activePlanId])}>
      {/* Dynamic Aurora Header */}
      <header className="relative overflow-hidden rounded-2xl border border-border bg-slate-950 p-6 shadow-2xl">
        {/* Animated Aurora backgrounds */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute -top-[100px] -left-[10%] w-[50%] h-[300px] rounded-full bg-gradient-to-br from-indigo-500/20 to-purple-500/10 blur-[80px] animate-[plan-lensing-pulse_8s_ease-in-out_infinite]" />
          <div className="absolute -top-[100px] -right-[10%] w-[40%] h-[260px] rounded-full bg-gradient-to-bl from-teal-500/15 to-cyan-500/5 blur-[70px] animate-[plan-lensing-pulse_12s_ease-in-out_infinite_2s]" />
        </div>

        <div className="relative z-10">
          <div className="mb-2.5 inline-flex items-center gap-2 rounded-full border border-accent-copper/40 bg-accent-copper/10 px-3.5 py-1 text-metadata font-semibold uppercase tracking-[0.2em] text-accent-copper">
            <Sparkles className="h-3.5 w-3.5 animate-pulse" /> Choose Your Power
          </div>
          <h2 className="font-display text-hero text-white tracking-tight">Select your Jarvis intelligence tier</h2>
          <p className="text-secondary text-slate-400 mt-2 max-w-2xl leading-relaxed">
            Configure how Jarvis powers your workflow. The Spark plan is free to use with your own API keys. 
            Paid tiers offer plug-and-play hosted inference, unlimited voice features, and deep-space capabilities.
          </p>
        </div>
      </header>

      {/* Auto-fit grid: ~2 cols in the settings modal; never squeeze 4 cols into ~900px */}
      <div className="grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr))]">
        {PLAN_ORDER.map((id) => (
          <PlanCard
            key={id}
            plan={PLANS[id]}
            isCurrent={id === activePlanId}
            checkoutUrl={getCheckoutUrl(id)}
            onAddKey={openProvidersTab}
            onUpgrade={() => void handleUpgrade(id)}
          />
        ))}
      </div>

      {/* Footer explanations */}
      <div className="rounded-2xl border border-border bg-elevated px-4 py-3.5 text-secondary text-muted-foreground leading-relaxed shadow-soft">
        <p>
          {stripeReady ? (
            <>
              <span className="text-foreground font-medium">Billing is live.</span>{' '}
              All updates go safely through Stripe in your desktop browser. Cancel anytime with a single click. 
              Your local files, workspace settings, custom tools, and keys never leave your machine on any tier.
            </>
          ) : (
            <>
              <span className="text-foreground font-medium">Coming soon:</span>{' '}
              Full cloud sync and hosted models release. Upgrades will activate securely through Stripe. 
              Your localized chat database, workspace profiles, and API key configurations remain 100% private.
            </>
          )}
        </p>
      </div>

      <p className="rounded-xl border border-border/70 bg-panel/80 px-4 py-3.5 text-secondary text-muted-foreground leading-relaxed">
        <strong>BYOK (Bring Your Own Key) is fully supported:</strong> If you supply your own API credentials 
        (Google Gemini, Anthropic Claude, OpenAI GPT, Groq, Ollama), Jarvis routes commands directly 
        without charging your hosted budget or restricting your message count.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Card Component
 * --------------------------------------------------------------------------*/

interface PlanCardProps {
  plan: PlanDef;
  isCurrent: boolean;
  checkoutUrl: string | undefined;
  onAddKey: () => void;
  onUpgrade: () => void;
}

function PlanCard({ plan, isCurrent, checkoutUrl, onAddKey, onUpgrade }: PlanCardProps) {
  const billingReady = Boolean(checkoutUrl);

  // Spark Card (Free)
  if (plan.id === 'free') {
    return (
      <article
        className={cn(
          'group relative flex min-h-[480px] flex-col gap-4 overflow-hidden rounded-[24px] border border-cyan-500/15 bg-gradient-to-b from-elevated/80 to-panel p-5 shadow-cozy',
          'transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_0_20px_rgba(6,182,212,0.12)]',
          isCurrent && 'border-cyan-400/50 ring-1 ring-cyan-500/30'
        )}
        aria-label={`${plan.label} plan, free`}
      >
        {/* Subtle border shimmer on hover */}
        <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-[24px] border border-cyan-400/40 z-0" />
        
        {/* Colorful top strip */}
        <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-cyan-500 to-teal-400 z-10" />

        <div className="relative flex flex-col gap-5 h-full z-10">
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                {/* Icon slot */}
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-950/40 shadow-soft">
                  <Zap className="h-5 w-5 text-cyan-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display text-page-title text-foreground">{plan.label}</h3>
                  <p className="mt-1 text-secondary text-muted-foreground leading-snug">
                    {plan.tagline}
                  </p>
                </div>
              </div>
              <span className="shrink-0 whitespace-nowrap font-display text-page-title text-cyan-400">Free</span>
            </div>
            {isCurrent && (
              <Badge variant="success" className="whitespace-nowrap">
                Current Plan
              </Badge>
            )}
          </header>

          <Separator className="bg-cyan-500/10" />

          {/* Feature list */}
          <ul className="flex flex-col gap-2.5 text-secondary text-foreground/90">
            {plan.features.map((line) => (
              <li key={line} className="flex items-start gap-2.5 rounded-xl border border-cyan-500/5 bg-cyan-500/[0.02] px-3 py-2">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-cyan-400" aria-hidden />
                <span className="flex-1 leading-relaxed text-[11px] font-medium">{line}</span>
              </li>
            ))}
          </ul>

          {/* CTA */}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <Button variant="secondary" size="sm" onClick={onAddKey} className="w-full bg-cyan-500/5 hover:bg-cyan-500/10 border-cyan-500/15 text-cyan-400">
              <KeyRound className="h-3.5 w-3.5" /> Add a Key
            </Button>
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noreferrer"
              className="text-metadata text-cyan-400 font-semibold text-center mt-1 inline-flex items-center justify-center gap-1 underline-offset-4 hover:underline"
            >
              Get Gemini Key
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </article>
    );
  }

  // Orbit Card (Starter - $5)
  if (plan.id === 'starter') {
    return (
      <article
        style={{
          boxShadow: 'inset 0 0 16px rgba(217,119,87,0.08)'
        }}
        className={cn(
          'group relative flex min-h-[480px] flex-col gap-4 overflow-hidden rounded-[24px] border border-accent-copper/20 bg-gradient-to-b from-elevated/80 to-panel p-5 animate-[plan-glow-pulse_5s_ease-in-out_infinite]',
          'transition-all duration-300 hover:-translate-y-2 hover:shadow-[0_0_22px_rgba(217,119,87,0.18)]',
          isCurrent && 'border-accent-copper/50 ring-1 ring-accent-copper/30'
        )}
        aria-label={`${plan.label} plan, $${plan.priceUsd} per month`}
      >
        <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-accent-copper to-rose-400 z-10" />

        <div className="relative flex flex-col gap-5 h-full z-10">
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                {/* Icon slot with Orbit animation */}
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-accent-copper/30 bg-accent-copper/10 shadow-soft">
                  {/* Rotating Ring */}
                  <div className="absolute -inset-1 rounded-full border border-dashed border-accent-copper/40 animate-[plan-ring-orbit_8s_linear_infinite]" />
                  <Orbit className="h-5 w-5 text-accent-copper relative z-10" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-display text-page-title text-foreground">{plan.label}</h3>
                  <p className="mt-1 text-secondary text-muted-foreground leading-snug">
                    {plan.tagline}
                  </p>
                </div>
              </div>
              <div className="shrink-0 whitespace-nowrap text-right">
                <span className="font-display text-page-title text-accent-copper">${plan.priceUsd}</span>
                <span className="block text-[10px] text-muted-foreground font-sans">/mo</span>
              </div>
            </div>
            {isCurrent && (
              <Badge variant="success" className="whitespace-nowrap">
                Current Plan
              </Badge>
            )}
          </header>

          <Separator className="bg-accent-copper/10" />

          {/* Feature list */}
          <ul className="flex flex-col gap-2.5 text-secondary text-foreground/90">
            {plan.features.map((line) => (
              <li key={line} className="flex items-start gap-2.5 rounded-xl border border-accent-copper/5 bg-accent-copper/[0.02] px-3 py-2">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-accent-copper" aria-hidden />
                <span className="flex-1 leading-relaxed text-[11px] font-medium">{line}</span>
              </li>
            ))}
          </ul>

          {/* CTA */}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            {isCurrent ? (
              <span className="text-metadata text-center text-muted-foreground/80 font-medium py-2">
                Active. Managed via Stripe receipts.
              </span>
            ) : billingReady ? (
              <Button variant="accent" size="sm" onClick={onUpgrade} className="w-full bg-accent-copper hover:bg-accent-copper/90 text-white shadow-lg hover:shadow-accent-copper/20 hover:scale-[1.02] transition-all">
                <Zap className="h-3.5 w-3.5" /> Upgrade — ${plan.priceUsd}/mo
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled className="w-full">
                Available Soon
              </Button>
            )}
          </div>
        </div>
      </article>
    );
  }

  // Nova Card (Pro - $20)
  if (plan.id === 'pro') {
    return (
      <article
        className="group relative flex min-h-[480px] flex-col overflow-hidden rounded-[24px] transition-all duration-300 hover:-translate-y-2"
        aria-label={`${plan.label} plan, $${plan.priceUsd} per month`}
      >
        {/* Animated Golden Border Wrapper */}
        <div className="absolute -inset-[1.5px] rounded-[24px] bg-gradient-to-r from-yellow-500 via-amber-400 to-orange-500 opacity-60 group-hover:opacity-100 transition-opacity duration-300 animate-[plan-border-flow_4s_linear_infinite] bg-[length:200%_auto] z-0 shadow-lg" />
        
        {/* Twinkling particle dots behind glass */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none z-10">
          <div className="absolute top-[20%] left-[30%] w-1 h-1 rounded-full bg-yellow-300 opacity-40 animate-[plan-particle-float_6s_ease-in-out_infinite]" />
          <div className="absolute top-[60%] left-[80%] w-1.5 h-1.5 rounded-full bg-amber-400 opacity-30 animate-[plan-particle-float_8s_ease-in-out_infinite_1.5s]" />
          <div className="absolute top-[40%] left-[10%] w-1 h-1 rounded-full bg-orange-300 opacity-55 animate-[plan-particle-float_7s_ease-in-out_infinite_0.5s]" />
          <div className="absolute top-[80%] left-[40%] w-1 h-1 rounded-full bg-yellow-200 opacity-40 animate-[plan-particle-float_9s_ease-in-out_infinite_2s]" />
        </div>

        {/* Card Inner Content */}
        <div className="relative flex flex-col h-full w-full rounded-[23px] bg-elevated/95 p-5 z-20 gap-5">
          <header className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-yellow-500/30 bg-amber-500/10 shadow-soft">
                  <Sparkles className="h-5 w-5 text-amber-400 animate-pulse" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <h3 className="font-display text-page-title text-foreground">{plan.label}</h3>
                    <Badge className="whitespace-nowrap bg-gradient-to-r from-yellow-500 to-amber-600 text-white border-none font-semibold text-[8px] tracking-wide uppercase px-1.5 py-0.5 animate-pulse">
                      Popular
                    </Badge>
                  </div>
                  <p className="mt-1 text-secondary text-muted-foreground leading-snug">
                    {plan.tagline}
                  </p>
                </div>
              </div>
              <div className="shrink-0 whitespace-nowrap text-right">
                <span className="font-display text-page-title text-amber-500">${plan.priceUsd}</span>
                <span className="block text-[10px] text-muted-foreground font-sans">/mo</span>
              </div>
            </div>
            {isCurrent && (
              <Badge variant="success" className="whitespace-nowrap">
                Current Plan
              </Badge>
            )}
          </header>

          <Separator className="bg-yellow-500/10" />

          {/* Feature list */}
          <ul className="flex flex-col gap-2.5 text-secondary text-foreground/90">
            {plan.features.map((line) => (
              <li key={line} className="flex items-start gap-2.5 rounded-xl border border-yellow-500/5 bg-yellow-500/[0.01] px-3 py-2">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                <span className="flex-1 leading-relaxed text-[11px] font-medium">{line}</span>
              </li>
            ))}
          </ul>

          {/* CTA */}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            {isCurrent ? (
              <span className="text-metadata text-center text-muted-foreground/80 font-medium py-2">
                Active. Managed via Stripe receipts.
              </span>
            ) : billingReady ? (
              <Button variant="accent" size="sm" onClick={onUpgrade} className="w-full bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-450 hover:to-amber-550 text-white font-semibold shadow-lg hover:shadow-yellow-500/10 hover:scale-[1.02] transition-all">
                <Zap className="h-3.5 w-3.5" /> Upgrade — ${plan.priceUsd}/mo
              </Button>
            ) : (
              <Button variant="secondary" size="sm" disabled className="w-full">
                Available Soon
              </Button>
            )}
          </div>
        </div>
      </article>
    );
  }

  // Singularity Card (Ultra - $100)
  if (plan.id === 'ultra') {
    return (
      <article
        className="group relative flex min-h-[480px] flex-col overflow-hidden rounded-[24px] transition-all duration-300 hover:-translate-y-2"
        aria-label={`${plan.label} plan, $${plan.priceUsd} per month`}
      >
        {/* Shifting Cosmic Border Glow */}
        <div className="absolute -inset-[2px] rounded-[24px] bg-gradient-to-r from-purple-600 via-blue-500 to-indigo-700 opacity-80 group-hover:opacity-100 transition-opacity duration-300 animate-[plan-border-flow_6s_linear_infinite] bg-[length:200%_auto] z-0 shadow-[0_0_25px_rgba(139,92,246,0.3)]" />
        
        {/* Black Hole Cosmic Inner Container */}
        <div className="relative flex flex-col h-full w-full rounded-[22px] overflow-hidden p-5 z-20 gap-5 text-white bg-slate-950/95">
          {/* Rotating Deep Galaxy Gradient Background.
              The bright lobe sits OFF-CENTER (38% 32%) on purpose: a centered
              radial gradient is rotation-invariant, so the old version looked
              static. Off-center, the 35s spin visibly sweeps the galactic
              core around the card. */}
          <div className="absolute -inset-[35%] pointer-events-none bg-[radial-gradient(ellipse_at_38%_32%,rgba(168,85,247,0.72)_0%,rgba(124,58,237,0.52)_20%,rgba(88,28,135,0.42)_42%,rgba(15,23,42,0.88)_68%,#030712_100%)] animate-[plan-galaxy-rotate_35s_linear_infinite] will-change-transform z-0" />

          {/* Drifting nebula swirl */}
          <div className="plan-ultra-nebula" />

          {/* Concentric Lensing Rings */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-48 rounded-full border-2 border-purple-400/55 blur-[2px] animate-[plan-lensing-pulse_7s_ease-in-out_infinite] pointer-events-none z-0" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 rounded-full border-2 border-blue-400/40 blur-[4px] animate-[plan-lensing-pulse_11s_ease-in-out_infinite_1.5s] pointer-events-none z-0" />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full border border-indigo-400/30 blur-[6px] animate-[plan-lensing-pulse_15s_ease-in-out_infinite_3s] pointer-events-none z-0" />

          {/* Counter-rotating star field layers */}
          <div className="plan-ultra-stars" />
          <div className="plan-ultra-stars plan-ultra-stars--far" />

          {/* Content overlay */}
          <div className="relative flex flex-col h-full w-full z-10 gap-5">
            <header className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-purple-500/40 bg-purple-900/30 shadow-[0_0_15px_rgba(168,85,247,0.3)]">
                    <Crown className="h-5 w-5 text-purple-300 animate-bounce" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <h3 className="font-display text-page-title text-white tracking-tight">{plan.label}</h3>
                      <Badge className="whitespace-nowrap bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-600 text-white border-none font-semibold text-[8px] tracking-wide uppercase px-1.5 py-0.5 animate-[plan-shimmer-text_3s_linear_infinite] bg-[length:200%_auto]">
                        Ultimate
                      </Badge>
                    </div>
                    <p className="mt-1 text-secondary text-slate-300 leading-snug">
                      {plan.tagline}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 whitespace-nowrap text-right">
                  <span className="font-display text-page-title text-purple-300 animate-[plan-shimmer-text_4s_linear_infinite] bg-gradient-to-r from-purple-300 via-pink-200 to-indigo-200 bg-clip-text text-transparent bg-[length:200%_auto]">${plan.priceUsd}</span>
                  <span className="block text-[10px] text-slate-400 font-sans">/mo</span>
                </div>
              </div>
              {isCurrent && (
                <Badge className="whitespace-nowrap bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  Current Plan
                </Badge>
              )}
            </header>

            <Separator className="bg-purple-500/20" />

            {/* Feature list */}
            <ul className="flex flex-col gap-2.5 text-secondary text-slate-200">
              {plan.features.map((line) => (
                <li key={line} className="flex items-start gap-2.5 rounded-xl border border-purple-500/10 bg-purple-900/[0.04] px-3 py-2">
                  <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-purple-300" aria-hidden />
                  <span className="flex-1 leading-relaxed text-[11px] font-medium">{line}</span>
                </li>
              ))}
            </ul>

            {/* CTA */}
            <div className="mt-auto flex flex-col gap-2 pt-2">
              {isCurrent ? (
                <span className="text-metadata text-center text-slate-300 font-medium py-2">
                  Active. Managed via Stripe receipts.
                </span>
              ) : billingReady ? (
                <Button variant="accent" size="sm" onClick={onUpgrade} className="w-full bg-gradient-to-r from-purple-600 via-fuchsia-600 to-indigo-600 hover:from-purple-550 hover:to-indigo-550 text-white font-bold shadow-[0_0_20px_rgba(168,85,247,0.35)] hover:shadow-[0_0_30px_rgba(168,85,247,0.55)] hover:scale-[1.02] transition-all border-none">
                  <Zap className="h-3.5 w-3.5" /> Upgrade — ${plan.priceUsd}/mo
                </Button>
              ) : (
                <Button variant="secondary" size="sm" disabled className="w-full bg-slate-900 border-purple-500/25 text-slate-400">
                  Available Soon
                </Button>
              )}
            </div>
          </div>
        </div>
      </article>
    );
  }

  // Fallback default
  return null;
}
