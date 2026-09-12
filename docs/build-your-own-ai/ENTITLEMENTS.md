# Build Your Own AI entitlement contract

## Principles

- Existing plan IDs remain `free`, `starter`, `pro`, `ultra`, and `apex`.
- The client never authorizes cloud work from persisted plan state. Supabase/Edge code derives the authenticated user's current entitlement snapshot server-side.
- Local privacy and ownership are not paywalled merely because the user uses their own CPU/GPU.
- Missing billing configuration leaves local features working and displays **Billing not configured**. It never simulates checkout or grants a paid tier.
- Prices and Stripe price IDs remain server-side. The client sends only a validated plan ID.

## Local capability floor

Every user, including signed-out/local-only and `free`, may:

- create at least one local project;
- author/import a bounded local dataset with scanning and consent review;
- run the deterministic fixture lifecycle;
- run real local training when hardware, license, dependencies, and explicit consent permit;
- evaluate, promote, use, export, and roll back locally licensed artifacts;
- keep raw examples, prompts, weights, and feedback local;
- delete or export local data.

Local resource bounds protect the device and storage; they are not a disguised cloud billing gate.

## Paid enhancement keys

Server entitlement snapshots use capability keys instead of client-side tier comparisons:

- `foundry.metadata_sync_projects`
- `foundry.team_members`
- `foundry.cloud_teacher_units_monthly`
- `foundry.cloud_evaluation_units_monthly`
- `foundry.hosted_artifact_bytes`
- `foundry.concurrent_cloud_jobs`
- `foundry.advanced_analytics`
- `foundry.priority_jobs`
- `foundry.managed_training_units_monthly` (reserved until a real managed service exists)

Each value is an integer/boolean plus a source, effective interval, and schema version. A missing key denies only that paid enhancement; it does not disable the local floor.

Exact tier values are seeded server-side only after product approval. The app renders the returned snapshot and must not infer an Apex capability from the string `apex`.

## Usage transaction

Cloud-metered operations use a request idempotency key and an immutable pricing/entitlement snapshot:

1. `reserve` locks the user/month ledger row, verifies the current entitlement, and records a unique pending event.
2. `consume` settles measured usage exactly once.
3. `release` returns an unused reservation exactly once.
4. `refund` creates a compensating immutable event; it never edits history.
5. Retries return the original result for the same user, operation, and idempotency key.

The database denies negative quantities, over-limit reservations, cross-user access, mismatched settlement amounts, and terminal-event reuse.

## Billing round trip

```text
authenticated user
  → client sends plan ID
  → authenticated checkout function validates user and plan
  → server resolves test-mode price ID
  → Stripe Checkout
  → raw-body signature-verified idempotent webhook
  → transactionally updated subscription/entitlements
  → refreshed server entitlement snapshot
  → UI enables only returned paid enhancement keys
  → authenticated portal session
```

Live-mode products, prices, webhooks, charges, migrations, and deployments require separate explicit approval.
