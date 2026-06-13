# VibeSpace Subscription Plans — Complete Reference

**Purpose:** Single oversight document for marketing, sales, support, and product. Covers every tier (including free), what customers get, how enforcement works, and how to position plans for customer growth.

**Last synced with codebase:** v0.1.37 economics (`subscription_plan_limits` migration 0021, `budget.ts`, `entitlements.ts`, `callVoiceMarketing.ts`).

---

## Executive summary (growth lens)

VibeSpace wins customers on a **generous free tier** and upgrades them on **hosted convenience** — not by locking core features behind a paywall.

| Lever | Why it converts |
|-------|-----------------|
| **Free forever (Spark)** | Full workspace, terminals, BYOK, unlimited local Kokoro — zero card required |
| **Unlimited local voice** | Every plan includes on-device neural TTS; cloud voice is a bonus, not the only voice |
| **Honest dual-minute messaging** | Lead with **AI phone minutes** (worst case); upsell **in-app cloud voice** as “same bucket, more time” |
| **Low-friction entry ($10 Orbit)** | Cloud sync + SMS + first hosted models + calling for the price of a streaming sub |
| **No surprise bills** | Hard monthly caps + rolling rate windows; over-burn is throttled, not charged |

**Positioning headline:** *“Free local-first AI workspace. Upgrade when you want hosted models, phone calls, and sync — not before.”*

---

## Plan naming (internal ↔ marketing)

| Internal ID | Marketing name | Price (USD/mo) | Stripe (when live) |
|-------------|----------------|----------------|---------------------|
| `free` | **Spark** | $0 | — |
| `starter` | **Orbit** | $10 | `STRIPE_STARTER_PRICE_ID` |
| `pro` | **Nova** | $50 | `STRIPE_PRO_PRICE_ID` |
| `ultra` | **Singularity** | $100 | `STRIPE_ULTRA_PRICE_ID` |

---

## At-a-glance comparison

| | **Spark** (Free) | **Orbit** (Starter) | **Nova** (Pro) | **Singularity** (Ultra) |
|---|:---:|:---:|:---:|:---:|
| **Price** | $0 | $10/mo | $50/mo | $100/mo |
| **Hosted AI message credits** | 0 | 3,100 | 15,500 | 31,000 |
| **AI phone minutes** (headline) | — | 22 | 109 | 217 |
| **In-app cloud voice** (max, same bucket) | — | up to ~140+ min | up to ~720+ min | up to ~1,400+ min |
| **Unlimited local Kokoro** | ✓ | ✓ | ✓ | ✓ |
| **Jarvis Call** (outbound phone) | — | ✓ | ✓ | ✓ |
| **SMS texts** (monthly) | — | ~93* | ~465* | ~930* |
| **Cloud sync** | — | ✓ | ✓ | ✓ |
| **Custom tool publishing** | — | — | ✓ | ✓ |
| **Priority routing** | — | — | ✓ | ✓ |
| **Deepgram launch promo** (one-time) | 1 min | 30 min | 90 min | 3 hr |

\*Enforced server-side at ~$0.01/segment; marketing often rounds to ~100 / ~500 / ~1,000 texts.

---

## Tier details

### Spark — Free ($0)

**Tagline:** *Your launchpad · bring your own keys*

**Who it’s for:** Developers and power users who already have API keys, want local-first privacy, and don’t need company-hosted inference yet.

**Included:**
- Full desktop workspace (terminals, tile grid, agents, chat, context, history)
- **Bring your own keys** — Groq, Anthropic, OpenAI, OpenRouter, Together, Ollama, local models
- Free **Gemini 2.5 Flash Lite** via Google AI Studio (no card)
- **Unlimited local Kokoro voice** (on-device neural TTS)
- Jarvis & Friday voice presets, personas, hands-free / push-to-talk
- Custom tools (local), terminal swarm, wellness break, Mod+Shift+A palette
- **Local-first** — data stays on the device; no cloud sync

**Not included:**
- Company-hosted AI message credits
- AI phone calls (Jarvis Call)
- In-app cloud TTS from company bucket
- SMS to your phone
- Cloud sync across devices

**Launch promo:** 1 minute one-time Deepgram cloud voice (from shared company pool, separate from monthly bucket).

**Growth role:** Top-of-funnel. No credit card. Let users build habit on terminals + local voice, then convert when they want sync or hosted models without managing keys on every device.

---

### Orbit — Starter ($10/mo)

**Tagline:** *Voice & sync · zero friction*

**Who it’s for:** Users who want hosted AI and phone features without a $50 commitment.

**Everything in Spark, plus:**
- **3,100 hosted AI message credits / month** (~$3.10 company AI budget)
- **Shared call/voice bucket** ($2.17/mo):
  - **22 AI phone minutes** at worst-case burn (~$0.10/min connected call time)
  - **Up to ~140+ min in-app cloud voice** (same bucket, ~$0.015/min burn)
- **Unlimited local Kokoro** (does not touch the bucket)
- **~93 SMS texts / month** to your phone
- **Cloud sync** — chats and memories across devices
- Smart reminders, schedule notifications
- **Hosted models:** Gemini 2.5 Flash Lite, Gemini 2.5 Flash
- **30 min** one-time Deepgram launch promo

**Growth role:** Primary conversion tier. Price anchors against ChatGPT Plus / Copilot; differentiator is terminals + calling + local voice + BYOK still works.

---

### Nova — Pro ($50/mo)

**Tagline:** *Premium firepower · every frontier model*

**Who it’s for:** Daily drivers who want frontier models, more calling/SMS, and priority routing.

**Everything in Orbit, plus:**
- **15,500 hosted AI message credits / month**
- **Shared call/voice bucket** ($10.85/mo):
  - **109 AI phone minutes**
  - **Up to ~720+ min in-app cloud voice**
- **~465 SMS texts / month**
- **Publish custom tools and agents** to your account
- **Priority routing** — no rate-limit pressure on hosted inference
- **Hosted models:** + Gemini 2.5 Pro, Claude 3.5 Sonnet, GPT-4o
- **90 min** one-time Deepgram launch promo

**Growth role:** “Pro” anchor for serious users. Emphasize frontier models + 5× message credits vs Orbit + tool publishing for power users.

---

### Singularity — Ultra ($100/mo)

**Tagline:** *Beyond limits · the entire universe unlocked*

**Who it’s for:** Heavy users, early adopters, and anyone who wants maximum hosted quota and support.

**Everything in Nova, plus:**
- **31,000 hosted AI message credits / month**
- **Shared call/voice bucket** ($21.70/mo):
  - **217 AI phone minutes**
  - **Up to ~1,400+ min in-app cloud voice**
- **~930 SMS texts / month**
- **Early access** to new providers and models
- **Dedicated rate-limit pool** + direct support email
- **Hosted models:** + Claude 3 Opus, o1, o1-mini
- **3 hr** one-time Deepgram launch promo

**Growth role:** Flagship tier. Lead with **217 AI phone minutes**; secondary line is **up to ~1,400+ min in-app cloud voice**. Do **not** market “~1,000 minutes” as the only number — phone-heavy users hit the cap at 217.

---

## How the shared call/voice bucket works

One monthly **dollar budget** funds both:

1. **AI phone calls (Jarvis Call)** — Twilio outbound; full **connected call time** burns at ~**$0.10/min** (Twilio + STT + LLM + TTS stack).
2. **In-app cloud voice** — TTS seconds inside the app burn at ~**$0.015/min** (`COST_PER_SECOND_USD`).

**Unlimited local Kokoro never draws from this bucket.**

| Burn type | Rate (display) | Ultra example ($21.70 bucket) |
|-----------|------------------|-------------------------------|
| Phone call | ~$0.10/min | 217 min if 100% phone |
| In-app cloud TTS | ~$0.015/min | ~1,447 min if 100% cloud voice |
| Local Kokoro | $0 | Unlimited |

The UI shows **“AI phone minutes”** as the headline because that is the **worst-case** burn. In-app users get more real speech time from the same allowance.

**Per-call hard cap:** 30 minutes max per single call (`MAX_CALL_SECONDS = 1800`).

---

## AI message credits

- **1 credit ≈ $0.001** of company-hosted AI spend.
- Credits cover hosted inference when the user is **not** using their own API key.
- **BYOK is always allowed on every tier** — core Jarvis ethos.
- Typical hosted models route through company keys on paid tiers only.

**Hosted model allowlist by tier:**

| Model | Spark | Orbit | Nova | Singularity |
|-------|:-----:|:-----:|:----:|:-----------:|
| Gemini 2.5 Flash Lite | BYOK / free Studio | ✓ | ✓ | ✓ |
| Gemini 2.5 Flash | BYOK | ✓ | ✓ | ✓ |
| Gemini 2.5 Pro | BYOK | — | ✓ | ✓ |
| Claude 3.5 Sonnet | BYOK | — | ✓ | ✓ |
| Claude 3 Opus | BYOK | — | — | ✓ |
| GPT-4o | BYOK | — | ✓ | ✓ |
| o1 / o1-mini | BYOK | — | — | ✓ |

---

## SMS

- Billed in **segments** (~$0.01/segment company cost).
- Monthly budgets: **$0.93** (Orbit) · **$4.65** (Nova) · **$9.30** (Singularity).
- Enforced counts: **93 · 465 · 930** segments; UI/marketing may round to ~100 / ~500 / ~1,000.
- Max **1,000 characters** per outbound request.

---

## Deepgram launch promo (separate from monthly bucket)

One-time per-user allowance from a **$1,000 shared company pool** (`deepgram_promo_pool`).

| Plan | One-time promo |
|------|----------------|
| Spark | 1 min |
| Orbit | 30 min |
| Nova | 90 min |
| Singularity | 3 hr (10,800 seconds) |

Drawn **before** the monthly call/voice bucket at actual Deepgram rates (~$0.01125/min). Pool pauses at 90% spend ($900).

---

## Rate limits & fairness (all paid buckets)

Enforced server-side on **messages**, **calls/voice**, and **SMS**:

| Window | Cap (% of monthly budget) |
|--------|---------------------------|
| Rolling **5 hours** | 8% |
| Rolling **week** | 25% |
| **Month** | 100% |

- **No rollover** — unused budget forfeits at period end.
- Reset: **30 days from Stripe subscription period** when subscribed; calendar month fallback otherwise.
- Over-burn is **rate-limited**, not auto-billed (no surprise charges).

**Example (Singularity call bucket, $21.70):**
- 5h cap ≈ $1.74 → ~17 phone-min equivalent
- Weekly cap ≈ $5.43 → ~54 phone-min equivalent

---

## Plan economics (internal — do not publish verbatim)

Target: **~38% gross margin**; **62% COGS** split **50% AI / 35% calls+voice / 15% SMS**.

| Plan | Price | AI budget | Call/voice budget | SMS budget | Total COGS cap |
|------|-------|-----------|-------------------|------------|----------------|
| Spark | $0 | $0 | $0 | $0 | $0 |
| Orbit | $10 | $3.10 | $2.17 | $0.93 | $6.20 |
| Nova | $50 | $15.50 | $10.85 | $4.65 | $31.00 |
| Singularity | $100 | $31.00 | $21.70 | $9.30 | $62.00 |

Napkin: after Stripe (~3%), tax (~10%), income tax (~25%), kept revenue ≈ **65%** of sticker. Quotas are tuned so a full-burn month stays inside ~**33% COGS** of sticker (≈3× markup on usage).

**Vendor cost vs customer allowance:** A mixed usage example may cost VibeSpace ~$5–7 in vendor fees while the customer still has dollars left in their $21.70 bucket — the headline **217 minutes** is priced for phone worst-case, not average COGS.

---

## Approved customer-facing copy

### Plan card one-liner (paid tiers)

> **{N} AI phone min/mo** · **up to ~{M}+ min in-app cloud voice** · **Unlimited local Kokoro on every plan**

### Pricing footnote

> Phone and in-app cloud voice share one monthly bucket. Phone minutes use worst-case burn (~$0.10/min); in-app cloud voice burns slower (~$0.015/min), so you get more speech time when you stay in the app.

### Spark (free) blurb

> Unlimited local Kokoro voice on every plan. Bring your own keys — no company-paid cloud AI, calling, SMS, or cloud voice.

### What NOT to say

- ❌ “**1,000+ minutes**” as the only headline (misleading for phone users)
- ❌ “Unlimited calling” on paid tiers
- ❌ Dollar budgets or internal COGS in customer copy

---

## Customer acquisition playbook

### 1. Lead with Spark
- No card, full app, unlimited local voice, BYOK
- Message: *“Install free. Add keys you already have. Upgrade only when hosted AI or calling saves you time.”*

### 2. Convert to Orbit ($10)
- Triggers: wants cloud sync, SMS reminders, hosted Gemini without key management, first AI phone calls
- Message: *“$10 — sync across devices, 3,100 AI messages, 22 phone minutes + up to ~140 min in-app voice, unlimited local Kokoro.”*

### 3. Upsell Nova ($50)
- Triggers: hits message limits, wants Claude/GPT-4o hosted, publishes tools, needs priority routing
- Message: *“5× credits, frontier models, 109 phone min, publish agents.”*

### 4. Flagship Singularity ($100)
- Triggers: power users, o1/Opus, max SMS/calling, support SLA
- Message: *“217 phone min · up to ~1,400+ in-app cloud voice · 31k credits · early access.”*

### 5. Objection handling

| Objection | Response |
|-----------|----------|
| “ChatGPT is $20” | VibeSpace is a **workspace** — terminals, agents, memory, local voice, optional phone calls |
| “I only use voice in-app” | Same bucket burns **7× slower** for in-app cloud voice; local Kokoro is **unlimited** |
| “What are call minutes?” | **Connected AI phone time** when Jarvis calls you; in-app speech is separate burn rate |
| “Will I get surprise bills?” | **No** — hard caps + rolling windows; we throttle, not charge overage |

---

## Where this appears in the product

| Surface | Location |
|---------|----------|
| App plan cards | Settings → Plans (`Plans.tsx`, `entitlements.ts`) |
| Usage meters | Settings → Cloud Voice, message/call/SMS usage (`planLimits.ts`) |
| Marketing site | [vibespaceos.com](https://vibespaceos.com) → Pricing (`landing/index.html`) |
| GitHub README | Plans table (`README.md`) |
| Server enforcement | `subscription_plan_limits` + Edge Functions (`budget.ts`, reserve/settle RPCs) |

---

## Source of truth (engineering)

| Concern | File / table |
|---------|----------------|
| Public plan numbers (UI) | `app/src/features/billing/planLimits.ts` |
| Plan features & models | `app/src/lib/entitlements.ts` |
| Marketing copy helpers | `app/src/lib/callVoiceMarketing.ts` |
| Server budgets & rates | `supabase/functions/_shared/budget.ts` |
| DB plan rows | `public.subscription_plan_limits` (migration `0021`) |
| Deepgram promo | `public.deepgram_promo_plan_limits` (migration `0019`) |
| Cloud TTS cost rate | `supabase/functions/_shared/voice.ts` |
| Stripe wiring | `docs/stripe-setup.md` |

When quotas change, update **DB migration**, **`budget.ts`**, **`callVoiceMarketing.ts`**, **`entitlements.ts`**, **`planLimits.ts`**, **landing**, and **README** together.

---

## Billing status

- Plan enforcement is **server-authoritative** (Supabase Edge Functions + RPCs).
- Stripe Checkout + webhooks are documented in `docs/stripe-setup.md`; verify price IDs match current quotas before launch.
- Default install is **Spark (free)** until Stripe subscription is active.

---

*Document path: `docs/SUBSCRIPTION_PLANS_REFERENCE.md`*
