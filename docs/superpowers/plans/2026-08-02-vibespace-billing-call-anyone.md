# VibeSPACE Billing and Call Anyone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the owner-approved Stripe subscription catalog, shared-credit backend, and secure Telnyx-based third-party Call Anyone workflow without weakening existing owner calls.

**Architecture:** Stripe Checkout creates one subscription containing Access and, when selected, exactly one add-on. Signed Stripe webhooks remain the entitlement authority; Supabase owns atomic shared credits, contacts, approval snapshots, call jobs, rate limits, opt-outs, and audit state. Authenticated Edge Functions orchestrate prepare/approve/start/cancel/read operations, while a signature-verified webhook and long-running Telnyx media gateway handle provider events and streaming.

**Tech Stack:** PostgreSQL/RLS, Supabase Edge Functions (Deno TypeScript), Stripe Checkout/Billing, Telnyx Call Control and media streaming, Deepgram Flux/Aura, DeepSeek, Python/FastAPI, React/TypeScript.

## Global Constraints

- Test mode only until the controlled launch gate is explicitly enabled.
- Never mutate a cloud target until its exact VibeSPACE identity is proven.
- One shared credit equals `$0.001` of actual company-paid provider usage.
- Spark is Access-only; paid tiers contain Access plus exactly one add-on.
- No client-supplied amount, price, entitlement, destination, provider option, or credit calculation is authoritative.
- Existing owner calls, in-app calls, phone settings, SMS, subscriptions, and shared credits must remain compatible.
- No live purchases, payments, contracts, emergency calls, account recovery, authentication-code exchange, or financial transfers.
- Provider secrets remain server-side and never enter the desktop bundle or manual-actions file.

---

### Task 1: Canonical billing and call contracts

**Files:**

- Create: `supabase/functions/_shared/billingCatalog.ts`
- Create: `supabase/functions/_shared/billingCatalog.test.ts`
- Create: `supabase/functions/_shared/callAnyone.ts`
- Create: `supabase/functions/_shared/callAnyone.test.ts`

**Interfaces:**

- Produces `resolveCheckoutLineItems`, `resolveStripeEntitlement`, `normalizeE164`, `validateThirdPartyCallDraft`, `approvalFingerprint`, and `verifyTelnyxSignature`.

- [x] Write pure failing tests for exact plan catalog, Access-plus-add-on line items, ambiguous/unknown Stripe prices, E.164 normalization, protected destinations/objectives, approval invalidation, and Telnyx signature/replay handling.
- [x] Run the focused tests and confirm the expected missing-module failures.
- [x] Implement immutable catalogs and bounded pure validation with no secret access.
- [x] Run the focused tests to green and format the files.

### Task 2: Transactional shared credits, contacts, jobs, and safety state

**Files:**

- Create: `supabase/migrations/0036_owner_approved_billing_call_anyone.sql`
- Create: `supabase/tests/owner_approved_billing_call_anyone_behavior.sql`

**Interfaces:**

- Produces owner-scoped contacts and call-history tables plus service-only atomic prepare/reserve/settle/release/callback RPCs.

- [x] Write SQL behavior assertions for canonical budgets, nonnegative atomic shared balance, cross-user denial, immutable approvals, duplicate idempotency, insufficient credits, cancellation, opt-outs, rate limits, and callback idempotency.
- [x] Create migration 0036 with RLS enabled on every exposed table, explicit grants, ownership predicates, immutable approval snapshots, provider-event dedupe, and service-only privileged RPCs.
- [x] Ensure customer roles cannot edit entitlement, credit, reservation, provider, approval, or settlement fields.
- [x] Perform parser/static security checks and record runtime SQL execution as externally blocked because the connected Supabase project is AccessRevamp and no isolated local Supabase runtime is installed.

### Task 3: Stripe Checkout and webhook reconciliation

**Files:**

- Modify: `supabase/functions/create-checkout-session/index.ts`
- Modify: `supabase/functions/create-checkout-session/index.test.ts`
- Modify: `supabase/functions/stripe-webhook/index.ts`
- Modify: `supabase/functions/stripe-webhook/index.test.ts`

**Interfaces:**

- Consumes the shared billing catalog.
- Produces one Access-plus-optional-add-on Checkout session and rejects malformed subscription line-item states.

- [x] Add failing tests for Spark, every paid tier, missing configuration, client price injection, duplicate access/add-ons, unknown prices, replay, and out-of-order lifecycle events.
- [x] Resolve all prices from server secrets and include bounded metadata/idempotency keys only.
- [x] Reconcile signed webhooks into separate Access status and hosted tier, with the Stripe billing period driving credit-cycle reset.
- [x] Run focused tests to green.

### Task 4: Third-party call orchestration and Telnyx webhook

**Files:**

- Create: `supabase/functions/third-party-call/index.ts`
- Create: `supabase/functions/third-party-call/index.test.ts`
- Create: `supabase/functions/telnyx-call-webhook/index.ts`
- Create: `supabase/functions/telnyx-call-webhook/index.test.ts`
- Modify: `supabase/config.toml`

**Interfaces:**

- Produces authenticated prepare/approve/start/cancel/get/contact routes and an unauthenticated but Ed25519-verified provider callback.

- [x] Write failing route tests for auth, explicit approval, server-calculated reservation, provider idempotency/failure release, cancellation, live approval, and sanitized responses.
- [x] Implement authenticated orchestration with service-side destination/script lookup and maximum duration/reservation bounds.
- [x] Place Telnyx calls using only approved job IDs; release reservations on provider failure.
- [x] Verify callback signature, timestamp freshness, dedupe, out-of-order tolerance, terminal settlement, opt-out, and result updates.
- [x] Run focused tests to green and confirm webhook JWT configuration is disabled only for the signature-verifying endpoint.

### Task 5: Long-running Telnyx media gateway

**Files:**

- Modify: `phone-jarvis/cloud/config.py`
- Create: `phone-jarvis/cloud/telnyx_gateway.py`
- Create: `phone-jarvis/cloud/test_telnyx_gateway.py`
- Modify: `phone-jarvis/cloud/main.py`
- Modify: `phone-jarvis/cloud/.env.example`
- Modify: `phone-jarvis/cloud/README.md`

**Interfaces:**

- Produces a bounded authenticated WebSocket media route and Call Control client using the approved Telnyx/Deepgram/DeepSeek pipeline.

- [ ] Write failing Python tests for configuration, disclosure, maximum duration, barge-in state, protected-action pause, hangup, and sanitization.
- [x] Implement the long-running gateway without placing the audio loop in an Edge Function.
- [x] Preserve existing owner/in-app routes and isolate legacy Twilio paths as non-production compatibility.
- [x] Run focused Python tests to green and compile the bounded Python package.

### Task 6: Calls settings and confirmation UI

**Files:**

- Create: `app/src/features/call/thirdParty/types.ts`
- Create: `app/src/features/call/thirdParty/client.ts`
- Create: `app/src/features/call/thirdParty/CallAnyonePanel.tsx`
- Create: `app/src/features/call/thirdParty/CallAnyonePanel.test.tsx`
- Modify: `app/src/features/settings/sections/PhoneVoice.tsx`
- Modify: `app/src/features/settings/sections/PhoneVoice.test.tsx`

**Interfaces:**

- Produces contact/business/one-time-number preparation, masked confirmation, explicit approval, cancellation, status, live-approval, take-over availability, and result presentation.

- [ ] Write failing component/client tests for no immediate call, masked destination, disclosure, exact approval payload, changed-draft invalidation, insufficient-credit copy, cancellation, and preserved owner-call settings.
- [x] Implement a lazy Calls section using server-returned canonical job data only.
- [x] Keep provider keys, full numbers outside edit/confirm, and client-calculated credits out of the UI.
- [x] Run focused tests and TypeScript to green.

### Task 7: Documentation, external test deployment, and closure

**Files:**

- Create: `docs/OWNER_APPROVED_CALL_ANYONE_ADDENDUM_2026-08-01.md`
- Create: `C:\Users\viper\VibeSpaceOs\Manual Stuff\VIBESPACE_BILLING_CALL_ANYONE_MANUAL_ACTIONS.txt`

- [x] Record architecture, safety, privacy, exact external gates, and verified evidence without weakening the source handoff.
- [ ] Verify the connected project identities. Apply migrations, functions, and Stripe test objects only if the targets are independently proven as VibeSPACE test environments.
- [x] Run focused Node-compatible Edge tests, SQL static checks, Python, frontend, TypeScript, production build, formatting, diff, secret, and bundle scans; runtime SQL remains externally blocked as recorded above.
- [x] Write a no-secret manual file containing required variable names, secure PowerShell prompts, `supabase secrets set` workflow, Stripe/Telnyx webhook steps, and truthful unresolved external actions.
- [x] Record exact changed paths, evidence, blocks, and safe resume action in coordination state.
