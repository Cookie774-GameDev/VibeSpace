# PR31 corpus context and backend hardening

Date: 2026-08-12

Branch: `agent/pr30-fixes-and-updates` (PR 31)

Starting head: `eda462daab1f8c6a36a6f5965f831f2fc568a5d4`

## Scope and invariants

This change set hardens backend behavior without changing product layout, styling,
copy, or navigation. It does not claim that a model accepts a 100-billion-token
prompt. It adds and verifies corpus metadata and bounded recursive-retrieval
primitives for corpora from 1 million through 100 billion tokens, with a validated 1
quadrillion-token metadata address limit. These primitives are not yet wired into the
production Context Map ingestion/retrieval path. Their model-facing evidence budget
is capped at 32,768 estimated tokens.

No production Stripe, Supabase, or Cloudflare mutation was performed. Stripe checks
were network-free and used injected test doubles; Supabase schema hardening was
verified from the repository migration and tests; Cloudflare Worker behavior was
verified locally. This avoids charges, customer impact, production data writes, and
deployment drift.

## Implemented changes

### Corpus-scale recursive context

- Added exact `bigint` corpus metadata and canonical decimal serialization.
- Validated 1M, 10B, and 100B corpus sizes without unsafe JavaScript-number
  conversion.
- Added a recursive retrieval planner with strict iteration, query, item, and token
  budgets.
- Added source revision, SHA-256 digest, timestamp, and locator provenance to every
  evidence item.
- Added cancellation before and during retrieval, loop detection, duplicate-evidence
  rejection, fail-closed dependency validation, and immutable results.
- Kept the model-facing evidence budget independent from the addressable corpus size.
- Exported the primitives for a later production integration; this slice does not
  claim end-to-end corpus ingestion, indexing, retrieval, or OpenCode delivery.

### OpenCode harness

- Added bounded parsing for text and JSON model catalogs.
- Preserved provider/model attribution and deterministic de-duplication.
- Passed model identifiers containing supported spaces and punctuation as one literal
  argument through the native argv boundary.
- Rejected option-looking identifiers, control characters, bidirectional overrides,
  oversized identifiers, malformed catalogs, and excessive model counts.
- Kept prompts on stdin and did not read, write, or log OpenCode authentication files.
- Wired the bounded catalog parser to the native read-only `opencode models` probe and
  the connection-specific model selector after current-session installation and
  authentication are verified.
- Discovery is fail-closed for unknown/unauthenticated sessions, timeouts, nonzero
  exits, truncated output, malformed output, and unrelated connection-state changes.
- This does not provision arbitrary provider credentials into OpenCode. Provider API
  keys continue to use the app's existing BYOK routes; OpenCode credentials remain
  owned by OpenCode's supported authentication flow.

### Cloudflare news ingestion

- Preserved scheduled-only ingestion and existing public response shapes.
- Renewed and re-verified the D1 fencing token after upstream fetches and before
  persistence/audit finalization.
- Guarded news-item inserts, retention, and audit writes with the current run and
  fencing token; kept inserts idempotent and grouped audit/retention in a D1 batch.
- Kept streaming body reads bounded by bytes actually read, with timeouts and bounded
  retries.
- Separated scheduled run identity from actual start time.
- Made candidate/model ordering deterministic.
- Rejected missing source timestamps rather than inventing current time.
- Recorded a run with zero usable dated candidates as failed rather than fresh.
- Reported stale data truthfully even when an older partial snapshot was already
  degraded.

### Benchmark refresh and model updates

- Added process-wide single-flight for live benchmark refreshes and refresh audits.
- De-duplicated by provider plus model rather than ambiguous display names.
- Rejected generic fallback `score` fields whose metric cannot be established.
- Stopped manufacturing confidence intervals when a source does not provide them.
- Preserved curated-snapshot provenance and marked stale fallback explicitly.
- Preserved the exact successful Wu Long or direct LMArena source through fresh and
  stale cache paths.
- Added deterministic discovery tie-breakers, endpoint-scoped news single-flight, and
  upstream freshness propagation without sharing row-dependent selection across
  callers.

### Account, Supabase, Stripe, and Jarvis lifecycle safety

- Removed the outer React account key so account changes do not key-remount the entire
  protected child subtree.
- Added explicit cloud-user ownership inside the access host: an identity change
  aborts pending checkout/portal work, invalidates stale completions, clears account-
  scoped notices/errors/view-model state, and triggers a fail-closed access reload.
- This is scoped to the Access host. It does not claim changes to Jarvis learning, All
  About Me, task projection, queue, plan-sync, or WorkspaceRoot boot internals.
- Verified the existing `0038_backend_advisor_hardening.sql` migration keeps client
  ledgers non-writable, makes `set_phone_pin` security-invoker, removes redundant RLS
  work, and adds the missing administrator foreign-key index.
- Verified checkout creation cannot grant entitlements, customer/subscription identity
  conflicts fail closed, checkout attempts are idempotent, webhook reconciliation is
  durable and ordered, out-of-order events cannot broaden access, portal URLs are
  constrained to Stripe, and errors do not disclose secrets.

## Safety limits

| Boundary                 | Limit or behavior                                       |
| ------------------------ | ------------------------------------------------------- |
| Addressable corpus       | 1,000,000,000,000,000 tokens maximum                    |
| Final retrieved evidence | 32,768 estimated tokens maximum                         |
| Retrieval iterations     | 16 maximum                                              |
| Evidence items           | 256 maximum                                             |
| Queries                  | 8 per iteration, 64 total                               |
| OpenCode model catalog   | 65,536 characters, 2,000 entries                        |
| News ingestion           | Scheduled mutation path with lease/fencing verification |
| Billing authority        | Stripe webhook reconciliation, never checkout creation  |

## Verification record

The counts below are scoped assertion summaries, not a claim that every external
service or packaged application flow was exercised:

- Account identity and focused Access-host lifecycle scope: 18/18 assertions reported
  passed, including identity changes during deferred checkout and portal actions.
- Corpus planner scope: 12 new deterministic assertions reported passed. OpenCode
  discovery/invocation and model-selector scope: 20/20 assertions reported passed.
- Benchmark/model-discovery scope: 22/22 assertions reported passed.
- Cloudflare Worker and migration scope: 17/17 assertions reported passed.
- Supabase/Stripe migration, checkout, portal, webhook, and reconciliation scope:
  178/178 assertions reported passed using local fixtures/test doubles.
- TypeScript command: `npm --prefix app run typecheck`.
- Focused Access command:
  `npm --prefix app run test -- --run src/features/access/AccessAppHost.test.tsx src/features/access/InstalledAccessAppHost.auth.test.tsx`.
- Corpus/OpenCode focused-test command:
  `npm --prefix app run test -- --run src/features/context/corpusScale.test.ts src/features/context/recursiveContextPlanner.test.ts src/lib/ai/adapters/opencode.test.ts`.
- OpenCode selector command:
  `npm --prefix app run test -- src/lib/ai/adapters/opencode.test.ts src/lib/ai/useAccessibleChatModels.test.ts`.
- Formatting and whitespace: scoped Prettier checks plus `git diff --check`.
- Production build: `npm run build` passed (existing Vite chunking/dynamic-import
  warnings remained warnings).
- Release manifest: `npm run test:release-manifest` reported 43 passed and 1
  platform-specific skipped test.
- PR31 metadata bundle: `npm run verify:pr31-oss` passed.
- Account identity regression: 35/35 assertions reported passed.
- Repository-wide Vitest attempts reported no assertion failures in the files they
  completed, but retained workers prevented the run from scheduling/completing every
  test file before the bounded timeout. This is not recorded as a full-suite pass.
- Rust: `cargo check --manifest-path app/src-tauri/Cargo.toml` was not executable in
  this environment because the `cargo` binary is not installed.

Some Vitest processes retained pre-existing background handles after reporting their
assertion summaries and were stopped by bounded timeouts. This is recorded separately
from assertion status and is not converted into a clean process-exit claim.

## Deployment and rollback

No live deployment is part of this change. Application rollback is a normal revert of
the PR commit. The context modules are additive. The installed access change can be
reverted independently, although doing so restores account-keyed subtree remounting
and removes the explicit pending-action cancellation barrier.
The news and benchmark changes preserve public payload shapes, so rollback requires no
data migration. Supabase migration 0038 was audited and tested but not newly applied by
this work session.
