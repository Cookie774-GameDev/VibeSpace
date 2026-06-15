# Subscription Quota Sliders + Pay-As-You-Go Add-Ons — Planning Spec

**Status:** Planning only (no code, migrations, or Stripe changes in this doc)  
**Last updated:** June 2026  
**Audience:** Product, implementation agent  
**Related:** [`docs/SUBSCRIPTION_PLANS_REFERENCE.md`](../SUBSCRIPTION_PLANS_REFERENCE.md), [`docs/plans/AI_CREDIT_BUCKET_AND_ULTRA_TIER.md`](AI_CREDIT_BUCKET_AND_ULTRA_TIER.md), [`docs/HIVE.md`](../HIVE.md)

---

## 1. Executive summary

Paid subscribers receive a **fixed monthly value pool** per tier. In **Settings → Plans**, three **quota sliders** let users **reallocate** that pool across:

| Bucket | Pays for |
|--------|----------|
| **Messages** | SMS / text segments (monthly SMS bucket) |
| **Call time** | Voice module cloud TTS, Jarvis Call (PSTN), speech-to-text (shared call/voice bucket) |
| **AI credits** | Hosted chat models + **Hive** stack steps (unified AI credit bucket) |

**Rules (locked for v1 planning):**

- Total monthly value is **fixed per tier** — sliders cannot exceed the plan cap.
- Users slide freely between buckets (e.g. more AI → slide AI up, messages/calls down).
- **Defaults** per tier match today's **50% AI / 35% call / 15% SMS** COGS split (see §3).
- **Supernova ($200)** = **2× Singularity ($100)** total pool to split (same default ratios).
- Sliders **reset each billing cycle** to tier defaults (or last-saved preset — product choice in §5).
- **No rollover** between buckets unless explicitly enabled later.
- **No silent overage** — when a bucket is empty, hosted usage stops (BYOK/local fallback).
- **Explicit opt-in PAYG add-ons** are allowed when the user enables them (§6).

---

## 2. Fixed pool model

Each paid tier has one **monthly COGS envelope** (62% of sticker price at 38% gross margin). Sliders only **redistribute** that envelope — they do not create new money.

```text
monthly_pool_usd(plan) = ai_budget_usd + call_budget_usd + sms_budget_usd
                       = constant for plan (until product re-prices tier)
```

**Invariant (server-enforced):**

```text
slider_ai_usd + slider_call_usd + slider_sms_usd === monthly_pool_usd(plan)
```

Slider movements are **zero-sum**: increasing AI by $1 decreases the sum of call + SMS by $1 (user chooses which bucket(s) to shrink).

### 2.1 What sliders do *not* affect

| Item | Why excluded |
|------|--------------|
| Launch Deepgram promo (founder $5, phase-2 $2, paid launch bonus) | Separate one-time wallets — not part of monthly pool |
| BYOK inference | User-paid; never drawn from subscription pool |
| Local Kokoro | Free, unmetered |
| Triple rate windows on AI bucket | Still apply to the **AI slice** after slider allocation |
| Tier feature flags (Jarvis Call, cloud sync, etc.) | Boolean entitlements — not slider-governed |

---

## 3. Default allocations per tier

Defaults preserve migration `0021` **50 / 35 / 15** split across AI / call / SMS. These are the **starting slider positions** at each billing-cycle reset (unless user saves a custom preset — see §5).

| Tier | Price/mo | Pool (COGS) | AI credits (default) | Call/voice (default) | SMS (default) |
|------|----------|-------------|----------------------|----------------------|---------------|
| **Orbit** (`starter`) | $10 | $6.20 | **3,100** (~$3.10) | **~22 min** (~$2.17) | **~93** (~$0.93) |
| **Nova** (`pro`) | $50 | $31.00 | **15,500** (~$15.50) | **~109 min** (~$10.85) | **~465** (~$4.65) |
| **Singularity** (`ultra`) | $100 | $62.00 | **31,000** (~$31.00) | **~217 min** (~$21.70) | **~930** (~$9.30) |
| **Supernova** (`apex`) | $200 | **$124.00** | **62,000** (~$62.00) | **~434 min** (~$43.40) | **~1,860** (~$18.60) |

**Supernova rule:** Every default bucket is **exactly 2× Singularity** — same ratios, double the absolute caps.

**Marketing headline minutes** for call/voice use worst-case PSTN burn (~$0.10/min). Cloud voice module TTS burns slower (~$0.015/min), so the same call slice lasts longer when users stay on Kokoro or TTS-only.

**AI credits:** 1 credit = $0.001 company inference spend (model-agnostic). DeepSeek V4 Flash is the reference SKU for copy only.

---

## 4. Slider UX — Settings → Plans

**Location:** `Settings → Plans` (same surface as plan cards and upgrade CTAs).

### 4.1 Controls

Three linked sliders (or equivalent stepped controls):

1. **AI credits** — hosted chat + Hive steps  
2. **Call time** — PSTN + cloud voice module + STT (shared Deepgram-backed bucket)  
3. **Messages** — SMS segments  

**Live preview** while dragging:

- Remaining pool USD (must stay at $0 unallocated)
- Friendly units: credits, headline phone minutes, SMS count
- Warning if any bucket would drop below a minimum usable floor (e.g. &lt; 100 AI credits) — soft UX only; server enforces sum invariant

### 4.2 Example reallocations (Singularity)

| User goal | Typical move |
|-----------|--------------|
| Heavy Hive / frontier models | Slide **AI up** → reduce call + SMS |
| Lots of Jarvis Call PSTN | Slide **Call time up** → reduce AI + SMS |
| SMS automation / alerts | Slide **Messages up** → reduce AI + call |

Starting defaults (31k / 217 min / 930 SMS) are balanced; power users tune once per cycle or save a preset.

### 4.3 When changes take effect

| Event | Behavior (recommended) |
|-------|--------------------------|
| User moves sliders mid-cycle | New caps apply **immediately**; `used_*` counters unchanged — user cannot allocate already-spent value |
| Billing cycle rolls | Reset `used_*` to zero; restore sliders to **tier defaults** (or saved preset — §5) |
| Upgrade/downgrade tier | New `monthly_pool_usd`; rescale or reset sliders to new tier defaults; preserve `used_*` pro-rata or reset — resolve in implementation |
| Spark / free | No sliders — no monthly pool |

---

## 5. Reset, rollover, and saved presets

| Policy | Decision |
|--------|----------|
| **Billing-cycle reset** | `used_*` counters zeroed at Stripe `current_period_end` |
| **Slider positions on reset** | **Default:** revert to tier defaults (§3). **Optional v1.1:** "Remember my split" toggle stores `quota_slider_preset` per user |
| **Rollover between buckets** | **No** — unused AI credits do not become call minutes (or vice versa) |
| **Rollover of unused pool** | **No** — same as today; forfeited at cycle boundary |
| **Cross-cycle PAYG balance** | Add-on credits (§6) may persist until consumed — separate ledger from monthly pool |

---

## 6. Pay-as-you-go (PAYG) add-ons

### 6.1 Policy — no silent overage, explicit opt-in

| Rule | Detail |
|------|--------|
| **No automatic overage** | System never bills beyond the monthly pool without user action |
| **Exhaustion default** | Bucket empty → throttle hosted path; BYOK / local fallback |
| **PAYG allowed** | User **explicitly enables** PAYG per bucket (or global toggle) in Settings |
| **User picks bucket** | Top-up targets **AI credits**, **call minutes**, or **SMS** independently |

v1 previously locked "no overage billing." This spec **clarifies**: **no surprise invoices** — only **opt-in PAYG** after monthly allocation is exhausted.

### 6.2 Pricing formula

Add-on usage is priced at **provider base cost + 5% VibeSpace platform fee**:

```text
addon_charge_usd = base_inference_cost_usd × 1.05
```

| Variable | Meaning |
|----------|---------|
| `base_inference_cost_usd` | Actual provider COGS for the unit (AI token settlement, Deepgram second, Twilio SMS segment, etc.) |
| `1.05` | 5% VibeSpace fee on top of base |

**Examples:**

| Add-on type | Base (illustrative) | User pays |
|-------------|---------------------|-----------|
| AI — 1,000 credits ($1.00 COGS) | $1.00 | **$1.05** |
| Call — 10 headline PSTN min ($1.00 COGS) | $1.00 | **$1.05** |
| SMS — 100 segments ($1.00 COGS) | $1.00 | **$1.05** |

Settlement always uses **actual** provider cost after the event (same as monthly pool metering), then applies the 1.05 multiplier for PAYG ledger entries.

### 6.3 Distinction from monthly pool

| Aspect | Monthly pool (sliders) | PAYG add-ons |
|--------|------------------------|--------------|
| Funding | Included in subscription price | Charged separately |
| Allocation | User-controlled sliders | User buys top-up for chosen bucket |
| Stripe | Recurring subscription line item | **Separate** line item or metered billing (design below) |
| Opt-in | Automatic with plan | **Must enable** PAYG + confirm purchase / auto-reload rules |

### 6.4 Stripe billing design (notes only)

**Option A — Prepaid credit packs (recommended for v1 clarity):**

- Products: `VibeSpace PAYG — AI`, `PAYG — Call`, `PAYG — SMS`
- One-time Checkout or saved payment method; credit `payg_ai_balance_usd`, etc.
- Draw down pack balance before blocking hosted usage

**Option B — Metered subscription add-on:**

- Stripe Billing meter per bucket; report usage events with `quantity × 1.05` markup
- Requires spend cap + email alerts — still **opt-in**

**Option C — Customer balance / invoice threshold:**

- Accumulate PAYG rows; invoice when threshold hit — higher surprise risk; not recommended for v1

**Webhook / ledger tables (sketch):**

- `payg_addon_settings` — per-user enable flags, auto-reload rules, spend caps
- `payg_addon_ledger` — `user_id`, `bucket`, `base_usd`, `fee_usd`, `charged_usd`, `stripe_payment_intent_id`, `created_at`

### 6.5 PAYG draw order (when enabled)

For a hosted AI request after monthly AI credits exhausted:

1. Monthly **AI slider allocation** (if remaining)
2. **PAYG AI balance** (if enabled and funded)
3. **BYOK** → **local** → block with upgrade / top-up CTA

Same pattern for call/voice and SMS buckets. Launch promos still draw **before** monthly pool (unchanged — see `SUBSCRIPTION_PLANS_REFERENCE.md`).

---

## 7. Hive + AI slider allocation

**Hive hosted steps draw only from the user's AI credit slice** — the portion of the monthly pool allocated to **AI credits** via sliders.

- Each Hive step = separate reserve/settle on the AI bucket (see [`docs/HIVE.md`](../HIVE.md) §11.3).
- If user slides AI to zero, hosted Hive stops unless **PAYG AI** is enabled and funded.
- Council × Hive multiplies burns; slider planning should warn heavy users.

---

## 8. Schema sketch (planning only)

| Table / column | Purpose |
|----------------|---------|
| `profiles.quota_ai_pct`, `quota_call_pct`, `quota_sms_pct` | Normalized slider positions (sum = 100) |
| `ai_credit_usage.monthly_budget_usd` | Derived from `plan_pool × quota_ai_pct` |
| `call_usage.monthly_budget_usd` | Derived from `plan_pool × quota_call_pct` |
| `sms_usage.monthly_budget_usd` | Derived from `plan_pool × quota_sms_pct` |
| `payg_addon_settings` | Opt-in flags, caps |
| `payg_addon_ledger` | PAYG charges at `base × 1.05` |

RPC `sync_quota_sliders_for_user(user_id, ai_pct, call_pct, sms_pct)` — validate sum, recompute the three `monthly_budget_usd` fields atomically.

---

## 9. UI copy (customer-facing)

**Sliders hero (Settings → Plans):**

> **Your monthly pool** — slide to prioritize AI models, phone time, or texts. Total stays the same; reset each billing cycle.

**PAYG toggle:**

> **Add-on credits (optional)** — when a bucket runs out, top up at provider cost + 5%. No automatic charges unless you turn this on.

**What NOT to say:**

- ❌ "Unlimited if you enable overage" — always capped or PAYG-funded
- ❌ "Leftover AI rolls into next month" — no rollover between buckets
- ❌ Silent continuation past monthly pool without PAYG enabled

---

## 10. Implementation phases (outline)

1. **Schema** — slider columns, PAYG settings + ledger  
2. **RPC** — `sync_quota_sliders_for_user`, PAYG reserve/settle with 1.05 markup  
3. **Settings UI** — three linked sliders + PAYG toggles per bucket  
4. **Stripe** — PAYG products / Checkout (test mode first)  
5. **Edge functions** — check monthly bucket then PAYG balance  
6. **Docs** — keep `SUBSCRIPTION_PLANS_REFERENCE.md` in sync  

Couples with [`AI_CREDIT_BUCKET_AND_ULTRA_TIER.md`](AI_CREDIT_BUCKET_AND_ULTRA_TIER.md) Phase 5 (UI) and credit-bucket RPCs.

---

## 11. Open questions

1. **Mid-cycle slider change:** Immediate cap change vs. effective next cycle only?  
2. **Saved preset:** Ship "remember my split" in v1 or billing-cycle default only?  
3. **PAYG auto-reload:** Fixed pack ($5 / $20) vs. custom amount?  
4. **Minimum bucket floor:** Enforce server-side minimum 5% per bucket or allow 0% AI?  
5. **Supernova marketing:** Show "2× pool to customize" on plan card?

---

*Document path: `docs/plans/SUBSCRIPTION_QUOTA_SLIDERS_AND_PAYG.md`*
