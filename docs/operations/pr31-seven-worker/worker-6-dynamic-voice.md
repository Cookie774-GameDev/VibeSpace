# PR31 Worker 6 — Dynamic Data, Model Foundry, Voice, and Calls

## Assignment

- Task: `VS-PR31-W6-DYNAMIC-FOUNDRY-VOICE-20260808`
- Role: Worker 6 Dynamic/Foundry/Voice writer
- Requirements: master §13 and §20
- Branch: `agent/pr31-w6-dynamic-voice-20260808`
- Start and end HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`
- External actions: none. No production call, provider request, deployment, billing action, secret mutation, model upload, or cloud training was performed.

## Closed gaps

### Hourly AI News

- Added a D1-backed singleton ingestion lease, exact scheduled-run key, and unique acquisition fencing token. Concurrent deliveries now admit one active ingestion, completed run redelivery is idempotently skipped, expired incomplete leases can be recovered by the same or a later run, stale holders cannot audit or finalize a recovered lease, and skips are counted with a bounded reason.
- Added a 12-second per-request timeout and two bounded retries (250 ms and 1 s) for transient network, timeout, 408, 429, and 5xx failures.
- Preserved the existing source concurrency cap, item cap, retention, URL/title dedupe, source attribution, published timestamps, verification state, and persisted ingestion audit.
- Added API freshness truth derived from the latest persisted ingestion run: `fresh`, `stale`, `degraded`, `failed`, or `never`. Failed or stale refreshes retain existing data and return a bounded warning rather than inventing live data.
- Added strict client parsing and a visible News panel status warning for retained data after a failed/degraded/stale refresh.
- Preserved deployed migration history: `0001_init.sql` remains the lease-free base schema and `0002_ingestion_lease.sql` adds the fenced lease table. Tests execute the real `0001` → `0002` sequence for both existing and clean databases.
- Updated setup and remote migration commands to apply the ordered D1 migration set, and removed the stale claim that a public read triggers ingestion.

### Persistent notification schedules

- Due reminders now use a bounded, durable delivery claim before any notification side effect and become `fired` only after successful delivery.

### Controller reliability follow-up

- Added an explicit `last_completed_run_key` lease field. A completed hourly redelivery remains deduplicated, while the same run can reacquire an expired incomplete lease after a worker crash.
- Unexpected post-acquisition ingestion errors now best-effort persist a bounded failed audit for freshness truth. Audit or lease-release failures do not replace the original ingestion exception.
- Replaced the terminal pre-delivery reminder update with a two-phase, per-reminder delivery claim. Claims expire after two minutes, are re-read and ownership-verified before side effects, finalize to `fired` only after successful delivery, release after delivery failure, and recover after a crashed poll. Old reminders without claim metadata remain compatible.
- Moved reminder claim, finalize, and release into a real Dexie transaction/CAS that serializes independent database connections. Every mutation and visible delivery revalidates the captured workspace against both current auth state and a fresh task row.
- Extended each 12-second source attempt through incremental response-body acquisition. Chunked or dishonest responses are canceled when decoded input would exceed exactly 2,000,000 bytes, without retaining the excess or retrying the deterministic oversize failure.

## Verified existing behavior (no code change)

- Benchmarks: real remote-source adapters with explicit fallback truth, normalized Top 25/Top 50 rows, source/date/confidence/normalization fields, cached freshness and stale UI, and persistent daily refresh/audit behavior.
- Model Foundry: local LoRA/QLoRA/full lifecycle, hardware/capability checks, checkpoint resume, artifact attestation, and trained-artifact chat activation remain covered.
- Scheduling: persistent one-time and recurring schedules, timezone-safe concrete occurrences, missed-run policy, occurrence claims, idempotency, history, retries, and cancellation remain covered.
- Voice/STT: local/cloud provider identity, device routing, cancellation, streaming/turn commit, and dictation failure truth remain covered.
- Calls/messaging: configuration, provider readiness, credits, number validation, approval, and error contracts remain covered without making a real call.

## Verification evidence

- Controller RED evidence: expired same-run recovery fetched 0 instead of 8 sources; unexpected failure returned the secondary release error instead of the original; active reminder claims redelivered; successful reminders had only one terminal update; delivery rejection escaped; stale claims were not replaced; concurrent polls delivered twice; a failed final `fired` write released an already-delivered claim for immediate duplicate retry; a headers-success/body-stall never settled; and a chunked 2,000,001-byte feed was accepted without cancellation.
- AI News worker and executable migrations: `vitest run --maxWorkers=1 src/free.test.ts src/migrations.test.ts` — 2 files, 13 tests passed.
- Notification delivery claims: `vitest run --maxWorkers=1 NotificationEngine.test.ts` — 1 file, 11 tests passed.
- Changed news, notification, task-service, and schedule regression gate — 9 files, 58 tests passed.
- Benchmarks/news discovery — 3 files, 15 tests passed.
- Schedules/tasks — 6 files, 41 tests passed.
- Model Foundry frontend — 6 files, 41 tests passed (existing React `act` warnings only).
- Calls/messaging gateway — 5 files, 24 tests passed.
- Composer/global dictation — 9 files, 67 tests passed (existing React `act` warnings only).
- Voice — 10 files, 93 tests passed (existing jsdom canvas/ref/`act` warnings only).
- `python -m py_compile app/src-tauri/workers/model_foundry/worker.py` — passed; no Python source changed.
- Applied both AI News migrations to an in-memory SQLite database and asserted the lease columns — passed.
- `git diff --check` — passed for tracked changes; new files have no trailing whitespace.
- Added-line secret scan — 0 matches.
- Final status/diff review — only assigned paths changed; no out-of-scope mutation observed.

### Cross-review closure — 2026-08-09

- RED reproduced all four review gaps: delivery continued after a workspace switch; no independent-connection Dexie claim CAS existed; lease SQL lacked fencing tokens; and `0001` incorrectly contained the lease table.
- GREEN app gate: NotificationEngine, independent Dexie claimers, repository initialization, News API, and News freshness — 5 files, 21 tests passed.
- GREEN Worker gate: fenced lease behavior plus executable sequential migrations — 2 files, 13 tests passed.
- Full app TypeScript reaches only the sparse-worktree missing visual/gold-standard fixtures and their two consequent implicit-any diagnostics; it reports no diagnostic in a Worker 6 path. Worker TypeScript remains environment-blocked by the missing declared `@cloudflare/workers-types` installation.

## Environment-limited checks and activation

- Worker `npm run typecheck` could not start because the existing install lacks the declared `@cloudflare/workers-types` package.
- Full app TypeScript completed with a 3072 MB Node heap and reported only the known sparse-worktree missing visual/gold-standard fixtures plus their two consequent implicit-any diagnostics; it reported no diagnostic in a changed Worker 6 file.
- Focused Rust compilation first timed out and then failed while compiling the `windows` dependency with OS error 112 (disk full). The exact task-created Cargo processes were stopped and the isolated task target was cleaned. No Rust file changed.
- Before an existing AI News D1 database runs this worker revision, apply `workers/ai-news/migrations/0002_ingestion_lease.sql`. No remote migration or deployment was performed.
- No `app/src-tauri/src/lib.rs` registration change is required.

## Remaining risk

The D1 atomic-lease semantics are covered with a stateful boundary fake and SQLite schema validation, but a remote D1 migration/deployment and live scheduled trigger were intentionally not exercised. Reminder claims prevent simultaneous delivery attempts, not exactly-once delivery: a renderer crash after a visible effect but before durable `fired` finalization can retry after the two-minute claim expires. This bounded at-least-once residual is intentional recovery behavior. The focused tests establish local behavior; production activation still requires the migration above and the normal deployment/CI authority.
