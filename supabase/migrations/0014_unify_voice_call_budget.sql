-- =============================================================================
-- 0014_unify_voice_call_budget: cloud voice now draws from the call/voice budget
-- =============================================================================
-- Cloud TTS (tts-speak) previously reserved against a SEPARATE voice budget
-- ($2/$10/$20 in 0012). Per the finalized plan model, cloud voice and AI calling
-- SHARE a single call/voice budget ($2.50/$12.50/$25). tts-speak now reserves via
-- reserve_call_budget (call_usage). This migration aligns the legacy
-- voice_budget_for_plan figures so the voice_usage metering mirror stays
-- consistent, and documents the change. reserve_voice_seconds is retained for
-- backward compatibility but is no longer the gate for cloud TTS.
-- =============================================================================

create or replace function public.voice_budget_for_plan(p_plan text)
returns numeric language sql immutable as $$
  -- Mirrors subscription_plan_limits.call_budget_usd (the shared call/voice bucket).
  select case p_plan
           when 'starter' then 2.50::numeric
           when 'pro'     then 12.50::numeric
           when 'ultra'   then 25.00::numeric
           else 0::numeric end;
$$;

comment on function public.voice_budget_for_plan(text) is
  'Legacy helper. Cloud voice now shares the call/voice budget (call_usage); '
  'tts-speak reserves via reserve_call_budget. Kept for compatibility.';

comment on function public.reserve_voice_seconds(uuid, integer) is
  'DEPRECATED for cloud TTS gating: tts-speak now uses reserve_call_budget so '
  'cloud voice and AI calling share one budget. Retained for compatibility.';
