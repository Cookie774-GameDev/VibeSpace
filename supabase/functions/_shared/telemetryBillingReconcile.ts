/**
 * Pure planning and injected execution for telemetry reward withdrawal.
 *
 * The caller supplies only active feature subscriptions and an explicit list
 * of telemetry-only coupon IDs. Family coupons, promotion codes, and unknown
 * discounts remain untouched. Subscription updates request no proration, so
 * the change affects future invoices without backcharging a customer.
 */

export const TELEMETRY_FEATURE_PLANS = ['starter', 'pro', 'ultra', 'apex'] as const;
export const TELEMETRY_ACTIVE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'incomplete',
  'paused',
] as const;

export type TelemetrySubscriptionStatus = (typeof TELEMETRY_ACTIVE_SUBSCRIPTION_STATUSES)[number];
export type TelemetryFeaturePlan = (typeof TELEMETRY_FEATURE_PLANS)[number];
export type TelemetryDiscountType = 'coupon' | 'promotion_code' | 'unknown';

export interface TelemetrySubscriptionDiscount {
  readonly type: TelemetryDiscountType;
  readonly id: string;
}

export interface TelemetrySubscription {
  readonly id: string;
  readonly status: string;
  readonly plan: string;
  readonly discounts: readonly TelemetrySubscriptionDiscount[];
}

export interface TelemetryDiscountRemovalPlan {
  readonly subscriptionId: string;
  readonly remainingDiscounts: readonly TelemetrySubscriptionDiscount[];
  readonly removedDiscountIds: readonly string[];
  readonly prorationBehavior: 'none';
}

export type TelemetryWithdrawalState = 'pending' | 'reconciled' | 'failed';

export interface TelemetryWithdrawalOutboxUpdate {
  readonly userId: string;
  readonly requestRevision?: string;
  readonly state: TelemetryWithdrawalState;
  readonly errorCode?: string;
  readonly updatedSubscriptionIds: readonly string[];
  readonly attemptedAt: number;
}

export interface TelemetryBillingReconcileResult {
  readonly state: TelemetryWithdrawalState;
  readonly updatedSubscriptionIds: readonly string[];
  readonly removedDiscountCount: number;
  readonly errorCode?: string;
}

export interface TelemetryBillingReconcileDependencies {
  listFeatureSubscriptions(userId: string): Promise<readonly TelemetrySubscription[]>;
  updateSubscription(
    subscriptionId: string,
    patch: Readonly<{
      discounts: readonly TelemetrySubscriptionDiscount[];
      prorationBehavior: 'none';
    }>,
  ): Promise<void>;
  markOutbox(update: TelemetryWithdrawalOutboxUpdate): Promise<void>;
  /** Optional compare-and-check used to stop a stale withdrawal after re-enrollment. */
  assertWithdrawalCurrent?(userId: string, requestRevision: string): Promise<boolean>;
}

const ACTIVE_STATUS_SET = new Set<string>(TELEMETRY_ACTIVE_SUBSCRIPTION_STATUSES);
const FEATURE_PLAN_SET = new Set<string>(TELEMETRY_FEATURE_PLANS);

export function isActiveFeatureSubscription(subscription: TelemetrySubscription): boolean {
  return ACTIVE_STATUS_SET.has(subscription.status) && FEATURE_PLAN_SET.has(subscription.plan);
}

/** Plan only removals that match an explicitly known telemetry-only coupon. */
export function planTelemetryDiscountRemoval(
  subscriptions: readonly TelemetrySubscription[],
  knownTelemetryCouponIds: readonly string[],
): readonly TelemetryDiscountRemovalPlan[] {
  const knownIds = new Set(
    knownTelemetryCouponIds.filter((id) => typeof id === 'string' && id.length > 0),
  );
  if (knownIds.size === 0) return [];

  return subscriptions
    .filter(isActiveFeatureSubscription)
    .map((subscription) => {
      const removedDiscountIds = subscription.discounts
        .filter((discount) => discount.type === 'coupon' && knownIds.has(discount.id))
        .map((discount) => discount.id);
      if (removedDiscountIds.length === 0) return null;
      return {
        subscriptionId: subscription.id,
        remainingDiscounts: subscription.discounts.filter(
          (discount) => !(discount.type === 'coupon' && knownIds.has(discount.id)),
        ),
        removedDiscountIds,
        prorationBehavior: 'none' as const,
      };
    })
    .filter((plan): plan is TelemetryDiscountRemovalPlan => plan !== null);
}

function failedResult(
  userId: string,
  nowMs: number,
  errorCode: string,
  dependencies: TelemetryBillingReconcileDependencies,
  updatedSubscriptionIds: readonly string[] = [],
  requestRevision?: string,
): Promise<TelemetryBillingReconcileResult> {
  const update: TelemetryWithdrawalOutboxUpdate = {
    userId,
    state: 'failed',
    errorCode,
    updatedSubscriptionIds,
    attemptedAt: nowMs,
    ...(requestRevision ? { requestRevision } : {}),
  };
  return dependencies.markOutbox(update).then(() => ({
    state: 'failed' as const,
    updatedSubscriptionIds,
    removedDiscountCount: 0,
    errorCode,
  }));
}

/** Execute a retry-safe removal and persist the durable outbox state. */
export async function reconcileTelemetryWithdrawal(input: {
  userId: string;
  knownTelemetryCouponIds: readonly string[];
  dependencies: TelemetryBillingReconcileDependencies;
  requestRevision?: string;
  nowMs?: number;
}): Promise<TelemetryBillingReconcileResult> {
  const nowMs = input.nowMs ?? Date.now();
  const requestRevision = input.requestRevision?.trim() || undefined;
  const staleResult = (errorCode = 'stale_withdrawal_revision') => ({
    state: 'pending' as const,
    updatedSubscriptionIds: [],
    removedDiscountCount: 0,
    errorCode,
  });
  const withdrawalIsCurrent = async (): Promise<boolean> => {
    if (!requestRevision || !input.dependencies.assertWithdrawalCurrent) return true;
    try {
      return await input.dependencies.assertWithdrawalCurrent(input.userId, requestRevision);
    } catch {
      return false;
    }
  };
  if (!input.userId || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return failedResult(
      input.userId,
      nowMs,
      'invalid_withdrawal_request',
      input.dependencies,
      [],
      requestRevision,
    );
  }
  if (!(await withdrawalIsCurrent())) return staleResult();
  if (input.knownTelemetryCouponIds.length === 0) {
    return failedResult(
      input.userId,
      nowMs,
      'telemetry_coupon_configuration_missing',
      input.dependencies,
      [],
      requestRevision,
    );
  }

  let subscriptions: readonly TelemetrySubscription[];
  try {
    subscriptions = await input.dependencies.listFeatureSubscriptions(input.userId);
  } catch {
    return failedResult(
      input.userId,
      nowMs,
      'subscription_lookup_failed',
      input.dependencies,
      [],
      requestRevision,
    );
  }

  const plans = planTelemetryDiscountRemoval(subscriptions, input.knownTelemetryCouponIds);
  const updatedSubscriptionIds: string[] = [];
  let removedDiscountCount = 0;
  try {
    for (const plan of plans) {
      if (!(await withdrawalIsCurrent())) return staleResult();
      await input.dependencies.updateSubscription(plan.subscriptionId, {
        discounts: plan.remainingDiscounts,
        prorationBehavior: plan.prorationBehavior,
      });
      updatedSubscriptionIds.push(plan.subscriptionId);
      removedDiscountCount += plan.removedDiscountIds.length;
    }
  } catch {
    const update: TelemetryWithdrawalOutboxUpdate = {
      userId: input.userId,
      state: 'failed',
      errorCode: 'subscription_reconcile_failed',
      updatedSubscriptionIds,
      attemptedAt: nowMs,
      ...(requestRevision ? { requestRevision } : {}),
    };
    await input.dependencies.markOutbox({
      ...update,
    });
    return {
      state: 'failed',
      updatedSubscriptionIds,
      removedDiscountCount,
      errorCode: 'subscription_reconcile_failed',
    };
  }

  if (!(await withdrawalIsCurrent())) return staleResult();
  try {
    const update: TelemetryWithdrawalOutboxUpdate = {
      userId: input.userId,
      state: 'reconciled',
      updatedSubscriptionIds,
      attemptedAt: nowMs,
      ...(requestRevision ? { requestRevision } : {}),
    };
    await input.dependencies.markOutbox({
      ...update,
    });
  } catch {
    // The billing changes are already idempotent. Expose the honest pending
    // state so a later retry can persist the receipt without re-prorating.
    return {
      state: 'pending',
      updatedSubscriptionIds,
      removedDiscountCount,
      errorCode: 'outbox_persist_failed',
    };
  }

  return {
    state: 'reconciled',
    updatedSubscriptionIds,
    removedDiscountCount,
  };
}
