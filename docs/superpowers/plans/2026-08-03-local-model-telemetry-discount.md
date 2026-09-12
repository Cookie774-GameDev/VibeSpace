# Local Models and Telemetry Discount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every installed Ollama model immediately selectable in Chat and enforce an
account-bound, exactly 10% optional-telemetry subscription reward.

**Architecture:** Preserve the existing app-wide Ollama discovery registry and separate model
availability from the Fully Local Chat fallback. Add an authenticated consent Edge Function backed
by an additive service-role-only SQL boundary, then make Checkout resolve and verify the reward
entirely on the server.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Supabase Edge Functions, PostgreSQL/RLS, Stripe
Checkout.

## Global Constraints

- Optional telemetry is off by default, granular, revocable, and never inferred.
- The telemetry reward is exactly 10%; client price, coupon, consent, and eligibility claims are
  ignored.
- Arbitrary discounts never stack. Only a separately authorized family combined coupon is allowed.
- No live Supabase/Stripe mutation, deployment, dependencies, Git publication, or unrelated edits.

---

### Task 1: Installed local models are Chat-ready

**Files:**

- Modify: `app/src/lib/ai/models.ts`
- Modify: `app/src/lib/ai/models.test.ts`
- Modify: `app/src/lib/ai/ollamaBootstrap.ts`
- Modify: `app/src/lib/ai/ollamaBootstrap.test.ts`
- Modify: `app/src/features/settings/sections/LocalModels.tsx`
- Modify: `app/src/features/settings/sections/LocalModels.runtime.test.tsx`

**Interfaces:**

- Consumes: `syncDiscoveredOllamaModels(models)`, `bootstrapOllamaConnection()`.
- Produces: installed model options independent of `defaultLocalModel`; fallback selection remains
  available for Fully Local Chat.

- [ ] Add failing tests proving two discovered installed tags both appear when no fallback is set,
      and a stale fallback is not fabricated as installed.
- [ ] Run the focused model/bootstrap tests and confirm the expected failures.
- [ ] Separate discovered availability from fallback resolution and preserve exact deduplication.
- [ ] Replace required-selection/radio copy with “Available in Chat” plus an optional Fully Local
      fallback action.
- [ ] Run the focused model/bootstrap/Local Models tests and confirm GREEN.

### Task 2: Account telemetry consent boundary

**Files:**

- Create: `supabase/migrations/0040_telemetry_reward_discount.sql`
- Create: `supabase/tests/telemetry_reward_discount_behavior.sql`
- Create: `supabase/functions/telemetry-consent/index.ts`
- Create: `supabase/functions/telemetry-consent/index.test.ts`
- Create: `app/src/features/telemetry/accountTelemetryConsent.ts`
- Create: `app/src/features/telemetry/accountTelemetryConsent.test.ts`
- Modify: `app/src/features/telemetry/telemetryConsent.ts`
- Modify: `app/src/features/telemetry/telemetryConsent.test.ts`
- Modify: `app/src/features/settings/sections/Telemetry.tsx`
- Modify: `app/src/features/settings/sections/Telemetry.test.tsx`

**Interfaces:**

- Produces: authenticated `GET`/`PUT` consent snapshot with policy version, enabled classes, reward
  eligibility, and notice URL.
- Database RPC: `set_telemetry_reward_consent(uuid, boolean, text, text[])`.

- [ ] Add failing Edge and client tests for unauthenticated access, default-off state, exact policy
      version, enabled-class validation, opt-in, withdrawal, and unavailable-backend recovery.
- [ ] Run the focused tests and confirm RED.
- [ ] Add the additive columns, immutable audit table, family-discount entitlement table, RLS,
      grants, and atomic service-role-only consent RPC.
- [ ] Implement the Edge handler and client adapter without exposing service-role credentials.
- [ ] Bind the existing granular switches to explicit account enrollment/withdrawal and display the
      authoritative 10% terms and notice link.
- [ ] Run the focused consent/UI/SQL contract tests and confirm GREEN.

### Task 3: Server-authoritative Stripe reward

**Files:**

- Modify: `supabase/functions/create-checkout-session/index.ts`
- Modify: `supabase/functions/create-checkout-session/index.test.ts`

**Interfaces:**

- Consumes: current profile consent, optional family entitlement, configured coupon IDs, Stripe
  coupon retrieval.
- Produces: a Checkout Session containing zero or one verified coupon.

- [ ] Add failing tests proving eligible consent applies exactly one verified 10% forever coupon;
      ineligible accounts receive none; invalid coupons block before Session creation; client coupon
      claims are ignored; arbitrary promotion codes are disabled; family uses only its approved
      combined coupon.
- [ ] Run the focused checkout tests and confirm RED.
- [ ] Implement fail-closed eligibility and coupon verification before customer/session side
      effects.
- [ ] Include bounded non-secret metadata and consent in the idempotency key.
- [ ] Run the checkout and shared billing tests and confirm GREEN.

### Task 4: Backend handoff and closure

**Files:**

- Create: `docs/operations/TELEMETRY_DISCOUNT_BACKEND_HANDOFF.md`

- [ ] Document migration/function deployment order, required non-secret environment names, Stripe
      test coupon setup, financial-incentive notice/valuation prerequisites, test-mode verification,
      rollback, and the absence of live mutation.
- [ ] Run focused plugin regression, app TypeScript, scoped Prettier, diff check, and added-line
      secret scan.
- [ ] Review only the owned manifest, record exact evidence, and release coordination ownership.
