import { getSupabaseClient } from '@/lib/supabase/client';

export const TELEMETRY_REWARD_PERCENT = 10 as const;
export const TELEMETRY_REWARD_DATA_CLASSES = [
  'product_usage',
  'diagnostics',
  'tool_outcomes',
] as const;

export type AccountTelemetryConsent = Readonly<{
  enabled: boolean;
  eligible: boolean;
  policyVersion: string;
  noticeUrl: string;
  discountPercent: 10;
  requiredDataClasses: readonly ['product_usage', 'diagnostics', 'tool_outcomes'];
}>;

export type AccountTelemetryResult =
  | { ok: true; state: AccountTelemetryConsent }
  | { ok: false; error: string };

function parseState(value: unknown): AccountTelemetryConsent | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (
    typeof state.enabled !== 'boolean' ||
    typeof state.eligible !== 'boolean' ||
    typeof state.policyVersion !== 'string' ||
    !state.policyVersion ||
    typeof state.noticeUrl !== 'string' ||
    state.discountPercent !== TELEMETRY_REWARD_PERCENT ||
    !Array.isArray(state.requiredDataClasses) ||
    state.requiredDataClasses.join('\0') !== TELEMETRY_REWARD_DATA_CLASSES.join('\0')
  ) {
    return null;
  }
  try {
    const notice = new URL(state.noticeUrl);
    if (notice.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return state as unknown as AccountTelemetryConsent;
}

async function invoke(options: Record<string, unknown>): Promise<AccountTelemetryResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, error: 'cloud_not_configured' };
  try {
    const { data, error } = await client.functions.invoke('telemetry-consent', options);
    if (error) return { ok: false, error: error.message || 'request_failed' };
    const state = parseState(data);
    return state ? { ok: true, state } : { ok: false, error: 'invalid_server_response' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'request_failed' };
  }
}

export function getAccountTelemetryConsent(): Promise<AccountTelemetryResult> {
  return invoke({ method: 'GET' });
}

export function updateAccountTelemetryConsent(
  enabled: boolean,
  current: Pick<AccountTelemetryConsent, 'policyVersion' | 'requiredDataClasses'>,
): Promise<AccountTelemetryResult> {
  return invoke({
    method: 'PUT',
    body: {
      enabled,
      policyVersion: current.policyVersion,
      dataClasses: enabled ? [...current.requiredDataClasses] : [],
    },
  });
}
