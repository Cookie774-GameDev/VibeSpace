export interface StripeSubscriptionLike {
  id: string;
  status: string;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean | null;
  items?: { data?: Array<{ price?: { id?: string | null } | null }> } | null;
}

interface SubscriptionRpcInput {
  eventId: string;
  eventType: string;
  eventCreated: number;
  customerId: string;
  plan: string | null;
  subscription: StripeSubscriptionLike;
}

function stripeSecondsToIso(value: number | null | undefined): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) return null;
  return new Date(Number(value) * 1000).toISOString();
}

export function buildSubscriptionRpcArgs(input: SubscriptionRpcInput) {
  const subscription = input.subscription;
  return {
    p_event_id: input.eventId,
    p_event_type: input.eventType,
    p_event_created_at: stripeSecondsToIso(input.eventCreated),
    p_customer_id: input.customerId,
    p_subscription_id: subscription.id,
    p_status: subscription.status,
    p_plan: input.plan,
    p_price_id: subscription.items?.data?.[0]?.price?.id ?? null,
    p_period_start: stripeSecondsToIso(subscription.current_period_start),
    p_period_end: stripeSecondsToIso(subscription.current_period_end),
    p_cancel_at_period_end: subscription.cancel_at_period_end ?? false,
  };
}

const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,200}$/;

export function buildUsageIdempotencyKey(
  scope: string,
  candidate: string | null | undefined,
): string {
  if (candidate && SAFE_IDEMPOTENCY_KEY.test(candidate)) return `${scope}:${candidate}`.slice(0, 200);
  const generated = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${generated}`.slice(0, 200);
}

export function hasUniqueConfiguredPrices(
  prices: Record<string, string | null | undefined>,
): boolean {
  const values = Object.values(prices).filter((value): value is string => Boolean(value));
  return values.length > 0 && new Set(values).size === values.length;
}

export function planForPriceMapping(
  priceId: string,
  prices: Record<string, string | null | undefined>,
): string | null {
  if (!hasUniqueConfiguredPrices(prices)) return null;
  const match = Object.entries(prices).find(([, value]) => value === priceId);
  return match ? match[0] : null;
}

export function buildCheckoutIdempotencyKey(
  candidate: string | null | undefined,
  userId: string,
  plan: string,
  nowMs = Date.now(),
): string {
  const safeUserId = userId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  const safePlan = plan.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  if (candidate && SAFE_IDEMPOTENCY_KEY.test(candidate)) {
    return `checkout:${safeUserId}:${safePlan}:${candidate}`.slice(0, 255);
  }
  const fiveMinuteBucket = Math.floor(nowMs / 300_000);
  return `checkout:${safeUserId}:${safePlan}:${fiveMinuteBucket}`;
}
