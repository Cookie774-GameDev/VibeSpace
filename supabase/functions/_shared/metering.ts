import { estimateMessageCostUsd } from './budget';

export function buildMessageReservationEstimate(
  promptChars: number,
  requestedCompletionTokens: unknown,
  defaultCompletionTokens: number,
  maxCompletionTokens: number,
): { promptTokens: number; completionTokens: number; estimatedCostUsd: number } {
  const promptTokens = Math.ceil(Math.max(0, promptChars) / 4);
  const requested =
    typeof requestedCompletionTokens === 'number' && Number.isFinite(requestedCompletionTokens)
      ? Math.round(requestedCompletionTokens)
      : defaultCompletionTokens;
  const completionTokens = Math.min(
    Math.max(1, Math.floor(maxCompletionTokens)),
    Math.max(1, requested),
  );
  return {
    promptTokens,
    completionTokens,
    estimatedCostUsd: estimateMessageCostUsd(promptTokens, completionTokens),
  };
}

export interface RpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

interface ReserveMeteredUsageInput {
  userId: string;
  kind: 'message' | 'call' | 'sms';
  estimateUsd: number;
  idempotencyKey: string;
  count?: number;
  context?: Record<string, unknown>;
}

export type MeteredReservation =
  | { ok: false; reason: string; [key: string]: unknown }
  | { ok: true; reservationId: string; reservedCount?: number; [key: string]: unknown };

export async function reserveMeteredUsage(
  client: RpcClient,
  input: ReserveMeteredUsageInput,
): Promise<MeteredReservation> {
  const { data, error } = await client.rpc('reserve_usage_budget', {
    p_user_id: input.userId,
    p_kind: input.kind,
    p_estimate_usd: input.estimateUsd,
    p_idempotency_key: input.idempotencyKey,
    p_count: input.count ?? 0,
    p_context: input.context ?? {},
  });
  if (error || !data || typeof data !== 'object') {
    return { ok: false, reason: 'usage_unavailable' };
  }
  const result = data as Record<string, unknown>;
  if (result.ok !== true || typeof result.reservation_id !== 'string') {
    return {
      ...result,
      ok: false,
      reason: typeof result.reason === 'string' ? result.reason : 'usage_unavailable',
    };
  }
  const reservedCount = Number(result.reserved_count);
  return {
    ...result,
    ok: true,
    reservationId: result.reservation_id,
    ...(Number.isInteger(reservedCount) && reservedCount >= 0 ? { reservedCount } : {}),
  };
}

interface ReserveBoundedCallUsageInput {
  userId: string;
  idempotencyKey: string;
  maxSeconds: number;
  minSeconds: number;
  costPerSecondUsd: number;
  rateLimitWindowStart: string;
  rateLimitMaxRequests: number;
  context?: Record<string, unknown>;
}

export async function reserveBoundedCallUsage(
  client: RpcClient,
  input: ReserveBoundedCallUsageInput,
): Promise<MeteredReservation> {
  const maxSeconds = Math.floor(input.maxSeconds);
  const minSeconds = Math.max(1, Math.floor(input.minSeconds));
  const costPerSecondUsd = input.costPerSecondUsd;
  if (!Number.isFinite(costPerSecondUsd) || costPerSecondUsd <= 0 || maxSeconds < minSeconds) {
    return { ok: false, reason: 'invalid_reservation' };
  }

  const { data: rateData, error: rateError } = await client.rpc('voice_rate_limit_hit', {
    p_user_id: input.userId,
    p_window_start: input.rateLimitWindowStart,
    p_chars: 0,
    p_max_requests: Math.max(1, Math.floor(input.rateLimitMaxRequests)),
  });
  if (rateError || !rateData || typeof rateData !== 'object') {
    return { ok: false, reason: 'usage_unavailable' };
  }
  if ((rateData as { limited?: boolean }).limited === true) {
    return { ok: false, reason: 'rate_limited' };
  }

  let seconds = maxSeconds;
  let lastFailure: MeteredReservation = { ok: false, reason: 'usage_unavailable' };
  // The legacy reserve RPC reports one limiting window at a time. Four bounded
  // attempts cover 5-hour, weekly, monthly, and one concurrent-spend retry.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await reserveMeteredUsage(client, {
      userId: input.userId,
      kind: 'call',
      estimateUsd: seconds * costPerSecondUsd,
      idempotencyKey: input.idempotencyKey,
      count: seconds,
      context: input.context,
    });
    if (result.ok) {
      const reservedCount = result.reservedCount ?? (result.duplicate ? NaN : seconds);
      if (!Number.isInteger(reservedCount)
          || reservedCount < minSeconds
          || reservedCount > maxSeconds) {
        return { ok: false, reason: 'usage_unavailable' };
      }
      return { ...result, reservedCount };
    }

    lastFailure = result;
    const remainingUsd = Number(result.remaining_usd);
    if (!Number.isFinite(remainingUsd) || remainingUsd <= 0) return result;
    const affordableSeconds = Math.floor(
      (remainingUsd + costPerSecondUsd * 1e-9) / costPerSecondUsd,
    );
    const nextSeconds = Math.min(seconds - 1, affordableSeconds, maxSeconds);
    if (nextSeconds < minSeconds) return result;
    seconds = nextSeconds;
  }
  return lastFailure;
}

interface SettleMeteredUsageInput {
  userId: string;
  reservationId: string;
  actualUsd: number;
  actualCount?: number;
  status: 'settled' | 'released' | 'failed' | 'canceled' | 'refunded';
}

export async function settleMeteredUsage(
  client: RpcClient,
  input: SettleMeteredUsageInput,
): Promise<boolean> {
  const { data, error } = await client.rpc('settle_usage_budget', {
    p_user_id: input.userId,
    p_reservation_id: input.reservationId,
    p_actual_usd: Math.max(0, input.actualUsd),
    p_actual_count: Math.max(0, input.actualCount ?? 0),
    p_status: input.status,
  });
  return !error && Boolean((data as { ok?: boolean } | null)?.ok);
}
