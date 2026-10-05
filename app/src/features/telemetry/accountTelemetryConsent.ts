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
  withdrawal?: Readonly<{
    status: 'not_requested' | 'pending' | 'reconciled' | 'failed';
    requestRevision?: string;
  }>;
}>;

export type AccountTelemetryResult =
  { ok: true; state: AccountTelemetryConsent } | { ok: false; error: string };

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
  if (state.withdrawal !== undefined) {
    const withdrawal = state.withdrawal as Record<string, unknown> | null;
    if (
      !withdrawal ||
      typeof withdrawal !== 'object' ||
      !['not_requested', 'pending', 'reconciled', 'failed'].includes(String(withdrawal.status)) ||
      (withdrawal.requestRevision !== undefined && typeof withdrawal.requestRevision !== 'string')
    )
      return null;
  }
  return state as unknown as AccountTelemetryConsent;
}

async function invoke(
  options: Record<string, unknown>,
  expectedAccountId?: string,
): Promise<AccountTelemetryResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, error: 'cloud_not_configured' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<AccountTelemetryResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: 'request_timeout' });
    }, 15_000);
  });
  const request = async (): Promise<AccountTelemetryResult> => {
    try {
      if (expectedAccountId) {
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (controller.signal.aborted) return { ok: false, error: 'request_timeout' };
        const session = sessionData.session;
        if (sessionError || session?.user.id !== expectedAccountId || !session.access_token)
          return { ok: false, error: 'account_changed' };
        const { data, error } = await client.auth.getUser(session.access_token);
        if (controller.signal.aborted) return { ok: false, error: 'request_timeout' };
        if (error || data.user?.id !== expectedAccountId)
          return { ok: false, error: 'account_changed' };
        options = { ...options, headers: { Authorization: `Bearer ${session.access_token}` } };
      }
      const { data, error } = await client.functions.invoke('telemetry-consent', {
        ...options,
        signal: controller.signal,
      });
      if (error) {
        // Preserve only the public, known configuration failure. Other server
        // details remain private and must never become UI error strings.
        const response = error.context;
        if (response instanceof Response && response.status === 503) {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          if (
            body &&
            typeof body === 'object' &&
            'error' in body &&
            body.error === 'telemetry_reward_unconfigured'
          ) {
            return { ok: false, error: 'telemetry_reward_unconfigured' };
          }
        }
        return { ok: false, error: 'request_failed' };
      }
      const state = parseState(data);
      return state ? { ok: true, state } : { ok: false, error: 'invalid_server_response' };
    } catch {
      return { ok: false, error: 'request_failed' };
    }
  };
  try {
    return await Promise.race([request(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function getAccountTelemetryConsent(
  expectedAccountId?: string,
): Promise<AccountTelemetryResult> {
  return invoke({ method: 'GET' }, expectedAccountId);
}

export function updateAccountTelemetryConsent(
  enabled: boolean,
  current: Pick<AccountTelemetryConsent, 'policyVersion' | 'requiredDataClasses'>,
  expectedAccountId?: string,
): Promise<AccountTelemetryResult> {
  return invoke(
    {
      method: 'PUT',
      body: {
        enabled,
        policyVersion: current.policyVersion,
        dataClasses: enabled ? [...current.requiredDataClasses] : [],
      },
    },
    expectedAccountId,
  );
}
