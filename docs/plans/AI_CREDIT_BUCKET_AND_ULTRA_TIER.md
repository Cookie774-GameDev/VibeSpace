# AI Credit Bucket + $200 Supernova Tier — Implementation Plan

**Status:** Planning only (no code, migrations, or Stripe changes in this doc)  
**Last updated:** June 2026  
**Audience:** Implementation agent  
**Related:** `[docs/SUBSCRIPTION_PLANS_REFERENCE.md](../SUBSCRIPTION_PLANS_REFERENCE.md)`, `supabase/migrations/0021_subscription_plan_v2.sql`, `supabase/functions/message-complete/index.ts`, `supabase/functions/_shared/budget.ts`, `app/src/lib/entitlements.ts`

---

## 1. Executive summary

This release adds two coupled capabilities:

1. **$200 / month tier (`apex` / Supernova)** — exactly **2× every scaling quota** of the current $100 Singularity (`ultra`) tier.
2. **Unified AI credit bucket** — one monthly pool of **AI credits** that pays for **any hosted model** across chat, agents, and council. Credits are **not** terminal-specific and **do not** apply to terminal inference.

The credit bucket replaces today’s DeepSeek-only **message credits** with a **model-agnostic, USD-denominated** wallet. **DeepSeek V4 Flash** remains the **reference SKU** for marketing copy and margin math, but expensive models (Claude Opus, GPT-5.5, etc.) burn credits faster because they cost more per token.

**Explicitly out of scope for this release:**

- Vibe Hive / stack pipelines / `stack-complete`
- Terminal billing or hosted terminal inference
- Overage billing (same policy as today: throttle → BYOK/local fallback)

---

## 2. Tier ladder after this release


| Internal ID | Display name  | Price/mo | Notes                                               |
| ----------- | ------------- | -------- | --------------------------------------------------- |
| `free`      | Spark         | $0       | Unchanged                                           |
| `starter`   | Orbit         | $10      | Unchanged                                           |
| `pro`       | Nova          | $50      | Unchanged                                           |
| `ultra`     | Singularity   | $100     | Unchanged quotas; bucket becomes unified AI credits |
| `**apex`**  | **Supernova** | **$200** | **New — 2× Singularity on every scaling dimension** |


**Naming rationale:** The product already uses cosmic tier names (Spark → Singularity). **Supernova** signals “2× Singularity” without reusing “Ultra” (which maps to $100 today). Internal id `**apex`** sits above `ultra` in sort order and avoids colliding with existing Stripe/env names (`STRIPE_ULTRA_PRICE_ID`).

---

## 3. Singularity ($100) vs Supernova ($200) — doubling rules

### 3.1 Rule (locked)

> **Supernova doubles every monthly quota that scales with subscription COGS.**  
> Boolean entitlements that are already `true` on Singularity stay `true` on Supernova (no new feature flags required).

### 3.2 Full comparison table


| Dimension                                      | Singularity (`ultra`) $100           | Supernova (`apex`) $200                     | Doubles?        |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------- | --------------- |
| **Sticker price**                              | $100/mo                              | $200/mo                                     | ✓ (2× price)    |
| **AI credit bucket (hosted inference)**        | 31,000 credits/mo                    | **62,000 credits/mo**                       | ✓               |
| **AI budget (internal USD)**                   | $31.00                               | **$62.00**                                  | ✓               |
| **Call/voice bucket (Deepgram-backed)**        | $21.70 / ~217 phone min headline     | **$43.40 / ~434 phone min**                 | ✓               |
| **SMS bucket**                                 | ~~930 texts (~~$9.30)                | ~~**1,860 texts (~~$18.60)**                | ✓               |
| **Launch Deepgram promo (phase 1)**            | 3 hr (10,800 s)                      | **6 hr (21,600 s)**                         | ✓               |
| **Launch Deepgram promo (phase 2 @ $5k pool)** | 15 hr (54,000 s)                     | **30 hr (108,000 s)**                       | ✓               |
| **Triple rate windows (5h / week / month)**    | 8% / 25% / 100% of monthly AI budget | Same fractions, 2× absolute caps            | ✓ (caps)        |
| **Jarvis Call (PSTN)**                         | ✓                                    | ✓                                           | — (already max) |
| **Cloud sync**                                 | ✓                                    | ✓                                           | —               |
| **Tool publishing**                            | ✓                                    | ✓                                           | —               |
| **Priority routing**                           | ✓                                    | ✓                                           | —               |
| **Unlimited local Kokoro**                     | ✓                                    | ✓                                           | —               |
| **BYOK (all providers)**                       | ✓                                    | ✓                                           | —               |
| **Early access / support email**               | ✓                                    | ✓ (keep; optional “white-glove” copy later) | —               |


### 3.3 Internal economics (maintainers)

Preserve the **38% gross margin / 62% COGS** envelope from migration `0021`, with the same **50 / 35 / 15** split across AI / calls / SMS:

```
Supernova $200/mo COGS = $124.00
  AI credits budget  = $62.00  → 62,000 credits @ $0.001/credit
  Call/voice budget  = $43.40  → ~434 headline PSTN minutes @ $0.10/min
  SMS budget         = $18.60  → ~1,860 texts @ $0.01/segment
```

Orbit and Nova tiers **do not change** in this release unless product explicitly requests a ladder re-balance later.

---

## 4. AI credit bucket model

### 4.1 What is a credit?


| Property          | Value                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| **Definition**    | 1 AI credit = **$0.001** of company inference spend                                               |
| **Display unit**  | Integer credits (same UX convention as today’s “message credits”)                                 |
| **Settlement**    | **Actual** provider cost after the call completes (not estimate-only)                             |
| **Reference SKU** | **DeepSeek V4 Flash** (`deepseek-chat`) — used for marketing equivalence and margin sanity checks |


**Marketing equivalence (Singularity):**  
31,000 credits ≈ “~31,000 DeepSeek V4 Flash–equivalent credit units per month.”  
A single Claude Opus turn might consume **hundreds** of credits because token cost is higher — that is correct behavior.

### 4.2 Credit formula sketch

```text
# Reservation (before provider call — conservative)
est_usd = estimateModelCostUsd(model_id, est_prompt_tokens, est_completion_tokens)
est_credits = ceil(est_usd / USD_PER_AI_CREDIT)     # USD_PER_AI_CREDIT = 0.001

# Settlement (after provider returns usage block)
actual_usd = actualModelCostUsd(model_id, usage)    # cache-hit aware where applicable
actual_credits = ceil(actual_usd / USD_PER_AI_CREDIT)

# Refund on settle
refund_credits = max(0, reserved_credits - actual_credits)
```

**Model cost catalog** (server-side, not client-editable):

```text
actualModelCostUsd(model, usage) =
  usage.input_tokens  × catalog.input_usd_per_token(model)
+ usage.output_tokens × catalog.output_usd_per_token(model)
+ usage.cache_read_tokens × catalog.cache_read_usd_per_token(model)   # if provider reports
+ fixed_call_surcharge_usd(model)                                      # usually 0
```

DeepSeek V4 Flash coefficients already live in `budget.ts` (`DEEPSEEK_IN_MISS_PER_TOKEN`, etc.). The catalog generalizes this for every allowlisted hosted model.

**Example burns (illustrative):**


| Request profile                     | Company USD | Credits |
| ----------------------------------- | ----------- | ------- |
| DeepSeek V4 Flash — 2k in / 800 out | ~$0.0005    | 1       |
| Gemini 2.5 Flash — 4k in / 1k out   | ~$0.003     | 3       |
| Claude 3.5 Sonnet — 4k in / 1k out  | ~$0.027     | 27      |
| GPT-4o — 4k in / 1k out             | ~$0.020     | 20      |


Council mode with **3 agents** on the same user message ≈ **3×** single-agent burn (each agent turn is a separate hosted call).

### 4.3 Rollover, reset, exhaustion


| Policy              | Decision                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Rollover**        | **No** — unused credits forfeit at billing-cycle reset (same as today)                                             |
| **Reset anchor**    | Stripe `subscriptions.current_period_end`; calendar-month fallback                                                 |
| **Rate windows**    | Keep triple windows on the AI bucket: **5h = 8%**, **week = 25%**, **month = 100%** of monthly AI budget           |
| **Exhaustion**      | Return `budget_exceeded` / `rate_window_exceeded`; client falls back to **BYOK → local → mock** (existing pattern) |
| **Overage billing** | **None** — never charge surprise overages                                                                          |
| **Admin**           | `app_admins` bypass reservation (unchanged)                                                                        |


### 4.4 BYOK vs hosted


| Path                                                     | Credits consumed? | When                                                  |
| -------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| **BYOK** (user API key in OS keychain)                   | **No**            | Always available on every tier                        |
| **Local** (Ollama / Kokoro)                              | **No**            | Always available                                      |
| **Hosted** (company-paid edge proxy)                     | **Yes**           | Orbit+ when user has no key for chosen provider/model |
| **Free Gemini Flash Lite** (Spark Google AI Studio path) | **No**            | Spark only; not part of credit bucket                 |


**Precedence (hosted attempt):**

1. If user has BYOK key for provider → client calls provider directly (**free to company**).
2. Else if plan includes hosted chat (`plan !== 'free'`) → route through hosted edge proxy → **reserve / settle credits**.
3. Else → error / nudge to add key or subscribe.

---

## 5. Surfaces that consume AI credits

### 5.1 In scope (YES)


| Surface                                | Code touchpoints                         | Notes                                          |
| -------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| **Main chat composer**                 | `runtime.ts` → `runAgent()` / router     | Every assistant turn                           |
| **Custom agents**                      | Same runtime path                        | Per-agent model selection respected            |
| **Council mode**                       | `CouncilView` + runtime multi-agent loop | **Each agent turn** draws from the same bucket |
| **Agent picker / @mentions**           | Composer mention routing                 | No separate wallet                             |
| **Action auto-approval LLM turns**     | `runtime.ts` action pipeline             | If routed through hosted path                  |
| **Future: inline tools that call LLM** | Any edge-hosted completion               | Must call same reserve/settle RPCs             |


### 5.2 Explicitly excluded (NO)


| Surface                               | Reason                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Terminals / PTY / terminal swarm**  | User requirement: **NOT TER / NOT terminal-specific**. Terminals stay **BYOK-only** for cloud inference. |
| **Vibe Hive / stack pipelines**       | **Out of scope this release** (see §10)                                                                  |
| **Voice module — cloud Deepgram TTS** | Separate **call/voice** Deepgram bucket                                                                  |
| **Jarvis Call (PSTN)**                | Separate **call/voice** bucket                                                                           |
| **Global STT (`Ctrl+CapsLock`)**      | Deepgram promo → call/voice bucket                                                                       |
| **SMS**                               | Separate SMS bucket                                                                                      |
| **Local Kokoro TTS**                  | Free, unmetered                                                                                          |


### 5.3 Architecture diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│                     USER INFERENCE REQUEST                       │
└───────────────────────────────┬─────────────────────────────────┘
                                │
              ┌─────────────────┴─────────────────┐
              │         Client routing             │
              └─────────────────┬─────────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
    BYOK key?              Local / offline?      Paid + no key
         │                      │                      │
         ▼                      ▼                      ▼
   Provider adapter        Ollama / mock      hosted-inference-complete
   (no credits)            (no credits)       reserve → call → settle
                                                      │
                                                      ▼
                                            ai_credit_usage bucket
                                            (one pool, all models)
```

---

## 6. Model-agnostic routing

### 6.1 Today vs target


| Aspect           | Today (`message-complete`)                                        | Target (this release)                                                                                                      |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Models           | **DeepSeek V4 Flash only** (`ALLOWED_MODELS = ['deepseek-chat']`) | **Allowlisted catalog** per provider                                                                                       |
| Providers        | DeepSeek                                                          | google, deepseek, openai, anthropic, groq, mistral, openrouter, xai (match `HOSTED_STACK_PROVIDERS` intent in `models.ts`) |
| Metering         | `message_usage` USD bucket                                        | `ai_credit_usage` unified bucket                                                                                           |
| Client allowlist | `entitlements.hostedModels` per tier                              | **Remove per-tier model gating for hosted** — tier controls **budget size**, not model SKU (BYOK still unrestricted)       |


### 6.2 Server allowlist policy

- Client sends `{ provider, model, messages, ... }`.
- Edge function validates `(provider, model)` against `**hosted_model_catalog`** table.
- Unknown or deprecated SKUs → `model_not_allowed` + BYOK fallback hint.
- Catalog updates are **server-side only** (no client price trust).

### 6.3 Singularity vs Supernova model access

Both paid tiers ($50+) get the **same hosted model catalog**. Supernova’s advantage is **2× credits**, not exclusive models. Optional future: Supernova-only preview SKUs — **not in v1**.

---

## 7. DeepSeek V4 Flash as reference SKU

Use DeepSeek V4 Flash for three distinct purposes:


| Purpose                     | How                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Marketing headline**      | “62,000 AI credits — DeepSeek V4 Flash equivalent units” on Supernova card                                                      |
| **Margin calibration**      | When adding a new model to the catalog, compare $/1M tokens to DeepSeek; ensure worst-case full-burn stays inside COGS envelope |
| **Budget regression tests** | Integration tests assume DeepSeek pricing from `budget.ts` as baseline                                                          |


**Do not** hard-code all inference to DeepSeek in the hosted proxy — the reference SKU is for **accounting and copy**, not runtime restriction.

---

## 8. Supabase schema sketch (tables only — no migration files)

### 8.1 Plan limits — extend `subscription_plan_limits`

Add row for `apex`:

```sql
-- Illustrative values only (implement in migration later)
('apex', 62.00, 43.40, 18.60, 62000, 434, 1860)
-- columns: plan, message_budget_usd, call_budget_usd, sms_budget_usd,
--          message_credits → rename to ai_credits, call_minutes, sms_count
```

**Recommended rename:** `message_credits` → `**ai_credits`**, `message_budget_usd` → `**ai_budget_usd**` in plan limits and usage tables (migration can alias old names during transition).

### 8.2 `ai_credit_usage` (replaces / supersedes `message_usage`)


| Column                                      | Type                 | Notes                                                     |
| ------------------------------------------- | -------------------- | --------------------------------------------------------- |
| `user_id`                                   | uuid PK → auth.users | One row per user                                          |
| `plan`                                      | text                 | Mirrors `profiles.tier`                                   |
| `monthly_budget_usd`                        | numeric              | From plan limits                                          |
| `monthly_credits`                           | integer              | Denormalized friendly cap (= budget × 1000)               |
| `used_usd`                                  | numeric              | Source of truth                                           |
| `used_credits`                              | integer              | Generated or maintained for UI (`ceil(used_usd / 0.001)`) |
| `reset_date`                                | timestamptz          | Stripe period end                                         |
| `window_5h_start`, `window_5h_used_usd`     | timestamptz, numeric | Triple window                                             |
| `window_week_start`, `window_week_used_usd` | timestamptz, numeric | Triple window                                             |
| `created_at`, `updated_at`                  | timestamptz          |                                                           |


RLS: **select own row only**; no client writes.

### 8.3 `ai_credit_events` (audit — replaces / extends `message_events`)


| Column                               | Type          | Notes                                        |
| ------------------------------------ | ------------- | -------------------------------------------- |
| `id`                                 | uuid PK       |                                              |
| `user_id`                            | uuid FK       |                                              |
| `provider`                           | text          | e.g. `anthropic`                             |
| `model`                              | text          | e.g. `claude-3-5-sonnet-latest`              |
| `surface`                            | text          | `chat` | `agent` | `council` | `tool`        |
| `chat_id`                            | text nullable | Forensics                                    |
| `agent_id`                           | text nullable |                                              |
| `reserved_usd`, `actual_usd`         | numeric       |                                              |
| `reserved_credits`, `actual_credits` | integer       |                                              |
| `prompt_tokens`, `completion_tokens` | integer       |                                              |
| `status`                             | text          | `pending` | `settled` | `blocked` | `failed` |
| `error_code`                         | text nullable |                                              |
| `created_at`                         | timestamptz   |                                              |


### 8.4 `hosted_model_catalog`


| Column                     | Type              | Notes                                 |
| -------------------------- | ----------------- | ------------------------------------- |
| `provider`                 | text              |                                       |
| `model_id`                 | text              | API id                                |
| `input_usd_per_token`      | numeric           |                                       |
| `output_usd_per_token`     | numeric           |                                       |
| `cache_read_usd_per_token` | numeric default 0 |                                       |
| `enabled`                  | boolean           | Kill switch per model                 |
| `display_name`             | text              | Settings UI                           |
| `reference_multiplier`     | numeric           | vs DeepSeek V4 Flash (1.0 = baseline) |
| `updated_at`               | timestamptz       |                                       |


### 8.5 `ai_credit_reservations` (optional but recommended)

Short-lived holds for in-flight requests (prevents parallel over-commit):


| Column         | Type        | Notes                           |
| -------------- | ----------- | ------------------------------- |
| `id`           | uuid PK     | Returned to edge fn             |
| `user_id`      | uuid        |                                 |
| `reserved_usd` | numeric     |                                 |
| `expires_at`   | timestamptz | Auto-release cron               |
| `status`       | text        | `held` | `settled` | `released` |


### 8.6 Existing tables — updates


| Table                        | Change                                                    |
| ---------------------------- | --------------------------------------------------------- |
| `subscription_plan_limits`   | Add `apex` row; consider column renames                   |
| `deepgram_promo_plan_limits` | Add `apex` launch seconds (2× ultra)                      |
| `profiles.tier`              | Allow value `apex`                                        |
| `call_usage`, `sms_usage`    | Seed apex budgets via existing sync trigger               |
| `message_usage`              | Migrate data → `ai_credit_usage`; deprecate after cutover |


### 8.7 RPC functions (sketch)


| RPC                                                    | Purpose                                |
| ------------------------------------------------------ | -------------------------------------- |
| `reserve_ai_credits(user_id, estimate_usd)`            | Lock row, enforce windows, deduct hold |
| `settle_ai_credits(user_id, reserved_usd, actual_usd)` | Refund delta; clamp refunds ≤ reserved |
| `release_ai_credits(user_id, reserved_usd)`            | Failed provider call — full refund     |
| `sync_ai_credit_usage_for_user(user_id, plan)`         | On tier change / webhook               |
| `reset_monthly_usage_if_needed(user_id)`               | Extend to reset `ai_credit_usage`      |


All RPCs: `**service_role` only** (same security model as `0021`).

---

## 9. Edge functions (design only)

### 9.1 `hosted-inference-complete` (new — supersedes `message-complete` for multi-model)

**Flow:**

```text
POST /hosted-inference-complete
  1. JWT auth
  2. Validate provider + model against hosted_model_catalog
  3. Rate limit (per-minute request cap — fail closed)
  4. Admin? skip budget
  5. estimateModelCostUsd → reserve_ai_credits
  6. Call upstream provider with company key
  7. actualModelCostUsd → settle_ai_credits
  8. Insert ai_credit_events row
  9. Return streamed or JSON body + usage metadata
```

**Error codes (client must handle):**


| Code                      | HTTP | Client action              |
| ------------------------- | ---- | -------------------------- |
| `budget_exceeded`         | 402  | Offer BYOK / upgrade       |
| `rate_window_exceeded`    | 429  | Show retry_after           |
| `model_not_allowed`       | 400  | Pick another model or BYOK |
| `provider_not_configured` | 503  | BYOK fallback              |
| `usage_unavailable`       | 503  | Fail closed (no bypass)    |


Keep `**message-complete`** as a thin wrapper delegating to the new function during migration, then remove.

### 9.2 `get-ai-credit-usage` (new — or extend `get-message-usage`)

Returns:

```json
{
  "plan": "apex",
  "credits": { "included": 62000, "used": 12400, "remaining": 49600 },
  "windows": {
    "5h": { "cap": 4960, "used": 120, "resets_at": "..." },
    "week": { "cap": 15500, "used": 8000, "resets_at": "..." }
  },
  "reset_date": "2026-07-15T00:00:00Z",
  "billing_source": "hosted"
}
```

### 9.3 Stripe functions (notes only)


| Function                         | Change                                       |
| -------------------------------- | -------------------------------------------- |
| `create-checkout-session`        | Map `apex` → `STRIPE_APEX_PRICE_ID`          |
| `stripe-webhook`                 | `planForPriceId` recognizes apex price       |
| `_shared/voice.ts` / `budget.ts` | Add `apex` to `PlanId` union + `PLAN_LIMITS` |


### 9.4 Reserve / settle / refund sequence

```mermaid
sequenceDiagram
  participant Client
  participant Edge as hosted-inference-complete
  participant RPC as reserve_ai_credits
  participant LLM as Provider API
  participant DB as ai_credit_usage

  Client->>Edge: POST messages + model
  Edge->>RPC: reserve(estimate_usd)
  RPC->>DB: FOR UPDATE; check windows
  RPC-->>Edge: ok + remaining
  Edge->>LLM: completion request
  alt success
    LLM-->>Edge: usage block
    Edge->>RPC: settle(reserved, actual)
    RPC->>DB: used_usd += actual; refund delta
  else failure before tokens
    Edge->>RPC: release(reserved)
    RPC->>DB: refund full hold
  end
  Edge-->>Client: response + credits_used
```



---

## 10. Out of scope (this release)


| Item                           | Notes                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------- |
| **Vibe Hive**                  | Multi-step stack pipelines, `stack-complete`, Stack Timeline UI — defer entirely |
| **Terminal billing**           | No credit draw for terminal-attached inference; terminals remain BYOK            |
| **Credit packs / top-ups**     | No à la carte purchases                                                          |
| **Rollover / banked credits**  | Policy locked: no                                                                |
| **Overage invoices**           | Policy locked: no                                                                |
| **Supernova-exclusive models** | Same catalog as Singularity; 2× budget only                                      |
| **Spark hosted credits**       | Spark stays BYOK + free Gemini path                                              |


---

## 11. UI / UX touchpoints

### 11.1 Settings → Plans


| Element          | Change                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Plan cards       | Add **Supernova $200** card; show **62,000 AI credits**, **~434 phone min**, **~1,860 SMS** |
| Singularity card | Copy change: “**AI credits** (any hosted model)” instead of “DeepSeek message credits”      |
| Comparison table | 5-tier ladder or highlight Singularity vs Supernova “2×” row                                |
| Upgrade CTA      | Stripe Checkout for `STRIPE_APEX_PRICE_ID`                                                  |


Files likely touched: `app/src/features/settings/sections/Plans.tsx`, `app/src/lib/entitlements.ts`, `app/src/features/billing/planLimits.ts`, `app/src/lib/callVoiceMarketing.ts`.

### 11.2 Usage meter


| Location                       | Behavior                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Settings → Usage (or Billing)  | Single **AI credits** progress bar: `remaining / included`                                |
| Composer footer / model picker | Subtle “Hosted · 48,200 credits left”                                                     |
| Low credit (< 10%)             | Amber banner: “Running low on AI credits — add a provider key or upgrade”                 |
| Exhausted                      | Red inline state; auto-route attempts to BYOK if keys exist, else block with upgrade link |


### 11.3 Low-credit warnings


| Threshold | UX                                          |
| --------- | ------------------------------------------- |
| **≤ 20%** | Toast once per session                      |
| **≤ 10%** | Persistent banner in chat                   |
| **≤ 5%**  | Modal on next hosted send (dismissible)     |
| **0%**    | Hosted path disabled; BYOK/local still work |


### 11.4 Council-specific

Show aggregate burn hint when starting council: “3 agents ≈ 3× credit usage per round.”

---

## 12. Stripe product / price mapping (notes only — do not create in this doc pass)


| Stripe object      | Suggested mapping                                                    |
| ------------------ | -------------------------------------------------------------------- |
| Product            | `VibeSpace Supernova` (or extend existing product with second price) |
| Price              | **$200/month** recurring → env `STRIPE_APEX_PRICE_ID`                |
| `planForPriceId()` | `'price_…' → 'apex'`                                                 |
| `profiles.tier`    | `'apex'`                                                             |
| Customer portal    | Allow upgrade/downgrade Singularity ↔ Supernova                      |


Existing env vars (unchanged):

- `STRIPE_STARTER_PRICE_ID` → `starter`
- `STRIPE_PRO_PRICE_ID` → `pro`
- `STRIPE_ULTRA_PRICE_ID` → `ultra`

Webhook idempotency via `subscription_events` (unchanged).

---

## 13. Implementation phases (for build agent)

### Phase 0 — Prep

- Read this doc + `SUBSCRIPTION_PLANS_REFERENCE.md`
- Confirm product sign-off on **Supernova** naming and **no terminal credits**
- Create Stripe price in **test mode**; record price id in secrets (not repo)

### Phase 1 — Schema & plan limits

- Migration: `apex` row in `subscription_plan_limits`, `deepgram_promo_plan_limits`
- Create `ai_credit_usage`, `ai_credit_events`, `hosted_model_catalog`
- RPCs: `reserve_ai_credits`, `settle_ai_credits`, `release_ai_credits`
- Extend `sync_message_call_usage_for_user` → sync ai bucket
- Backfill: copy `message_usage` → `ai_credit_usage` for existing paid users

### Phase 2 — Edge hosted proxy

- Implement `hosted-inference-complete` with catalog-driven costing
- Seed catalog with DeepSeek V4 Flash + initial multi-provider SKUs
- Wire `message-complete` → delegate (compat shim)
- Implement `get-ai-credit-usage`

### Phase 3 — Client routing

- Extend provider adapters to call hosted edge when no BYOK + paid plan
- Remove per-tier `hostedModels` gate for subscription path (budget-only gating)
- Ensure council multi-agent loops use same hosted path
- **Verify terminals never call hosted edge** (grep guard / explicit exclusion)

### Phase 4 — Stripe & entitlements

- `PlanId` union + `PLAN_LIMITS` + `entitlements.ts` + `callVoiceMarketing.ts`
- Checkout + webhook + portal for `apex`
- `profiles.tier` validation accepts `apex`

### Phase 5 — UI

- Supernova plan card + 2× comparison copy
- AI credits usage meter + low-credit warnings
- Update `SUBSCRIPTION_PLANS_REFERENCE.md` (full tier table)

### Phase 6 — QA & rollout

- SQL behavior tests (mirror `subscription_v2_behavior.sql`)
- Integration: reserve/settle race, window caps, tier upgrade mid-cycle
- Load test council 5-agent session credit burn
- Deprecate `message_usage` reads after stable cutover

---

## 14. Migration & compatibility


| Concern                               | Approach                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| Existing Singularity subscribers      | Same **31,000** credit cap; only **labeling** changes (message → AI credits) |
| In-flight `message-complete` requests | Shim delegates to new function                                               |
| `entitlements.hostedModels` arrays    | Deprecate for enforcement; keep temporarily for UI badges if needed          |
| Docs drift                            | Update `SUBSCRIPTION_PLANS_REFERENCE.md` when implementation lands           |


---

## 15. Testing checklist

- Singularity user sends DeepSeek hosted chat → credits decrement correctly
- Same user sends Claude hosted → **more** credits per turn
- BYOK key present → **zero** credit decrement
- Council 3 agents → ~3× single-agent decrement
- Terminal agent context attached → still BYOK only; **no** credit RPC calls
- Supernova user has **exactly 2×** Singularity caps on AI / call / SMS
- Window caps at 8% / 25% enforced on AI bucket
- Stripe upgrade ultra → apex mid-cycle updates `monthly_budget_usd` without resetting `used_usd`
- Admin bypass works; anon/authenticated cannot call reserve RPCs directly

---

## 16. Open questions (resolve before Phase 1)

1. **Display rename:** “AI credits” vs keeping “message credits” in customer copy?
2. **Mid-tier ladder:** Should Nova ($50) also get model-agnostic credits, or only Singularity+? *(This doc assumes **all Orbit+** get the unified bucket — matches current Orbit+ hosted chat.)*
3. **Supernova positioning:** Same feature bullets as Singularity + “2× everything” — any exclusive perk beyond quota?
4. `**profiles.tier` enum:** Check constraints in DB may need altering for `apex`.

---

*Document path: `docs/plans/AI_CREDIT_BUCKET_AND_ULTRA_TIER.md`*