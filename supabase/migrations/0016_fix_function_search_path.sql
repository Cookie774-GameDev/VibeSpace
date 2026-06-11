-- =============================================================================
-- 0016_fix_function_search_path: pin search_path on remaining public functions
-- =============================================================================
-- Supabase security advisor (function_search_path_mutable) flagged three
-- functions created in 0012-0014 without an explicit search_path. A mutable
-- search_path lets a caller's role-level search_path setting redirect
-- unqualified identifiers to attacker-controlled schemas. All three already
-- schema-qualify their references, so this is hardening / advisor hygiene,
-- not an active vulnerability.

alter function public.voice_seconds_for_budget(numeric) set search_path = public;
alter function public.voice_budget_for_plan(text) set search_path = public;
alter function public.get_current_plan_limits(text) set search_path = public;
