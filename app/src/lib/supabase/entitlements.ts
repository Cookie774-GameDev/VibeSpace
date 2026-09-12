import type { PlanId } from '@/lib/entitlements';
import { getSupabaseClient } from '@/lib/supabase/client';

const VALID_PLANS = new Set<PlanId>(['free', 'starter', 'pro', 'ultra', 'apex']);
const CACHE_TTL_MS = 60_000;

export interface MyEntitlements {
  userId: string;
  plan: PlanId;
  isAdmin: boolean;
  cloudSyncAllowed: boolean;
  messageCredits: number;
  callMinutes: number;
  smsCount: number;
}

interface EntitlementRow {
  user_id?: unknown;
  plan?: unknown;
  is_admin?: unknown;
  cloud_sync_allowed?: unknown;
  message_credits?: unknown;
  call_minutes?: unknown;
  sms_count?: unknown;
}

let cache: { userId: string; value: MyEntitlements; expiresAt: number } | null = null;

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function parseRow(row: EntitlementRow | undefined, expectedUserId: string): MyEntitlements | null {
  if (!row || row.user_id !== expectedUserId || !VALID_PLANS.has(row.plan as PlanId)) return null;
  return {
    userId: expectedUserId,
    plan: row.plan as PlanId,
    isAdmin: row.is_admin === true,
    cloudSyncAllowed: row.cloud_sync_allowed === true,
    messageCredits: safeCount(row.message_credits),
    callMinutes: safeCount(row.call_minutes),
    smsCount: safeCount(row.sms_count),
  };
}

/** Fetch only the authenticated caller's server-owned entitlements. */
export async function fetchMyEntitlements(
  userId: string,
  options: { force?: boolean } = {},
): Promise<MyEntitlements | null> {
  if (!userId) return null;
  if (!options.force && cache?.userId === userId && cache.expiresAt > Date.now()) {
    return cache.value;
  }

  const client = getSupabaseClient();
  if (!client) return null;
  try {
    // 0045 adds this RPC; generated Database types only list a subset.
    const { data, error } = await (
      client.rpc as unknown as (
        fn: 'get_my_entitlements',
      ) => Promise<{ data: unknown; error: unknown }>
    )('get_my_entitlements');
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as EntitlementRow | undefined;
    const value = parseRow(row, userId);
    if (!value) return null;
    cache = { userId, value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch {
    return null;
  }
}

export function clearEntitlementsCache(): void {
  cache = null;
}
