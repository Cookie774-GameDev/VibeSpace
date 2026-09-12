# VibeSpace Access v0.1.51 release checklist

This is the operator record for the remotely controlled VibeSpace Access launch. Keep every box
unchecked until the named evidence exists for the exact release-candidate SHA and selected
environment.

> **Current evidence boundary:** repository static evidence is being verified in this slice.
> Local Supabase SQL, Deno, hosted Stripe/Supabase test mode, Stripe Test Clocks, public route
> checks, and remote activation are **NOT RUN** here. There is no live verification.
> **Live/test-mode: NOT RUN** in this authoring environment.
> A coordinator read-only cloud audit found no deployed `app_access_*` tables or new Access
> functions in the bound Supabase target and found unrelated AccessRevamp `ar_*` objects that must
> remain untouched. Stripe account identity was confirmed read-only; Access product and price state
> is **NOT VERIFIED**.

## Release identity

- [ ] Release-candidate Git SHA: `<record-sha>`
- [ ] Desktop version is exactly `0.1.51`.
- [ ] Supabase project reference: `<record-test-or-production-project-ref>`
- [ ] Stripe account ID and mode: `<record-id-and-test-or-live>`
- [ ] Public origin used by `APP_BASE_URL`: `https://<record-origin>`
- [ ] Operator and independent reviewer: `<record-identities>`
- [ ] Evidence timestamp in UTC: `<record-time>`

Do not reuse test-mode evidence for production. Never paste credentials, Price IDs, customer IDs,
payment details, raw webhook bodies, user identifiers, or workspace data into this checklist.

## Abort criteria

Stop before deployment or activation if any condition below is true:

- The Supabase project or Stripe mode is ambiguous.
- VibeSpace Access is not a separate $20 USD monthly product and price.
- An optional AI/voice/cloud feature plan is merged with Access or given the Access trial.
- Checkout accepts a client price, amount, customer, redirect, user, or idempotency authority.
- The exact-scoped Access application set contains anything other than migrations `0032` through
  `0035`, is out of order, or shows destructive drift.
- Any migration, reset, rollback, or operator command would modify, drop, reset, truncate, rename,
  or replace a pre-existing AccessRevamp `ar_*` object.
- `app_access_launch_config.enabled` is not `false` during prelaunch work.
- Checkout or portal lacks gateway JWT plus server-side user validation.
- `access-lease` lacks gateway JWT plus server-side user validation, signing configuration fails
  open, or its client public key does not match the server signing key and `kid`.
- The webhook requires a Supabase JWT, skips raw-body Stripe signature verification, or lacks a
  durable idempotency claim.
- The Access Price ID is absent from webhook classification, or an Access event can update
  `profiles.tier`.
- Any secret-shaped value, test payment number, live customer data, or raw provider payload is in
  source, logs, screenshots, or release evidence.
- A required scenario is missing, failed, flaky, or recorded against another SHA/environment.
- A backup/export path, locked-mode data preservation, or rollback owner is unverified.
- **`RETURN_ROUTE_PARITY_ABORT`:** the checkout return paths do not match deployed public pages,
  either route is not an expected 200 page, a redirect loops, or either page claims entitlement.

### Known return-route finding

At starting SHA `ef4b38b`, checkout constructed `/billing/access/success` and
`/billing/access/cancel`, while the public site published `/billing/success/` and
`/billing/cancel/`. Commit `f76f927` corrected the source paths to `/billing/success` and
`/billing/cancel`, but no deployed route walk was run during authoring. At the final candidate SHA,
re-read `create-access-checkout/index.ts`, resolve both URLs against `APP_BASE_URL`, and walk them in
a browser. Historical intent is not evidence of parity.

## Phase A — static and local evidence

### Static documentation contract

Static evidence — **PASS criteria:** the checker and formatter exit zero; the base-aware tracked
diff has no whitespace diagnostics; every untracked file has an explicit clean-new-file check; and
all three candidate paths are hashed and content-validated. Current authoring result is limited to
these focused Access artifacts. Re-run after any edit.

```powershell
node scripts/check-access-release-docs.mjs
npx --no-install prettier --check docs/stripe-setup.md docs/access-release-checklist.md scripts/check-access-release-docs.mjs
git diff --check <recorded-base-sha> -- docs/stripe-setup.md docs/access-release-checklist.md scripts/check-access-release-docs.mjs
Get-FileHash -Algorithm SHA256 docs/stripe-setup.md,docs/access-release-checklist.md,scripts/check-access-release-docs.mjs
```

- [ ] Static checker output and exit code attached.
- [ ] Formatting output and exit code attached.
- [ ] Base-aware tracked/staged diff check output and exit code attached.
- [ ] Each untracked candidate has an explicit
      `git diff --no-index --check -- NUL <path>` content/whitespace check. Exit `1` with no
      diagnostic is expected for a clean new file; any diagnostic fails.
- [ ] `Test-Path`, SHA-256 evidence, the static checker, and Prettier explicitly cover all three
      owned candidate paths, including untracked files.
- [ ] Diff reviewed from the recorded starting SHA.
- [ ] Focused Access-pattern scan found no actual credential, payment number, account/project
      identifier, email, or customer data. This is supplemental only.

### Repository-wide secret scan

The static checker does not perform or prove a repository-wide scan. Run the
organization-approved repository-wide secret scanner against the exact release-candidate tree,
including untracked candidate content, the relevant diff from the recorded merge base, and Git
history reachable from the exact candidate commit.

Required detection families include private keys/private JWK material, JWT credentials, Supabase
`sb_secret_` and service-role families, Stripe credentials, GitHub tokens, signing/notarization
material, common cloud credentials, and high-entropy candidates. Record scanner version/config,
scope, RC SHA, exit status, and security-owner disposition in restricted evidence. Never paste a
detected value into this checklist.

- [ ] Organization-approved scanner covered the full exact-RC tree.
- [ ] Relevant diff and reachable history scans completed.
- [ ] Every finding is resolved or explicitly accepted by the security owner.

### Network-free Edge tests

Run only when Deno is installed:

```powershell
deno test supabase/functions/create-access-checkout/index.test.ts
deno test supabase/functions/create-access-portal/index.test.ts
deno test supabase/functions/stripe-webhook/appAccess.test.ts
deno test supabase/functions/stripe-webhook/index.test.ts
deno test supabase/functions/access-lease/index.test.ts
```

- [ ] All focused Deno suites pass at the release SHA.
- [ ] Checkout tests prove no client billing authority and no entitlement grant.
- [ ] Portal tests prove authenticated, account-owned customer lookup and safe Stripe URL output.
- [ ] Webhook tests prove raw-body signature failure, replay, retry, stale/out-of-order, equal-time,
      and separate-ledger behavior.
- [ ] Lease tests prove unauthenticated rejection, fail-closed configuration, authenticated signed
      issuance, unknown-`kid` rejection, client-key parity, revision, expiry, and clock rollback.

### Isolated SQL/RLS tests

Run only against a disposable local Supabase database:

```powershell
supabase db reset
supabase test db
```

- [ ] `app_access_behavior.sql` passes owner-read, no-self-write, prelaunch, trial, grace, locked,
      admin/internal, and feature-tier isolation cases.
- [ ] `app_access_lease_freshness.sql` passes revision snapshot and anti-rollback cases.
- [ ] `app_access_checkout_attempts.sql` passes concurrent reuse, completion, expiry, abandonment,
      and duplicate-subscription cases.
- [ ] Reset/test output contains no production project reference or customer data.

## Phase B — authorized test-project deployment

Follow [the Stripe and Supabase runbook](stripe-setup.md).

- [ ] Test-mode VibeSpace Access product is $20 USD monthly.
- [ ] Optional feature products remain distinct subscriptions with their existing prices.
- [ ] `STRIPE_APP_ACCESS_PRICE_ID` names only the dedicated test-mode Access price.
- [ ] Feature-plan Price IDs map exactly to starter/Orbit, pro/Nova,
      ultra/Singularity, and apex/Supernova.
- [ ] A signed-in user with an existing non-terminal feature subscription receives
      `subscription_exists` from checkout and manages plan changes through the portal;
      no duplicate feature subscription is created.
- [ ] Required platform and operator secrets exist without being copied into evidence.
- [ ] Server `APP_VERSION` is valid SemVer and exactly matches `VITE_APP_VERSION` plus the signed release.
- [ ] Read-only preflight confirms the selected target and records that `app_access_*` objects are
      absent or match the reviewed release SHA; no project reference or object contents enter this
      repository.
- [ ] Existing AccessRevamp `ar_*` objects are treated as protected exclusions, and the reviewed
      application plan contains no operation against them.
- [ ] The two disposable local database proofs pass: the complete current chain and the runbook's
      remote-shaped disposable proof in a temporary, unlinked local project.
- [ ] The remote-shaped proof records the selected migration filenames and SHA-256 evidence, uses
      only owner-approved remote equivalents through `0030`, and proves `0031_wallpapers.sql` is
      absent before local start/reset and before `0032`–`0035`.
- [ ] The database owner approved an exact-scoped executor that receives only one reviewed Access
      migration name/body at a time; generic or full-directory `supabase db push` is prohibited.
- [ ] The authorized test-target application plan contains exactly the four Access migrations,
      sequentially and one at a time: `0032`, `0033`, `0034`, then `0035`.
- [ ] Read-only reconciliation accounts for remote `0001`–`0019` plus later timestamped versions,
      local numeric `0020`–`0035`, and the missing local `0025`; no migration history was blindly
      repaired and no older numeric migration will be replayed.
- [ ] `0031_wallpapers.sql` is confirmed absent/not deployed and remains a separate decision outside
      Access; it is neither applied nor marked applied by this release.
- [ ] After every authorized Access migration application, history and schema state are re-read
      before the next step; exactly four new timestamped rows must appear in order.
- [ ] Config singleton remains `enabled = false`, `trial_days = 30`, `grace_days = 3`,
      `monthly_price_usd = 20.00`, and `require_payment_method_for_trial = false`.
- [ ] RLS behavior proves authenticated self-read, no authenticated writes, and service-role-only
      mutation.
- [ ] `create-access-checkout`, `create-access-portal`, and `access-lease` deploy with
      `verify_jwt = true` behavior.
- [ ] `create-checkout-session` and `create-customer-portal` deploy with
      `verify_jwt = true` behavior and return only validated Stripe-hosted HTTPS URLs.
- [ ] `stripe-webhook` deploys with `verify_jwt = false` and raw-body Stripe signature verification.
- [ ] Boundary probes return webhook health `200`, unsigned webhook `400`, and unauthenticated
      checkout/portal/lease `401`.
- [ ] `ACCESS_LEASE_KEY_ID` and `ACCESS_LEASE_SIGNING_JWK` were injected through the approved
      protected workflow without literal secret command-line, shell-history, log, file-permission,
      or process-capture exposure.
- [ ] Missing/invalid lease signing configuration fails closed as `500 lease_unconfigured` in the
      isolated test.
- [ ] Authenticated lease issuance for an eligible test user returns a signed lease whose bounded
      `kid`, revision, times, and signature verify through the real client verifier.
- [ ] Client trusted public key/private signing key parity is confirmed: same `kid` and P-256 pair,
      no private `d` material in the client.
- [ ] Key rotation lifecycle is rehearsed: new public key ships first, both verification keys
      overlap through the old lease lifetime, old issuance stops, then the old key is retired or
      immediately revoked on compromise.
- [ ] Webhook endpoint subscribes to the seven documented event types.
- [ ] Billing Portal clearly separates Access and optional feature subscriptions.
- [ ] Both checkout return routes satisfy `RETURN_ROUTE_PARITY_ABORT`.

## Phase C — test-mode and clock scenario matrix

Use synthetic accounts and Stripe test mode. Record the event IDs privately in restricted operator
evidence, not in this repository. Never use a real payment method.

Stripe Test Clocks control purchased Stripe subscriptions; they do not control the
Supabase-authoritative first-use Access trial. Exercise trial/grace time transitions with the
isolated SQL fixtures or an approved test-only server clock. Do not edit production timestamps.

| Scenario                                          | Method                                  | Required observation                                                         | Status here |
| ------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| Gate disabled / prelaunch                         | SQL + desktop                           | `enabled=false`; eligible users can use the app; no trial is consumed        | NOT RUN     |
| v0.1.48 development regression                    | Disabled gate + older development build | Prelaunch remains usable and does not consume a trial                        | NOT RUN     |
| Trial start                                       | Isolated SQL/first authenticated use    | One 30-day trial starts once; no payment or subscription is created          | NOT RUN     |
| Trial end                                         | Isolated SQL clock                      | Continued use requires deliberate checkout; no auto-conversion               | NOT RUN     |
| Checkout conversion                               | Stripe test Checkout                    | Session alone grants nothing; verified webhook activates separate Access     | NOT RUN     |
| Active renewal                                    | Stripe Test Clock                       | Renewal event advances period without changing feature tier                  | NOT RUN     |
| Cancel at period end                              | Test portal + clock                     | Access remains through confirmed period end, then follows server state       | NOT RUN     |
| Immediate cancellation if supported               | Test portal + clock                     | Behavior matches explicitly approved portal policy                           | NOT RUN     |
| Payment failure                                   | Test Clock                              | Failure enters server-defined past-due/grace behavior without tier crossover | NOT RUN     |
| Three-day grace                                   | SQL + Test Clock events                 | Grace is exactly three days and remains server-authoritative                 | NOT RUN     |
| Grace expiration / lockout                        | Isolated SQL clock                      | Locked mode preserves data and permits billing/export                        | NOT RUN     |
| Payment recovery                                  | Test Clock                              | Signature-verified recovery restores Access without duplicate subscription   | NOT RUN     |
| Duplicate webhook                                 | Stripe CLI replay + focused test        | Replay is idempotent and creates no duplicate audit effect                   | NOT RUN     |
| Out-of-order webhook                              | Focused test + test events              | Older event cannot broaden or regress newer entitlement state                | NOT RUN     |
| Separate ledger: feature active, Access missing   | Two synthetic subscriptions             | Feature tier remains; app follows Access trial/grace/locked state            | NOT RUN     |
| Separate ledger: Access active, free feature tier | Access subscription only                | App is usable; no paid AI/voice/cloud tier is invented                       | NOT RUN     |
| Customer portal                                   | Authenticated desktop flow              | Correct customer; both subscriptions named distinctly; safe return URL       | NOT RUN     |
| Multiple checkout attempts                        | Concurrent/retry test                   | One open logical attempt; terminal/expired attempt permits a new session     | NOT RUN     |
| Offline lease                                     | Focused test + offline desktop          | Valid current signed lease works only within its bounded policy              | PARTIAL     |
| Clock rollback                                    | Focused test                            | Durable high-water/revision checks fail closed without data loss             | PASS        |
| Admin/internal bypass                             | SQL + desktop                           | Only server-controlled identity bypasses; user metadata cannot               | NOT RUN     |
| v0.1.51 gate enabled                              | Final test-project rehearsal            | Remote config activates only the target version after all gates pass         | NOT RUN     |

- [ ] Every required row has timestamped evidence and an owner.
- [ ] No expected outcome was converted into a pass claim.
- [ ] Failed/retry events were observed through bounded status codes without raw provider details.
- [ ] Existing feature-tier subscribers retained their feature plan throughout Access transitions.

## Phase D — v0.1.51 production prelaunch

Complete before changing the gate:

- [ ] v0.1.51 signed release is published through the approved release process.
- [ ] Installer/update verification and real desktop boot pass on required platforms.
- [ ] Public pricing, account, terms, privacy, success, and cancel pages render at the final origin.
- [ ] Production migrations/functions match the test-proven artifacts and exact SHA.
- [ ] Production lease `kid`, private signer, reviewed client public key, rotation overlap, and
      emergency revocation owner match the test-proven key lifecycle.
- [ ] Production Stripe products, Price IDs, webhook endpoint, and portal configuration were
      independently reviewed in live mode without making a charge.
- [ ] Gate query still shows `enabled = false`.
- [ ] Data-preserving rollback operator is present and has database access.
- [ ] Product owner explicitly approves the activation window.

Safe prelaunch inspection:

```sql
select id, enabled, launch_at, minimum_version, trial_days, grace_days,
       monthly_price_usd, require_payment_method_for_trial
from public.app_access_launch_config
where id = 1;
```

Required before activation: one row; `enabled=false`; 30 trial days; 3 grace days; $20 monthly;
payment method not required for trial.

## Phase E — remote activation

Run only in the approved production SQL control with the product owner, billing operator, and
rollback operator present. The block fails closed if prelaunch invariants changed.

```sql
begin;

do $activation$
declare
  v_config public.app_access_launch_config%rowtype;
begin
  select *
    into v_config
    from public.app_access_launch_config
   where id = 1
   for update;

  if not found
     or v_config.enabled
     or v_config.trial_days <> 30
     or v_config.grace_days <> 3
     or v_config.monthly_price_usd <> 20.00
     or v_config.require_payment_method_for_trial then
    raise exception 'app_access_activation_precondition_failed';
  end if;

  update public.app_access_launch_config
     set enabled = true,
         launch_at = now(),
         minimum_version = '0.1.51'
   where id = 1;
end
$activation$;

commit;

select id, enabled, launch_at, minimum_version, trial_days, grace_days,
       monthly_price_usd, require_payment_method_for_trial
from public.app_access_launch_config
where id = 1;
```

- [ ] Transaction completed once with no precondition error.
- [ ] Result shows `enabled=true`, non-null server `launch_at`, and `minimum_version='0.1.51'`.
- [ ] Fresh eligible account starts one server-authoritative trial without payment collection.
- [ ] Existing feature subscriber retains the feature tier.
- [ ] Authenticated checkout uses the dedicated Access price and waits for webhook confirmation.
- [ ] Billing, export, and data access behave correctly in every post-launch state.

## Phase F — monitoring and abort

Monitor bounded aggregate counts and provider delivery status; never copy raw payloads or user data
into release notes.

Abort activation and start rollback if:

- webhook signature, retry, idempotency, or event-order behavior is uncertain;
- checkout/portal returns an unexpected host or wrong account;
- return-route parity fails;
- Access changes `profiles.tier`;
- trial begins twice, auto-converts, or requests payment;
- users lose workspace data, export, or billing access;
- the locked/grace state differs from the tested contract;
- secret or customer data appears in any output.

## Data-preserving rollback

The first rollback action is the remote gate, not schema deletion and not customer mutation:

```sql
begin;

update public.app_access_launch_config
   set enabled = false,
       launch_at = null
 where id = 1
   and enabled = true;

commit;

select id, enabled, launch_at, minimum_version
from public.app_access_launch_config
where id = 1;
```

Required result is `enabled=false`. Prelaunch mode restores app usability while preserving all
workspace, user, entitlement, billing, event, checkout-attempt, trial, and offline-lease data.
In short: preserve all workspace data and every server-side billing record.

During rollback:

1. Do not drop, delete, truncate, reset, cancel, refund, archive prices, or rewrite entitlements
   automatically.
2. Never modify, drop, reset, truncate, rename, replace, or otherwise mutate any pre-existing
   AccessRevamp `ar_*` object.
3. Preserve Stripe subscriptions and Supabase audit evidence until account-level reconciliation is
   reviewed.
4. Redeploy only a previously approved function artifact compatible with migrations `0032`–`0035`.
5. Keep Access and optional feature subscriptions separate during recovery.
6. Re-run the failed test-mode scenario before a later activation.
7. Record incident scope, timestamps, release SHA, bounded error codes, and the exact next owner.

## Evidence ledger

| Evidence family                     | Current status in this authoring environment                   | Release requirement                                       |
| ----------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| Static docs/checker/candidate diff  | PASS — focused owned-artifact checks only                      | PASS on final candidate                                   |
| Repository-wide secret scan         | NOT RUN during authoring                                       | PASS on exact RC, diff, and history                       |
| Supabase read-only cloud preflight  | PARTIAL — target lacks new Access objects; `ar_*` is protected | Recheck exact target before the reviewed application plan |
| Deno focused Edge tests             | NOT RUN — Deno unavailable                                     | PASS on release SHA                                       |
| Local Supabase SQL/RLS              | NOT RUN — Supabase CLI/`psql` unavailable                      | PASS in disposable DB                                     |
| Stripe product and price state      | NOT VERIFIED                                                   | Confirm read-only in selected mode                        |
| Stripe test Checkout/webhook/portal | NOT RUN during authoring                                       | PASS in selected test account                             |
| Stripe Test Clocks                  | NOT RUN during authoring                                       | PASS for purchased subscription scenarios                 |
| Public route walk                   | NOT RUN during authoring                                       | PASS at final origin                                      |
| Production deployment/activation    | NOT RUN and not authorized by this document                    | Explicit approval plus all gates                          |

## Final sign-off

- [ ] Every checklist item is complete or has an approved, documented exception.
- [ ] Independent reviewer confirms no merged subscription, secret leak, or live-data evidence.
- [ ] Rollback was rehearsed in the test project and preserves data.
- [ ] Exact next action, owner, environment, and time are recorded.
- [ ] Only then may the authorized operator perform v0.1.51 remote activation.
