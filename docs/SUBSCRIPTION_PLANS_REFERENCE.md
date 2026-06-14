# VibeSpace Subscription Plans — Complete Reference

**Last updated:** June 2026  
**Document path:** `docs/SUBSCRIPTION_PLANS_REFERENCE.md`  
**Code sources:** `callVoiceMarketing.ts`, `budget.ts`, `entitlements.ts`, `message-complete`, migrations `0019` + `0021` + `0022`

---

## Table of contents

1. [Plan ladder at a glance](#plan-ladder-at-a-glance)
2. [Three surfaces — don’t mix these up](#three-surfaces--dont-mix-these-up)
3. [Two separate money systems](#two-separate-money-systems)
4. [Hosted AI chat — DeepSeek V4 Flash](#hosted-ai-chat--deepseek-v4-flash)
5. [What Deepgram credits pay for](#what-deepgram-credits-pay-for)
6. [What does NOT use Deepgram promo](#what-does-not-use-deepgram-promo)
7. [Launch promotion — Phase 1 (now)](#launch-promotion--phase-1-now)
8. [Launch promotion — Phase 2 (at $5k pool)](#launch-promotion--phase-2-at-5k-pool)
9. [Promo eligibility — no card](#promo-eligibility--no-card)
10. [Spend-by deadline (Spark promos)](#spend-by-deadline-locked)
11. [Monthly subscription buckets](#monthly-subscription-buckets)
12. [Burn rates & headline minutes](#burn-rates--headline-minutes)
13. [Billing draw order](#billing-draw-order)
14. [When the pool runs out](#when-the-pool-runs-out)
15. [Plan economics — internal](#plan-economics--internal-maintainers-only)
16. [Customer-facing copy](#customer-facing-copy)
17. [What NOT to say](#what-not-to-say)
18. [Implementation & ops](#implementation--ops)

---

## Plan ladder at a glance

| Internal ID | Display name | Price/mo | Spark = free forever |
|-------------|--------------|----------|----------------------|
| `free` | **Spark** | $0 | ✓ |
| `starter` | **Orbit** | $10 | |
| `pro` | **Nova** | $50 | |
| `ultra` | **Singularity** | $100 | |

**Monthly sticker prices never change** during launch promos. Only the **one-time Deepgram launch bonus** increases when the company pool scales to $5k.

---

## Three surfaces — don’t mix these up

VibeSpace has **three different voice/chat surfaces**. Marketing and support must use the right name for each.

| Surface | What it is | Phone network? | How users access it |
|---------|------------|:--------------:|---------------------|
| **Voice module** | Talk to Jarvis **inside the app** — wake word, push-to-talk, Voice modal, spoken replies in chat | **No** | Settings → Voice · orb / mic in UI · `streamingVoice` in chat runtime |
| **Jarvis Call (PSTN)** | Real **phone call** on the cellular network — you dial Jarvis or Jarvis dials you | **Yes** | Twilio + phone-jarvis cloud (Pipecat). Requires Orbit+ or active promo |
| **Hosted AI chat** | Typed chat with **company-paid** inference (no user API key) | **No** | Chat composer on paid plans → `message-complete` Edge Function |

**There is no “Path C in-app phone call” for talking to Jarvis.** The green phone / LiveKit scaffold in `phone-jarvis` is **not** the product voice experience. Users talk to Jarvis through the **voice module** (local Kokoro by default, optional cloud Deepgram TTS). **Jarvis Call** is PSTN only.

```
┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
│  VOICE MODULE      │   │  JARVIS CALL       │   │  HOSTED AI CHAT    │
│  (in-app talk)     │   │  (real phone)      │   │  (typed messages)  │
│                    │   │                    │   │                    │
│  Kokoro = free     │   │  Twilio PSTN       │   │  DeepSeek V4 Flash │
│  Cloud TTS = meter │   │  Pipecat AI loop   │   │  message credits   │
│  NOT a phone call  │   │  IS a phone call   │   │  NOT voice         │
└────────────────────┘   └────────────────────┘   └────────────────────┘
```

---

## Two separate money systems

Users interact with two independent wallets. Do not conflate them in marketing or support.

| System | Funded by | When it applies | Resets? |
|--------|-----------|-----------------|---------|
| **Launch Deepgram promo** | Company Deepgram pool ($1k → $5k) | One-time welcome / launch bonus per user | No — use it or lose it |
| **Monthly subscription buckets** | Paid plan COGS allocation | Every billing cycle on Orbit+ | Yes — monthly |

```
┌─────────────────────────────────────────────────────────────┐
│  LAUNCH PROMO (one-time)          MONTHLY (paid tiers)      │
│  ───────────────────────          ─────────────────────     │
│  • Founder $5 (200 slots)         • AI message credits      │
│  • Spark $2 at $5k (1k slots)     • Call/voice bucket       │
│  • Paid launch Deepgram bonus     • SMS bucket              │
│  • Shared company Deepgram pool   • DeepSeek V4 Flash chat │
└─────────────────────────────────────────────────────────────┘
```

---

## Hosted AI chat — DeepSeek V4 Flash

Paid subscribers (Orbit / Nova / Singularity) get **hosted AI message credits** — company-paid chat **without** bringing your own API key.

| Item | Detail |
|------|--------|
| **Model** | **DeepSeek V4 Flash** (API id: `deepseek-chat`) |
| **Endpoint** | Supabase Edge Function `message-complete` |
| **Who gets it** | Orbit+ only — Spark uses BYOK or free Gemini Flash Lite via Google AI Studio |
| **Metering** | Monthly **message credits** bucket (1 credit ≈ $0.001 company spend) |
| **Rate limits** | Triple windows on every bucket: **5-hour** (8%), **weekly** (25%), **monthly** (100%) — no rollover |
| **Fallback** | If budget exhausted or provider down → client falls back to BYOK / local models |

### Message credits by tier

| Tier | Credits/mo |
|------|------------|
| Spark | 0 |
| Orbit | **3,100** |
| Nova | **15,500** |
| Singularity | **31,000** |

**BYOK always works on every tier** for any provider the user configures. Hosted DeepSeek is an **optional convenience** on paid plans, not a replacement for BYOK.

**Server allowlist:** clients cannot pick a more expensive model on the hosted path — only `deepseek-chat` is permitted (`message-complete/index.ts`).

### Hosted chat limits

Hosted chat is **not unlimited**. Each paid tier has a fixed monthly **message credit** bucket (see table above). When credits hit zero → throttle; client falls back to BYOK/local. **No overage billing.**

---

## What Deepgram credits pay for

**One shared Deepgram wallet** per user. Launch promo credits and the monthly call/voice bucket cover **Deepgram-backed** surfaces only:

| Use | Surface | Description |
|-----|---------|-------------|
| **You calling Jarvis** | Jarvis Call (PSTN) | Outbound AI phone call via Twilio |
| **Jarvis calling you** | Jarvis Call (PSTN) | Inbound / callback AI phone sessions |
| **Cloud voice in the voice module** | Voice module | Deepgram TTS when user selects cloud engine (not local Kokoro) |
| **Speech-to-text** | Voice module + global | Global dictation (`Ctrl+CapsLock`) |

**Talking to Jarvis in the app through the voice module is NOT a phone call** and does not use Twilio. Default in-app talk uses **unlimited local Kokoro** (free, no Deepgram). Cloud Deepgram TTS in the voice module draws from the same wallet when selected.

All four Deepgram uses above share the **same** `deepgram_promo_usage` / call-voice balance. Users can mix until the balance is gone.

### Example: $5 founder credit (~26,667 seconds)

Approximate **if you spent the whole wallet on one thing**:

| If you only use… | Rough capacity |
|------------------|----------------|
| AI phone calls (PSTN) | ~50 min |
| Cloud voice module (Deepgram TTS) | ~110+ min |
| Speech-to-text | ~5+ hr |

Real usage blends all three — the wallet depletes by actual Deepgram seconds consumed.

---

## What does NOT use Deepgram promo

| Feature | How it's paid |
|---------|---------------|
| **Unlimited local Kokoro** | Free on every plan — voice module default; **never** touches Deepgram promo or monthly buckets |
| **Hosted AI chat (DeepSeek V4 Flash)** | Monthly **message credits** bucket (Orbit+ only) — separate from Deepgram |
| **BYOK inference** | User's own API keys — always allowed on every tier |
| **SMS texts** | Monthly **SMS** bucket (paid tiers only) |
| **Twilio telephony leg** | Rolled into call-minute burn from monthly call/voice bucket on paid plans |

---

## Launch promotion — Phase 1 (now)

**Pool:** $1,000 company Deepgram (`promo_phase = launch_1k`)  
**Pause threshold:** ~$900 used (90% kill switch)  
**Status:** Active now

### Spark (free) — founders only

> **First 200 users: $5 FREE Deepgram credit** — Jarvis Call (phone), cloud voice in the voice module, speech-to-text. **No card.**

| Item | Value |
|------|-------|
| **Who qualifies** | First **200 signups** only |
| **Credit** | **$5** Deepgram (~26,667 seconds) |
| **Max company cost** | 200 × $5 = **$1,000** (entire phase-1 pool) |
| **Everyone else on Spark** | **$0** company credit |

**We do NOT give $2 to everyone.** The $1k pool exists solely to fund 200 founders at $5 each.

### Paid tiers — phase 1 launch bonus (unchanged until $5k)

| Tier | One-time Deepgram launch bonus |
|------|-------------------------------|
| **Orbit** | 30 min |
| **Nova** | 90 min |
| **Singularity** | 3 hr |

These are **on top of** monthly subscription buckets and do **not** change monthly prices.

---

## Launch promotion — Phase 2 (at $5k pool)

**Trigger:** Manually flip `promo_phase` to `scale_5k` and increase pool to $5,000.  
**Pause threshold:** ~$4,500 used.

When the pool hits $5k, **two things** change:

### A) New Spark promo (limited — separate from founders)

> **First 1,000 Spark users: $2 FREE Deepgram credit** — Jarvis Call · cloud voice module · STT

| Item | Value |
|------|-------|
| **Who qualifies** | First **1,000** Spark signups **after** phase 2 is activated |
| **Credit** | **$2** Deepgram (~10,667 seconds) |
| **Max company cost** | 1,000 × $2 = **$2,000** |
| **Founders** | Keep their original **$5** — they do **not** claim this promo |
| **Before $5k** | This promo is **inactive** (`spark_promo_not_active`) |

### B) Main boost — paid subscription launch credits (priority)

| Tier | Phase 1 bonus | Phase 2 bonus |
|------|---------------|---------------|
| **Orbit** | 30 min | **3 hr** |
| **Nova** | 90 min | **9 hr** |
| **Singularity** | 3 hr | **15 hr** |

**Monthly subscription prices stay the same** ($10 / $50 / $100). Only the one-time Deepgram launch bonus increases.

### Phase summary

| Phase | Pool | Spark free credit | Paid launch bonus |
|-------|------|-------------------|-------------------|
| **1 — now** | $1,000 | **200 × $5** only | 30m / 90m / 3h |
| **2 — $5k** | $5,000 | **1,000 × $2** (new promo) | **3h / 9h / 15h** |

Promos run **until the pool money runs out** — no new claims after `pause_at_usd` is hit. Users who already claimed keep spending their personal balance until exhausted.

---

## Promo eligibility — no card

**Policy (locked):** Spark launch credits require **no credit card**. Not for the $5 founder promo. Not for the $2 phase-2 promo. Card is only collected when someone **chooses a paid plan** (Orbit / Nova / Singularity).

| Promo | Card? | To unlock |
|-------|:-----:|-----------|
| **$5 founder (first 200)** | **No** | Sign up + verified email + slot available |
| **$2 Spark (first 1,000 at $5k)** | **No** | Same — no Stripe, no $0 auth hold |

**Why no card:** The promos are capped (200 / 1,000 slots) and pool-funded ($1k / $5k). Requiring a card would crush conversion on the exact hook you're using to get early users. Abuse is handled by **slot limits + verified email**, not payment friction.

**Anti-abuse (instead of card):**

- Verified email before credit activates
- Hard slot caps (200 founders, 1,000 Spark promo)
- Pool pause at 90% spend — promos stop when money runs out
- One claim per user (RPC rejects `already_claimed`)
- *(Future)* phone verify or soft device limits if farming becomes a problem

**Do not add card gates later** without updating all marketing copy — “No card” is part of the promise.

### Spend-by deadline (locked)

**Spark promos ($5 founder + $2 phase-2): 7 days to spend.** Unused credit is **forfeited** after the window. Paid cloud tools **lock back** to subscription-only.

| Promo | Spend window | Clock starts |
|-------|--------------|--------------|
| **$5 founder** | **7 days** | When credit is claimed (verified email + slot granted) |
| **$2 Spark (phase 2)** | **7 days** | Same |

**Why 7 days (not 2 weeks / 1 month / 4 months):**

- $5 / $2 is a **taste**, not a bank account — urgency drives real trials
- Stops 200 founders from sitting on credit for months while you carry pool liability
- 4 months would be stupid for a $5 hook; you’d fund idle balances forever
- 2 weeks is fine if you want softer onboarding, but **1 week is the right default** for launch scarcity

**What unlocks during the 7 days (Spark + active promo balance):**

| Feature | With promo credit | After 7 days or balance = 0 |
|---------|-------------------|-------------------------------|
| **Jarvis Call** (PSTN phone) | ✓ unlocked | ✗ locked — Orbit+ only |
| **Cloud voice module** (Deepgram TTS) | ✓ unlocked | ✗ locked — use local Kokoro or subscribe |
| **Speech-to-text** (`Ctrl+CapsLock`) | ✓ unlocked | ✗ locked — BYOK Deepgram key or subscribe |
| **Voice module (local Kokoro)** | ✓ always | ✓ always free |
| **Hosted DeepSeek V4 Flash chat** | ✗ (Spark) | ✗ — subscribe for message credits |
| **BYOK chat / terminals** | ✓ always | ✓ always free |

**Paid tier launch Deepgram bonus** (30m → 15h on subscribe): recommend **30 days** to spend — they’re paying customers, not free-tier tasters. *(Implement separately if desired.)*

**Marketing line:**

> *$5 free Deepgram credit — use it within **7 days**. AI calls, Jarvis voice & speech-to-text. No card.*

---

## Monthly subscription buckets

Paid tiers get **three separate monthly buckets**. Spark gets none (BYOK + local Kokoro).

### Full plan comparison

| | **Spark** | **Orbit** | **Nova** | **Singularity** |
|---|:---:|:---:|:---:|:---:|
| **Price** | $0 | $10/mo | $50/mo | $100/mo |
| **Hosted AI (DeepSeek V4 Flash)** | — | 3,100 credits/mo | 15,500 credits/mo | 31,000 credits/mo |
| **AI phone min headline/mo** | — | 22 | 109 | 217 |
| **Cloud voice module max/mo** | Kokoro only | up to ~140+ min Deepgram TTS | up to ~720+ min | up to ~1,400+ min |
| **SMS texts/mo** | — | ~100 | ~500 | ~1,000 |
| **Jarvis Call (PSTN)** | ✗ | ✓ | ✓ | ✓ |
| **Voice module (local Kokoro)** | ✓ unlimited | ✓ unlimited | ✓ unlimited | ✓ unlimited |
| **Cloud sync** | ✗ | ✓ | ✓ | ✓ |
| **Tool publishing** | ✗ | ✗ | ✓ | ✓ |
| **Priority routing** | ✗ | ✗ | ✓ | ✓ |

### Internal USD budgets (maintainers only)

Dollar caps, COGS splits, and margin targets are defined in `budget.ts` and migrations — see the **private maintainer runbook**, not this public doc. Customer-facing quotas are the credit/minute columns in the table above.

### Hosted AI by tier

| Tier | Company-hosted chat |
|------|---------------------|
| **Spark** | None — BYOK any provider, or free Gemini 2.5 Flash Lite via Google AI Studio (no card) |
| **Orbit / Nova / Singularity** | **DeepSeek V4 Flash** via `message-complete` — credits scale with tier (3.1k → 31k/mo) |

BYOK for Anthropic, OpenAI, Groq, etc. remains available on **all** tiers regardless of hosted DeepSeek.

### Shared call/voice bucket (paid monthly)

The monthly **call/voice** bucket pays for Deepgram-backed surfaces on a **recurring** basis:

- **Jarvis Call** (PSTN via Twilio)
- **Cloud Deepgram TTS** in the voice module (when cloud engine is selected)
- **Speech-to-text** (when wired to bucket)

**Phone minutes** use worst-case burn (~$0.10/min headline). **Cloud voice module** burns slower (~$0.015/min), so the same bucket lasts longer when users stay on Kokoro or use TTS only.

**Local Kokoro in the voice module never draws from this bucket.**

---

## Burn rates & headline minutes

Display rates used in marketing copy (`callVoiceMarketing.ts`):

| Surface | Estimated company cost |
|---------|------------------------|
| AI phone minute (PSTN) | ~$0.10/min |
| Cloud voice module minute (Deepgram TTS) | ~$0.015/min |
| Speech-to-text minute | ~$0.008/min |

Launch promo seconds are tracked in `deepgram_promo_usage` and settled via `reserve_deepgram_promo` / `settle_deepgram_promo`.

---

## Billing draw order

When a user consumes cloud voice / calls / STT, the server tries sources in this order:

1. **Founder $5** or phase-2 Spark **$2** (if eligible and balance remains)
2. **Paid tier one-time launch Deepgram promo** (30m → 15h depending on phase)
3. **Monthly call/voice bucket** (paid tiers only)
4. **BYOK Deepgram key** (user-supplied)
5. **Throttle** — no surprise overage bills

Admins bypass billing (`billingSource = admin`).

---

## When the pool runs out

| Event | What happens |
|-------|--------------|
| Pool hits `pause_at_usd` | `active = false` — **no new promo claims** |
| Founder slots full (200) | `founder_slots_exhausted` — signup #201+ gets $0 Spark credit |
| Spark promo slots full (1,000) | `spark_promo_slots_exhausted` at phase 2 |
| User exhausts personal balance | Falls through to monthly bucket → BYOK → throttle |
| Phase 2 not yet active | `claim_launch_spark_promo` returns `spark_promo_not_active` |

Existing users **keep** whatever they already claimed until they use it up **or the 7-day Spark deadline passes** (whichever comes first).

---

## Plan economics — internal (maintainers only)

> **This section is not published on the public GitHub repo.** Margin targets, COGS splits, pool pause thresholds, and unit-cost tables live in the private maintainer runbook. Public marketing uses **customer-facing copy** below only.

For local reference, see your private ops wiki or the maintainer-only copy of this document.

---

## Customer-facing copy

### Hero — Phase 1 (now)

> **First 200 users: $5 FREE** — Deepgram for Jarvis Call (phone), cloud voice module & speech-to-text. **Use within 7 days.** No card. Unlimited local Kokoro in the voice module for everyone.

### Hero — Phase 2 (after $5k)

> **Subscriptions unlocked:** up to **15 hours** launch Deepgram credit. **First 1,000** Spark users get **$2** to try calls, Jarvis voice & STT. **No card.**

### Spark card bullets

- Every BYOK provider works
- Unlimited local Kokoro (voice module)
- **First 200:** $5 Deepgram — Jarvis Call, cloud voice module & STT
- At $5k pool: first 1,000 Spark users get $2

### Paid tier lines

> **Hosted chat:** DeepSeek V4 Flash — 3,100 / 15,500 / 31,000 credits per month  
> **Jarvis Call + cloud voice:** 30 min → 90 min → 3 hr launch Deepgram (phase 1)

### Paid tier promo line (phase 2)

> Orbit **3 hr** · Nova **9 hr** · Singularity **15 hr** launch Deepgram credit

---

## What NOT to say

- ❌ “Everyone gets $2 free”
- ❌ “Free tier always has company voice credit”
- ❌ “Launch credit is added to your monthly subscription dollars”
- ❌ “Unlimited Kokoro uses your Deepgram balance”
- ❌ Implying phase-2 Spark $2 promo is active before the $5k pool flip
- ❌ “Add a card to unlock your free credit” (Spark promos never ask for a card)
- ❌ “Path C” or “in-app phone call” for the voice module — **there is no in-app phone call**
- ❌ “Paid tiers get Gemini/Claude hosted” — hosted chat is **DeepSeek V4 Flash** only
- ❌ Calling local Kokoro voice module usage a “phone call” or Deepgram spend
- ❌ “Unlimited hosted DeepSeek” — every tier has a **fixed monthly credit cap** on paid plans

---

## Implementation & ops

### Database tables

| Table | Purpose |
|-------|---------|
| `deepgram_promo_pool` | Singleton company pool ($, phase, pause threshold) |
| `deepgram_promo_usage` | Per-user seconds_limit / used_seconds |
| `deepgram_promo_plan_limits` | Paid-tier launch seconds (phase 1 + phase 2 columns) |
| `launch_founder_rewards` | First 200 × $5 claims (+ `expires_at` TODO) |
| `launch_spark_promo_rewards` | Phase 2 first 1,000 × $2 claims (+ `expires_at` TODO) |

### RPC functions

| Function | Purpose |
|----------|---------|
| `claim_launch_founder_reward(uuid)` | First **200** signups → **$5** Deepgram |
| `claim_launch_spark_promo(uuid)` | Phase 2 only, first **1,000** Spark → **$2** |
| `reserve_deepgram_promo` / `settle_deepgram_promo` | Meter usage against promo wallet |
| `sync_deepgram_promo_for_user` | Reconcile user balance on tier change |
| `deepgram_promo_seconds_for_plan` | Returns phase-appropriate paid launch seconds |

### Activate Phase 2 (admin SQL)

```sql
update public.deepgram_promo_pool
   set budget_usd = 5000,
       pause_at_usd = 4500,
       promo_phase = 'scale_5k',
       active = true,
       updated_at = now()
 where id = 1;
```

### Signup hooks (TODO)

Wire auth signup webhook to call:

1. `claim_launch_founder_reward` — always attempt on new user
2. `claim_launch_spark_promo` — only succeeds when phase 2 is active and user is not a founder

### Code files

| File | Role |
|------|------|
| `supabase/migrations/0019_deepgram_launch_promo.sql` | Base pool + reserve/settle |
| `supabase/migrations/0022_launch_rewards_program.sql` | Founders, Spark phase 2, paid boost |
| `supabase/migrations/0021_subscription_plan_v2.sql` | **38% margin** plan limits + triple windows |
| `supabase/functions/message-complete/index.ts` | Hosted **DeepSeek V4 Flash** chat + message budget |
| `supabase/functions/tts-speak/index.ts` | Cloud Deepgram TTS for voice module (promo → bucket) |
| `supabase/functions/call-start/index.ts` | Jarvis Call PSTN billing (monthly bucket today) |
| `app/src/features/voice/` | **Voice module** — Kokoro, streaming voice, Voice modal (not PSTN) |
| `supabase/functions/_shared/budget.ts` | Monthly bucket USD limits + DeepSeek pricing |
| `app/src/lib/callVoiceMarketing.ts` | Marketing constants + phase logic |
| `app/src/lib/entitlements.ts` | Plans UI feature lines |
| `app/src/features/billing/planLimits.ts` | Usage display helpers |

### Wiring status (honest)

| Surface | Promo wallet | Monthly bucket | Status |
|---------|:---:|:---:|--------|
| **Voice module — cloud Deepgram TTS** | ✓ first | ✓ fallback | **Live** (`tts-speak`) |
| **Voice module — local Kokoro** | — | — | **Always free** |
| **Jarvis Call (PSTN)** | designed | ✓ today | **TODO** — route promo before bucket |
| **Global STT (`Ctrl+CapsLock`)** | designed | ✓ fallback | **TODO** — currently BYOK-only in app |
| **Hosted DeepSeek V4 Flash chat** | — | ✓ message credits | **Live** (`message-complete`) |
| **7-day Spark expiry + lock-back** | — | — | **TODO** — `expires_at` on claim |

---

*Document path: `docs/SUBSCRIPTION_PLANS_REFERENCE.md`*
