// @ts-nocheck
// get-message-usage: returns the authenticated user's full usage picture —
// AI message credits, call minutes, and SMS texts — including monthly,
// weekly (25%) and 5-hour (8%) window remainders, as friendly units
// (never raw dollar budgets).
//
// Backward compatible: the original top-level message_credits_* fields are
// still returned for older clients.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.46.2';
import { json } from '../_shared/voice.ts';
import {
  USD_PER_CALL_MINUTE,
  USD_PER_MESSAGE_CREDIT,
  USD_PER_SMS,
  WINDOW_5H_FRACTION,
  WINDOW_WEEK_FRACTION,
} from '../_shared/budget.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const WINDOW_5H_MS = 5 * 60 * 60 * 1000;
const WINDOW_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface UsageRow {
  plan?: string;
  monthly_budget_usd?: number;
  used_usd?: number;
  reset_date?: string | null;
  window_5h_start?: string | null;
  window_5h_used_usd?: number;
  window_week_start?: string | null;
  window_week_used_usd?: number;
}

/** Remaining dollars in a fixed window, accounting for lazy window rolls. */
function windowRemainingUsd(
  budget: number,
  fraction: number,
  start: string | null | undefined,
  used: number | undefined,
  spanMs: number,
): number {
  const cap = budget * fraction;
  if (!start) return Math.max(0, cap);
  const elapsed = Date.now() - new Date(start).getTime();
  if (elapsed >= spanMs) return Math.max(0, cap);
  return Math.max(0, cap - Number(used ?? 0));
}

function bucket(row: UsageRow | null, usdPerUnit: number, included: number) {
  const budget = Number(row?.monthly_budget_usd ?? 0);
  const used = Number(row?.used_usd ?? 0);
  const remainingUsd = Math.max(0, budget - used);
  const rem5h = windowRemainingUsd(
    budget, WINDOW_5H_FRACTION, row?.window_5h_start, row?.window_5h_used_usd, WINDOW_5H_MS,
  );
  const remWeek = windowRemainingUsd(
    budget, WINDOW_WEEK_FRACTION, row?.window_week_start, row?.window_week_used_usd, WINDOW_WEEK_MS,
  );
  const toUnits = (usd: number) => Math.max(0, Math.floor(usd / usdPerUnit));
  const usedUnits = Math.min(included, Math.round(used / usdPerUnit));
  return {
    included,
    used: usedUnits,
    remaining: Math.max(0, included - usedUnits),
    // Effective remaining = tightest of the three windows.
    remaining_now: Math.min(toUnits(remainingUsd), toUnits(remWeek), toUnits(rem5h)),
    window_5h_remaining: toUnits(Math.min(rem5h, remainingUsd)),
    window_weekly_remaining: toUnits(Math.min(remWeek, remainingUsd)),
    available: budget > 0 && used < budget,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: json({}, 200, origin).headers });
  if (req.method !== 'GET' && req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  const jwt = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!jwt) return json({ error: 'unauthorized' }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: userData, error } = await userClient.auth.getUser(jwt);
  if (error || !userData?.user) return json({ error: 'unauthorized' }, 401, origin);
  const userId = userData.user.id;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const usageCols =
    'plan, monthly_budget_usd, used_usd, reset_date, window_5h_start, window_5h_used_usd, window_week_start, window_week_used_usd';
  const [{ data: msg }, { data: call }, { data: sms }, { data: adminFlag }] = await Promise.all([
    admin.from('message_usage').select(usageCols).eq('user_id', userId).maybeSingle(),
    admin.from('call_usage').select(usageCols).eq('user_id', userId).maybeSingle(),
    admin.from('sms_usage').select(usageCols).eq('user_id', userId).maybeSingle(),
    admin.rpc('is_app_admin', { p_user_id: userId }),
  ]);

  const plan = (msg?.plan ?? call?.plan ?? sms?.plan ?? 'free') as string;
  const { data: limits } = await admin
    .from('subscription_plan_limits')
    .select('message_credits, call_minutes, sms_count')
    .eq('plan', plan)
    .maybeSingle();

  const messageBucket = bucket(msg, USD_PER_MESSAGE_CREDIT, Number(limits?.message_credits ?? 0));
  const callBucket = bucket(call, USD_PER_CALL_MINUTE, Number(limits?.call_minutes ?? 0));
  const smsBucket = bucket(sms, USD_PER_SMS, Number(limits?.sms_count ?? 0));

  return json(
    {
      plan,
      admin_unlimited: Boolean(adminFlag),
      reset_date: msg?.reset_date ?? call?.reset_date ?? sms?.reset_date ?? null,
      message: messageBucket,
      call: callBucket,
      sms: smsBucket,
      // Legacy fields (pre-0021 clients).
      message_credits_included: messageBucket.included,
      message_credits_used: messageBucket.used,
      message_credits_remaining: messageBucket.remaining,
      company_messaging_available: messageBucket.available,
    },
    200,
    origin,
  );
});
