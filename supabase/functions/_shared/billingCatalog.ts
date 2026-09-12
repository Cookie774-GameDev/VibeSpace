export type BillingPlanId = 'free' | 'starter' | 'pro' | 'ultra' | 'apex';

export interface BillingPlan {
  id: BillingPlanId;
  displayName: string;
  addOnUsd: number;
  totalUsd: number;
  monthlyCredits: number;
  usageBudgetUsd: number;
  lookupKey: string;
}

export const BILLING_PLANS: Readonly<Record<BillingPlanId, Readonly<BillingPlan>>> = Object.freeze({
  free: Object.freeze({
    id: 'free',
    displayName: 'Spark',
    addOnUsd: 0,
    totalUsd: 20,
    monthlyCredits: 1_000,
    usageBudgetUsd: 1,
    lookupKey: 'vibespace_access_monthly_v1',
  }),
  starter: Object.freeze({
    id: 'starter',
    displayName: 'Orbit',
    addOnUsd: 10,
    totalUsd: 30,
    monthlyCredits: 5_500,
    usageBudgetUsd: 5.5,
    lookupKey: 'vibespace_orbit_addon_monthly_v1',
  }),
  pro: Object.freeze({
    id: 'pro',
    displayName: 'Nova',
    addOnUsd: 50,
    totalUsd: 70,
    monthlyCredits: 27_500,
    usageBudgetUsd: 27.5,
    lookupKey: 'vibespace_nova_addon_monthly_v1',
  }),
  ultra: Object.freeze({
    id: 'ultra',
    displayName: 'Singularity',
    addOnUsd: 100,
    totalUsd: 120,
    monthlyCredits: 55_000,
    usageBudgetUsd: 55,
    lookupKey: 'vibespace_singularity_addon_monthly_v1',
  }),
  apex: Object.freeze({
    id: 'apex',
    displayName: 'Supernova',
    addOnUsd: 200,
    totalUsd: 220,
    monthlyCredits: 110_000,
    usageBudgetUsd: 110,
    lookupKey: 'vibespace_supernova_addon_monthly_v1',
  }),
});

export interface BillingPriceConfig {
  addonPriceIds: Readonly<Record<Exclude<BillingPlanId, 'free'>, string>>;
}

export interface StripeLineItem {
  price: string;
  quantity: 1;
}

function isPlanId(value: string): value is BillingPlanId {
  return Object.prototype.hasOwnProperty.call(BILLING_PLANS, value);
}

function validPriceId(value: unknown): value is string {
  return typeof value === 'string' && /^price_[A-Za-z0-9_]{1,120}$/.test(value);
}

export function resolveCheckoutLineItems(
  requestedPlan: string,
  config: BillingPriceConfig,
):
  | { ok: true; plan: Readonly<BillingPlan>; lineItems: StripeLineItem[] }
  | { ok: false; error: 'invalid_plan' | 'billing_unconfigured' } {
  if (!isPlanId(requestedPlan) || requestedPlan === 'free') {
    return { ok: false, error: 'invalid_plan' };
  }
  const plan = BILLING_PLANS[requestedPlan];
  const priceId = config.addonPriceIds[requestedPlan];
  if (!validPriceId(priceId)) {
    return { ok: false, error: 'billing_unconfigured' };
  }
  return { ok: true, plan, lineItems: [{ price: priceId, quantity: 1 }] };
}

export function resolveStripeEntitlement(
  rawPriceIds: readonly string[],
  config: BillingPriceConfig,
):
  | {
      ok: true;
      plan: Readonly<BillingPlan>;
      priceId: string;
    }
  | {
      ok: false;
      error: 'ambiguous_plan' | 'unknown_price' | 'billing_unconfigured';
    } {
  const addonEntries = Object.entries(config.addonPriceIds) as [
    Exclude<BillingPlanId, 'free'>,
    string,
  ][];
  if (
    addonEntries.some(([, priceId]) => !validPriceId(priceId)) ||
    new Set(addonEntries.map(([, priceId]) => priceId)).size !== addonEntries.length
  ) {
    return { ok: false, error: 'billing_unconfigured' };
  }
  if (rawPriceIds.length !== 1) {
    return { ok: false, error: rawPriceIds.length > 1 ? 'ambiguous_plan' : 'unknown_price' };
  }
  const priceId = rawPriceIds[0];
  if (!validPriceId(priceId)) return { ok: false, error: 'unknown_price' };
  const byPrice = new Map(addonEntries.map(([plan, price]) => [price, plan]));
  const planId = byPrice.get(priceId);
  if (!planId) return { ok: false, error: 'unknown_price' };
  return {
    ok: true,
    plan: BILLING_PLANS[planId],
    priceId,
  };
}
