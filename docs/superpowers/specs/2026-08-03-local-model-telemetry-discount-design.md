# Local Models and Telemetry Discount Design

## Scope

This PR31 slice has two independent boundaries:

1. Every model verified as installed by Ollama is automatically available in the Chat model
   selector. Settings does not gate availability behind a separate default-model choice.
2. A signed-in account can explicitly opt into optional telemetry and receive an exactly 10%
   subscription discount, enforced by the billing backend.

No live Supabase or Stripe resources are changed by this implementation.

## Local-model behavior

- App startup and model-picker refresh use the existing bounded Ollama bootstrap to discover
  installed tags.
- The Chat selector lists every discovered tag. A normal request still runs one selected model;
  the existing multi-model feature remains the only way to run a coordinated model group.
- `defaultLocalModel` remains only the fallback for Fully Local Chat. It does not control which
  installed models are visible.
- Local Models presents installed models as “Available in Chat.” Choosing a fallback is optional
  until Fully Local Chat is enabled.

## Consent and account authority

- Optional telemetry remains off by default and granular by data class.
- The renderer keeps a local audit for transparency, but reward eligibility comes only from the
  authenticated backend record.
- The consent endpoint authenticates the account, validates the current policy version and exact
  allowed data-class set, and atomically records consent or withdrawal through a service-role-only
  database function.
- Withdrawal immediately stops future optional collection and removes future reward eligibility.
  Existing paid periods are not retroactively repriced.
- The UI links to an authoritative Notice of Financial Incentive before enrollment. Reward
  enrollment fails closed when that notice, policy version, or backend is unavailable.

## Billing authority

- Checkout ignores all client claims about consent, coupons, amounts, and eligibility.
- The server reads current account consent and policy version.
- The configured reward coupon is retrieved from Stripe and must be valid, `forever`, and exactly
  `10` percent off. Invalid or missing reward configuration blocks discounted checkout rather than
  silently charging full price.
- Promotion-code entry stays disabled. A telemetry checkout contains at most one verified coupon.
- A family benefit may combine only through a separately authorized combined coupon stored in a
  service-role-only entitlement. The backend verifies that combined coupon against the approved
  effective percentage. No other discount class can stack.
- Checkout metadata records only non-secret eligibility evidence and policy version.

## Legal and operational boundary

The implementation supplies clear opt-in, withdrawal, audit, and financial-incentive notice
surfaces. Activation still requires owner counsel to provide the jurisdiction-appropriate notice
and a documented good-faith valuation of the data incentive. This is required because California
financial-incentive rules require material terms, opt-in/withdrawal, and a value relationship, while
UK consent guidance requires a freely given choice without improper detriment.

## Verification

- RED/GREEN tests prove automatic installed-model availability and optional fallback semantics.
- RED/GREEN UI/client/Edge tests prove default-off consent, authentication, policy validation,
  revocation, and fail-closed behavior.
- RED/GREEN checkout tests prove exactly 10%, no client control, no arbitrary stacking, family-only
  combination, and invalid-coupon refusal before Session creation.
- Static SQL tests prove service-role-only mutation, RLS, audit immutability, and additive migration
  safety.
