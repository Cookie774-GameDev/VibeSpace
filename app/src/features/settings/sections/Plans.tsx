/**
 * Plans — Settings → Plans / Billing tab.
 *
 * Visual system mirrors the VibeSpace website pricing ledger
 * (`site/index.html#pricing` + `site/css/style.css` `.access-ledger` / `.plan`).
 * Plan names, prices, entitlements, and Stripe checkout/portal flows come from
 * repository authorities (`lib/entitlements`, `lib/billing/checkout`).
 */

import * as React from 'react';
import { ExternalLink, KeyRound, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth';
import { PLANS, PLAN_ORDER, effectivePlan, type PlanDef, type PlanId } from '@/lib/entitlements';
import { useAppAdmin } from '@/lib/admin';
import {
  callCheckoutSession,
  callCustomerPortal,
  isBackendBillingConfigured,
} from '@/lib/billing/checkout';
import { openExternal } from '@/lib/tauri';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import './plans-billing.css';

/** Website "Most popular" feature plan — Nova / Pro. */
const RECOMMENDED_PLAN_ID: PlanId = 'pro';

const PLAN_RANK: Record<PlanId, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  ultra: 3,
  apex: 4,
};

type BusyAction =
  | { kind: 'checkout'; planId: PlanId }
  | { kind: 'portal' }
  | { kind: 'access' }
  | null;

export function Plans() {
  const currentPlan = useAuthStore((s) => s.plan);
  const cloudSession = useAuthStore((s) => s.cloudSession);
  const admin = useAppAdmin();
  const activePlanId = effectivePlan(currentPlan, admin);
  const billingBackendConfigured = isBackendBillingConfigured();
  const isSignedIn = Boolean(cloudSession?.user_id);
  const backendReady = isSignedIn && billingBackendConfigured;

  const [busy, setBusy] = React.useState<BusyAction>(null);
  const [billingError, setBillingError] = React.useState<string | null>(null);
  const openProvidersTab = () => {
    window.dispatchEvent(new CustomEvent('jarvis:settings:tab', { detail: { tab: 'providers' } }));
  };

  const openAccessTerms = async () => {
    setBillingError(null);
    try {
      await openExternal('https://vibespaceos.com/access/');
    } catch (err) {
      const message = (err as Error).message ?? 'Could not open Access terms.';
      setBillingError(message);
      toast.error('Could not open Access terms', message);
    }
  };

  const handleUpgrade = async (tier: PlanId) => {
    setBillingError(null);
    if (!isSignedIn) {
      toast.info('Sign in required', 'Sign in with a cloud account before upgrading.');
      return;
    }
    if (!billingBackendConfigured) {
      toast.info(
        'Checkout unavailable',
        'Billing is not configured for this build. Connect Supabase billing functions.',
      );
      return;
    }
    setBusy({ kind: 'checkout', planId: tier });
    try {
      const result = await callCheckoutSession(tier);
      if (!result.ok) {
        setBillingError(result.error);
        toast.error('Checkout unavailable', result.error);
        return;
      }
      try {
        await openExternal(result.url);
      } catch (err) {
        const message = (err as Error).message ?? 'Open the URL manually.';
        setBillingError(message);
        toast.error('Could not open checkout', message);
      }
    } finally {
      setBusy(null);
    }
  };

  const handleManageSubscription = async () => {
    setBillingError(null);
    if (!isSignedIn || !isBackendBillingConfigured()) {
      toast.info('Sign in required', 'Sign in with a cloud account to manage your subscription.');
      return;
    }
    setBusy({ kind: 'portal' });
    try {
      const result = await callCustomerPortal();
      if (result.ok) {
        try {
          await openExternal(result.url);
        } catch (err) {
          const message = (err as Error).message ?? 'Try again.';
          setBillingError(message);
          toast.error('Could not open billing portal', message);
        }
      } else if (result.error === 'no_customer' || /no_customer/.test(result.error ?? '')) {
        toast.info('No subscription found', 'Upgrade to a paid plan to access the billing portal.');
      } else {
        setBillingError(result.error ?? 'Billing portal unavailable');
        toast.error('Billing portal unavailable', result.error ?? 'Try again in a moment.');
      }
    } finally {
      setBusy(null);
    }
  };

  const plans = PLAN_ORDER.map((id) => PLANS[id]).filter(Boolean);
  const emptyCatalog = plans.length === 0;

  return (
    <div
      className={cn(
        'mc7f-settings-plans vs-plans-billing',
        // Contract markers for monochrome appearance tests / exact-theme gates.
        '[html[data-theme=monochrome]_&]:m-0 [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:bg-none [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none [html[data-theme=monochrome]_&_*]:!animate-none [html[data-theme=monochrome]_&_*]:!blur-none [html[data-theme=monochrome]_&_*]:!shadow-none [html[data-theme=monochrome]_&_*]:hover:!translate-y-0 [html[data-theme=monochrome]_&_*]:hover:!scale-100 [html[data-theme=monochrome]_&_*]:ring-0',
        'bg-[radial-gradient(circle_at_top_left,rgba(224,146,92,0.12),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(77,216,232,0.08),transparent_40%),linear-gradient(180deg,rgba(46,40,35,0.12),transparent)]',
      )}
      data-plans-ready="true"
    >
      <header className="vs-plans-billing__head">
        <div className="vs-plans-billing__kicker">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Two separate ledgers
        </div>
        <h2 className="vs-plans-billing__title">Access first. Features when you want them.</h2>
        <p className="vs-plans-billing__lead">
          VibeSpace Access keeps the desktop application available after the introductory trial.
          Optional feature plans add hosted AI, voice, and cloud usage — billed separately. Local
          Jarvis High and BYOK stay available on every tier.
        </p>
      </header>

      {!billingBackendConfigured && (
        <div className="vs-plans-billing__banner vs-plans-billing__banner--warn" role="status">
          <span>
            <strong className="text-foreground">Billing not configured.</strong> Paid checkout
            requires Supabase billing functions in this build. Sign-in and BYOK still work.
          </span>
        </div>
      )}

      {billingBackendConfigured && !isSignedIn && (
        <div className="vs-plans-billing__banner vs-plans-billing__banner--info" role="status">
          <span>
            <strong className="text-foreground">Sign in required</strong> to start checkout or open
            the billing portal. Plan details below remain available offline.
          </span>
        </div>
      )}

      {billingError && (
        <div className="vs-plans-billing__banner vs-plans-billing__banner--error" role="alert">
          <span>
            <strong>Billing error.</strong> {billingError}
          </span>
        </div>
      )}

      {/* Access ledger — website parity */}
      <section className="vs-plans-access" aria-label="VibeSpace Access pricing">
        <div className="vs-plans-access__label">Required application access</div>
        <div>
          <h3>VibeSpace Access</h3>
          <p>
            Introductory access trial starts on first use with a verified account and lasts 30
            consecutive days. It collects no payment and does not auto-convert. Continued use after
            the trial requires you to deliberately start the $20 monthly subscription.
          </p>
        </div>
        <div className="vs-plans-access__price">
          <strong>$20</strong>
          <span>
            USD / month
            <br />
            after 30 days
          </span>
        </div>
        <Button
          type="button"
          variant="accent"
          size="sm"
          className="vs-plan-card__cta-btn vs-plan-card__cta-btn--primary"
          disabled={busy?.kind === 'access'}
          onClick={() => {
            setBusy({ kind: 'access' });
            void openAccessTerms().finally(() => setBusy(null));
          }}
        >
          {busy?.kind === 'access' ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Opening…
            </>
          ) : (
            'Review Access terms'
          )}
        </Button>
      </section>

      <div className="vs-plans-feature-head">
        <div>
          <span className="vs-plans-access__label">Optional feature plans</span>
          <h3>AI, voice, and cloud usage</h3>
        </div>
        <p>
          These plans do not replace VibeSpace Access. Choosing one may create a second, separate
          subscription. Company credits are internal units, not cash.
        </p>
      </div>

      {emptyCatalog ? (
        <div className="vs-plans-billing__banner vs-plans-billing__banner--warn" role="status">
          No plan catalog is available in this build.
        </div>
      ) : (
        <div
          className={cn('vs-plans-grid', busy && 'vs-plans-grid--busy')}
          role="list"
          aria-label="Feature plans"
          aria-busy={busy ? 'true' : undefined}
        >
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              isCurrent={plan.id === activePlanId}
              isRecommended={plan.id === RECOMMENDED_PLAN_ID}
              activePlanId={activePlanId}
              backendReady={backendReady}
              busy={busy}
              onAddKey={openProvidersTab}
              onUpgrade={() => void handleUpgrade(plan.id)}
              onManage={() => void handleManageSubscription()}
            />
          ))}
        </div>
      )}

      <p className="vs-plans-disclosure">
        <strong>Two charges can apply:</strong> VibeSpace Access keeps the desktop application
        available after the trial. An optional feature plan pays for its listed AI, voice, or cloud
        usage. Your local files, workspace settings, custom tools, and keys never leave your machine
        on any tier.
      </p>

      <p className="vs-plans-byok">
        <strong>BYOK is fully supported:</strong> If you supply your own API credentials, VibeSpace
        routes commands through your keys without charging hosted budgets or restricting message
        counts on those providers.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Card
 * --------------------------------------------------------------------------*/

interface PlanCardProps {
  plan: PlanDef;
  isCurrent: boolean;
  isRecommended: boolean;
  activePlanId: PlanId;
  backendReady: boolean;
  busy: BusyAction;
  onAddKey: () => void;
  onUpgrade: () => void;
  onManage: () => void;
}

function PlanCard({
  plan,
  isCurrent,
  isRecommended,
  activePlanId,
  backendReady,
  busy,
  onAddKey,
  onUpgrade,
  onManage,
}: PlanCardProps) {
  const isFree = plan.id === 'free';
  const isCheckoutBusy = busy?.kind === 'checkout' && busy.planId === plan.id;
  const isPortalBusy = busy?.kind === 'portal';
  const anyBusy = busy !== null;
  const rank = PLAN_RANK[plan.id];
  const activeRank = PLAN_RANK[activePlanId];
  const isDowngrade = !isCurrent && !isFree && rank < activeRank;
  const isUpgrade = !isCurrent && !isFree && rank > activeRank;
  const unavailableCheckout = !isFree && !backendReady;
  const primaryFeatures = plan.features.slice(0, 4);
  const additionalFeatures = plan.features.slice(4);

  const priceLabel =
    plan.priceUsd === 0 ? (
      <>$0</>
    ) : (
      <>
        ${plan.priceUsd}
        <span>/mo</span>
      </>
    );

  const ariaPrice =
    plan.priceUsd === 0
      ? `${plan.label} plan, free`
      : `${plan.label} plan, $${plan.priceUsd} per month`;

  let cta: React.ReactNode;
  if (isFree) {
    cta = (
      <>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="vs-plan-card__cta-btn"
          onClick={onAddKey}
          disabled={anyBusy}
        >
          <KeyRound className="h-3.5 w-3.5" aria-hidden />
          Add a key
        </Button>
        <p className="vs-plan-card__hint">
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-1 font-semibold text-[hsl(var(--accent-copper))] underline-offset-4 hover:underline"
          >
            Get Gemini key
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </p>
      </>
    );
  } else if (isCurrent) {
    cta = (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="vs-plan-card__cta-btn"
        onClick={onManage}
        disabled={anyBusy}
      >
        {isPortalBusy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Opening portal…
          </>
        ) : (
          'Manage subscription'
        )}
      </Button>
    );
  } else if (isDowngrade) {
    cta = (
      <>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="vs-plan-card__cta-btn"
          onClick={onManage}
          disabled={anyBusy}
        >
          {isPortalBusy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Opening portal…
            </>
          ) : (
            'Switch plan'
          )}
        </Button>
        <p className="vs-plan-card__hint">Downgrades are handled in the secure billing portal.</p>
      </>
    );
  } else {
    const label = isUpgrade
      ? `Upgrade — $${plan.priceUsd}/mo`
      : `Choose ${plan.label} — $${plan.priceUsd}/mo`;
    cta = (
      <>
        <Button
          type="button"
          variant={isRecommended ? 'accent' : 'secondary'}
          size="sm"
          className={cn(
            'vs-plan-card__cta-btn',
            isRecommended && backendReady && 'vs-plan-card__cta-btn--primary',
          )}
          onClick={onUpgrade}
          disabled={anyBusy}
          aria-disabled={unavailableCheckout || undefined}
        >
          {isCheckoutBusy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Starting checkout…
            </>
          ) : (
            label
          )}
        </Button>
        {unavailableCheckout && (
          <p className="vs-plan-card__hint">
            {backendReady
              ? null
              : 'Sign in with billing configured to complete checkout. This button still uses the real billing flow when available.'}
          </p>
        )}
      </>
    );
  }

  return (
    <article
      role="listitem"
      className={cn(
        'vs-plan-card',
        isRecommended && 'vs-plan-card--featured',
        isCurrent && 'vs-plan-card--current',
        unavailableCheckout && !isCurrent && 'vs-plan-card--unavailable',
        isCurrent && isFree && 'ring-1 ring-cyan-500/30',
      )}
      aria-label={ariaPrice}
      aria-current={isCurrent ? 'true' : undefined}
      data-plan-id={plan.id}
      data-plan-current={isCurrent ? 'true' : 'false'}
      data-plan-recommended={isRecommended ? 'true' : 'false'}
    >
      <h3 className="vs-plan-card__pname">{plan.label}</h3>
      <div className="vs-plan-card__price">{priceLabel}</div>
      <p className="vs-plan-card__tagline">{plan.tagline}</p>

      <div className="vs-plan-card__badges">
        {isCurrent && (
          <span className="vs-plan-card__badge vs-plan-card__badge--current">Current plan</span>
        )}
        {isRecommended && !isCurrent && (
          <span className="vs-plan-card__badge vs-plan-card__badge--recommended">Recommended</span>
        )}
        {isDowngrade && <span className="vs-plan-card__badge">Lower tier</span>}
      </div>

      <ul className="vs-plan-card__features">
        {primaryFeatures.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      {additionalFeatures.length > 0 && (
        <details className="vs-plan-card__more">
          <summary>Show {additionalFeatures.length} more benefits</summary>
          <ul className="vs-plan-card__features vs-plan-card__features--more">
            {additionalFeatures.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="vs-plan-card__cta">{cta}</div>
    </article>
  );
}
