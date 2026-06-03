-- =============================================================================
-- 0005_models_catalog: public catalog of AI models known to Jarvis
-- =============================================================================
-- Read-only for all clients; service role manages contents. The frontend
-- model picker can hydrate from this table instead of hardcoding lists.

create table if not exists public.models_catalog (
  id                        text primary key,
  provider                  text not null,
  display_name              text not null,
  family                    text,
  context_window            integer,
  max_output_tokens         integer,
  input_price_per_million   numeric(10, 4),
  output_price_per_million  numeric(10, 4),
  capabilities              text[] not null default '{}',
  supports_streaming        boolean not null default true,
  supports_tools            boolean not null default false,
  supports_vision           boolean not null default false,
  supports_reasoning        boolean not null default false,
  available_in_tiers        text[] not null default '{}',
  byok_supported            boolean not null default true,
  enabled                   boolean not null default true,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index if not exists models_catalog_provider_idx on public.models_catalog (provider);

alter table public.models_catalog enable row level security;
drop policy if exists "models catalog public read" on public.models_catalog;
create policy "models catalog public read" on public.models_catalog
  for select
  using (true);

drop trigger if exists models_catalog_touch_updated on public.models_catalog;
create trigger models_catalog_touch_updated
  before update on public.models_catalog
  for each row
  when (old.updated_at is not distinct from new.updated_at)
  execute function public.touch_updated_at_ts();

-- Seed -------------------------------------------------------------------------
-- Prices and capabilities reflect provider docs as of late 2025; refresh as
-- they drift. `available_in_tiers` mirrors entitlements.ts hostedModels.
insert into public.models_catalog
  (id, provider, display_name, family, context_window, max_output_tokens,
   input_price_per_million, output_price_per_million,
   capabilities, supports_streaming, supports_tools, supports_vision,
   supports_reasoning, available_in_tiers, byok_supported, enabled)
values
  -- Google Gemini
  ('gemini-2.5-flash-lite','google','Gemini 2.5 Flash Lite','gemini',
    1048576, 8192, 0.10, 0.40,
    array['text','vision','tools'], true, true, true, false,
    array['starter','pro','ultra'], true, true),
  ('gemini-2.5-flash','google','Gemini 2.5 Flash','gemini',
    1048576, 8192, 0.30, 2.50,
    array['text','vision','tools','reasoning'], true, true, true, true,
    array['starter','pro','ultra'], true, true),
  ('gemini-2.5-pro','google','Gemini 2.5 Pro','gemini',
    2097152, 8192, 1.25, 5.00,
    array['text','vision','tools','reasoning'], true, true, true, true,
    array['pro','ultra'], true, true),
  -- Anthropic Claude
  ('claude-3-5-sonnet-latest','anthropic','Claude 3.5 Sonnet','claude',
    200000, 8192, 3.00, 15.00,
    array['text','vision','tools'], true, true, true, false,
    array['pro','ultra'], true, true),
  ('claude-3-opus-latest','anthropic','Claude 3 Opus','claude',
    200000, 4096, 15.00, 75.00,
    array['text','vision','tools'], true, true, true, false,
    array['ultra'], true, true),
  -- OpenAI GPT
  ('gpt-4o','openai','GPT-4o','gpt',
    128000, 16384, 2.50, 10.00,
    array['text','vision','tools'], true, true, true, false,
    array['pro','ultra'], true, true),
  ('gpt-4o-mini','openai','GPT-4o mini','gpt',
    128000, 16384, 0.15, 0.60,
    array['text','vision','tools'], true, true, true, false,
    array[]::text[], true, true),
  ('o1','openai','o1','gpt-reasoning',
    200000, 100000, 15.00, 60.00,
    array['text','reasoning'], true, false, false, true,
    array['ultra'], true, true),
  ('o1-mini','openai','o1-mini','gpt-reasoning',
    128000, 65536, 3.00, 12.00,
    array['text','reasoning'], true, false, false, true,
    array['ultra'], true, true),
  -- DeepSeek
  ('deepseek-chat','deepseek','DeepSeek Chat','deepseek',
    64000, 4096, 0.14, 0.28,
    array['text','tools'], true, true, false, false,
    array[]::text[], true, true),
  ('deepseek-reasoner','deepseek','DeepSeek Reasoner','deepseek',
    64000, 8192, 0.55, 2.19,
    array['text','reasoning'], true, false, false, true,
    array[]::text[], true, true),
  -- Groq
  ('llama-3.3-70b-versatile','groq','Llama 3.3 70B (Groq)','llama',
    128000, 8192, 0.59, 0.79,
    array['text','tools'], true, true, false, false,
    array[]::text[], true, true),
  -- xAI
  ('grok-2-latest','xai','Grok 2','grok',
    131072, 4096, 2.00, 10.00,
    array['text'], true, false, false, false,
    array[]::text[], true, true),
  -- Mistral
  ('mistral-large-latest','mistral','Mistral Large','mistral',
    128000, 4096, 2.00, 6.00,
    array['text','tools'], true, true, false, false,
    array[]::text[], true, true),
  -- Cohere
  ('command-r-plus','cohere','Command R+','cohere',
    128000, 4096, 2.50, 10.00,
    array['text','tools'], true, true, false, false,
    array[]::text[], true, true),
  -- Local
  ('llama3.2','ollama','Llama 3.2 (local)','llama',
    128000, 4096, 0, 0,
    array['text'], true, false, false, false,
    array['free','starter','pro','ultra'], true, true),
  -- Mock for dev
  ('mock','mock','Mock provider','mock',
    8192, 4096, 0, 0,
    array['text'], true, false, false, false,
    array['free','starter','pro','ultra'], true, true)
on conflict (id) do nothing;
