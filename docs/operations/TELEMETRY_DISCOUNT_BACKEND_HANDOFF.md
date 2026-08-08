# Telemetry reward backend handoff

Status: locally implemented for PR31; no Supabase project or Stripe account was
mutated.

## Contract

- Optional telemetry remains off by default and is selected by data class.
- Reward enrollment is a separate, explicit account action. It requires all
  three disclosed classes: product usage, diagnostics, and tool outcomes.
- Enrollment and withdrawal are written through the authenticated
  `telemetry-consent` Edge Function and a service-role-only database RPC.
- Feature-plan checkout derives eligibility from the authenticated profile. It
  ignores coupon, discount, customer, price, and user values supplied by the
  client.
- The reward is exactly 10%, implemented by one Stripe Coupon with
  `percent_off=10` and `duration=forever`.
- Promotion-code entry stays disabled. A family benefit can coexist only when
  the service-owned entitlement names a single pre-created combined coupon.
  Its effective percentage must be:
  `100 - (100 - familyPercent) * 0.90` (for example, 20% family + 10% telemetry
  is one verified 28% coupon). No two Stripe discounts are stacked.
- Changing local switches alone cannot award a discount. Checkout validates
  the coupon against Stripe before creating a Session and fails closed if its
  amount, duration, validity, or identifier is wrong.

VibeSpace Access remains its separately governed product and checkout. This
change applies to the feature-plan subscriptions shown in Settings → Plans; do
not silently reuse its coupon for Access without an owner-approved Access
pricing amendment and corresponding Access checkout tests.

## Required isolated test-mode setup

1. Obtain privacy/legal approval for the exact financial-incentive notice,
   disclosed data classes, retention, withdrawal behavior, and documented
   good-faith value calculation. Publish it at an HTTPS URL.
2. Apply `supabase/migrations/0040_telemetry_reward_discount.sql` to an isolated
   VibeSpace test project.
3. Deploy `telemetry-consent` and the updated
   `create-checkout-session` to that same test project.
4. In Stripe test mode, create a dedicated Coupon:
   - percentage discount: `10`
   - duration: `Forever`
   - no client-entered promotion code is required
5. Configure the Edge Function secrets:

```powershell
$ProjectRef = '<ISOLATED_VIBESPACE_TEST_PROJECT_REF>'
$TelemetryCouponId = '<coupon_...>'
$PolicyVersion = '<approved-policy-version>'
$NoticeUrl = 'https://vibespaceos.com/<approved-notice-path>'

npx supabase secrets set --project-ref $ProjectRef `
  "STRIPE_TELEMETRY_REWARD_COUPON_ID=$TelemetryCouponId" `
  "TELEMETRY_REWARD_POLICY_VERSION=$PolicyVersion" `
  "TELEMETRY_FINANCIAL_INCENTIVE_NOTICE_URL=$NoticeUrl"

npx supabase functions deploy telemetry-consent --project-ref $ProjectRef
npx supabase functions deploy create-checkout-session --project-ref $ProjectRef
```

Never paste the Stripe secret key or Supabase service-role key into a renderer
environment variable, screenshot, issue, or this document.

## Family benefit setup

The `family_discount_entitlements` table is service-role-only. For each active
family benefit, provision:

- the authoritative family percentage;
- a verified family-only Stripe Coupon;
- a verified combined family-plus-telemetry Stripe Coupon.

Do not grant the client table write access. If the combined coupon is missing
or has the wrong percentage, checkout intentionally returns
`subscription_discount_unavailable` before creating a Stripe Checkout Session.

## Test-mode verification

1. A signed-out request to `telemetry-consent` returns 401.
2. Enrollment with fewer than all three classes or an old policy version
   returns 400 and writes nothing.
3. Enrollment creates account consent and an immutable audit row; withdrawal
   clears eligibility immediately and creates another audit row.
4. Checkout without consent has no `discounts`.
5. Checkout with current consent has exactly one 10% forever coupon.
6. A client-supplied coupon or amount is ignored.
7. A 9%, one-time, deleted, invalid, or unreachable coupon fails closed before
   customer/session creation.
8. Family-only uses the family coupon; family plus telemetry uses exactly the
   validated combined coupon.
9. Confirm webhook reconciliation and the customer portal preserve normal plan
   lifecycle behavior.

## Rollback

Disable new enrollment by unsetting
`TELEMETRY_REWARD_POLICY_VERSION` or changing it to a new unpublished version,
then deploy the prior Edge Function builds if necessary. Do not drop the audit
table during an incident. Existing Stripe subscriptions are not mutated by
this PR31 local implementation.

## Local evidence

- Edge Function unit tests cover auth, exact consent, withdrawal, hostile
  client discount input, exact coupon validation, and the combined family
  rule.
- Renderer tests cover fail-closed account parsing, enrollment/withdrawal
  payloads, granular default-off consent, and installed-model availability.
- The migration behavior test verifies required schema, RLS, and denial of
  authenticated family-discount writes.
