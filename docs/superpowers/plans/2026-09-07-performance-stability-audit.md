# VibeSpace performance and heavy-load stability audit

Date: 2026-09-07. Agent: VS-PERFAUDIT-20260907-A.
Repository: `C:/Users/viper/VibeSpace-UnifiedChungus-Final`; branch: `integration/UnifiedChungus-final`; audited base: `123deb05ca92781a87d96ae63a9e4963ecd6d94a` plus the existing shared working tree. Peer changes were preserved.

**Goal:** prioritize material reductions in unnecessary work and resource risk while preserving the interface, output quality, provider behavior, and durable data. This is an audit and implementation plan, not an implemented optimization release.

**Architecture:** retain React/Tauri, Dexie, existing native transports, and current recovery mechanisms. Improve indexed access, ordered persistence, and bounded queues at existing boundaries. Avoid a new framework or global rewrite.

**Execution constraints:** do not launch, restart, drive, or disturb the current app; do not use Playwright or browser QA. No product changes were made for this audit. Future native acceptance checks must be performed in the official desktop app in a separately authorized test session. Recheck current locks before implementing; this plan does not grant ownership of source files or permission to spawn agents.

## Recommendation and estimates

Start with the streaming barrier defect, the sync lookup index, and native byte budgets. Then address terminal flow control. These are more valuable than another round of small component memoization changes.

Percentages below describe a named subsystem and workload. They are **planning estimates or arithmetic scenarios, not measured app speedups**. They cannot be added. A 60% improvement in a subsystem consuming 40% of CPU would save about 24% of total CPU, assuming other costs stay constant. No defensible app-wide speedup or crash reduction percentage is available without baseline measurements.

| Priority | Change | Expected benefit and denominator | Confidence / effort |
|---|---|---|---|
| P0 | Fix streaming persistence barrier; bound supersedable writes | Removes a reproduced self-wait condition. With writes taking 1 second and progress every 120 ms, retaining one active and one latest pending snapshot instead of accumulating requests should sharply reduce queued snapshots; no reliable CPU percentage yet. | High source confidence; isolated reproduction, not native reproduction. Small fix, medium follow-up. |
| P1 | Index sync coalescing lookup | 20,000 pending rows with one match: **99.995% fewer candidate visits**. Hypothesis: **70–95% less lookup time** on large offline queues; near-zero gain on tiny queues. Total transaction gain will be lower. | High algorithmic confidence; latency range unmeasured. Small/medium including migration. |
| P0 | Bound native transport by bytes, including handshake | Current 256 slots × 4 MiB permits **1 GiB encoded-payload equivalent per full channel**, before decoded overhead. A provisional 16 MiB byte budget lowers this modeled ceiling **98.44%**. This is not a measured RSS saving. | High ceiling confidence; budget must be profiled. Medium. |
| P1 | Terminal batching plus end-to-end flow control | Full 4 KiB reads combined into 64 KiB batches: **93.75% fewer output events**. Practical hypothesis: **50–90% fewer IPC events** during sustained output; little benefit at idle. | Medium; Windows native measurement required. Medium/large because lifecycle correctness matters. |
| P2 | Bound eligible history/scrollback reads | A consumer needing 400 of 20,000 rows can materialize **98% fewer rows**. Hypothesis: **50–90% less query time**, **70–95% less transient payload memory** for eligible large-history operations only. | Medium; callers have different completeness requirements. Medium. |
| P0 foundation | Aggregate admission and pressure accounting | Prevents multiple individually bounded systems from exhausting the process together. No honest crash-reduction percentage without a failure baseline. | High need; staged medium effort. |

Estimates are hypotheses to accept or reject with representative fixtures. Do not present them as optimization results after implementation unless measured.

## Source findings

Paths in this document are relative to the repository above. Line anchors identify the audited working tree and may move.

### 1. Streaming persistence can wait on itself

`app/src/lib/ai/runtime.ts:6152` schedules asynchronous full-parts writes and tracks their promises in `pendingStreamingWrites`. The default flush interval is 120 ms (`:4644`). `settleStreamingWrites` (`:6176`) repeatedly waits until that set is empty. The question-resolution path (`:6794–6800`) creates a write that waits on this barrier and then adds that same write to the set. If an older write is pending, the barrier can loop and wait for the write that itself awaits the barrier.

`work/performance-audit-20260907/probes.mjs` extracts the actual helper and models that handler ordering. It reproduces one permanently pending write with zero updates; a predecessor-only snapshot model completes. This establishes the promise dependency defect under the modeled interleaving. It does not reproduce the native/provider interaction or prove that a particular observed UI symptom was caused by it.

Separately, progress flushes do not wait for prior persistence. `app/src/App.tsx:1430` connects runtime persistence to `messageRepo.update`; `app/src/lib/db/repositories.ts:1014` updates the row, reads it back, and queues synchronization. Slow storage can retain many full growing snapshots. The durable sync queue already coalesces matching entries, so it is incorrect to describe this as one permanently retained sync row per token.

### 2. Sync coalescing scans unrelated pending rows

`app/src/lib/db/repositories.ts:268` queries status `pending`, then filters table and row ID in JavaScript. `app/src/lib/db/kernelTurnTransactionAuthority.ts:200` has the corresponding kernel path. `app/src/lib/db/schema.ts:835` indexes `id, status, created_at`, without the compound lookup key. Repeated streaming updates amplify this scan during offline operation.

Preserve the existing ownership, legacy-claim, tombstone, and survivor rules. Optimize only candidate selection. Database versions are registered in `app/src/lib/db/database.ts:197`; current `DB_VERSION` is 15. The schema header's reference to `index.ts` is stale: that file now re-exports the database.

### 3. Count-bounded native frames can still consume substantial memory

`app/src-tauri/src/harness/codex_server.rs:25,640` already uses a bounded 256-entry synchronous channel. `managed_codex_app_server.rs:15` permits frames up to 4 MiB. Count limits therefore do not provide a small byte ceiling. Parsed JSON adds overhead; 1 GiB is an encoded-payload calculation, not a resident-memory measurement or a claim about normal traffic.

`codex_server.rs:139` also collects pre-initialization frames in a vector. An initialization watchdog exists, but timeout alone does not bound bytes accepted before it fires. Admission should cover channel and handshake retention, with cancellation waking blocked readers. This source area currently overlaps another agent's repair claim; coordinate before implementation.

### 4. Terminal rendering is bounded, but producer-to-renderer flow is incomplete

`app/src-tauri/src/terminal.rs:1190` reads up to 4096 bytes and emits each chunk. Emit completion does not acknowledge xterm consumption. `app/src/features/terminals/TerminalView.tsx:1254` correctly serializes xterm writes using its callback. `terminalRenderQueue.ts` already caps renderer queue characters at 262,144 and drops older batches under overload. The shared output router already indexes subscribers by session; it does not need a new per-pane routing optimization.

Batching lowers event overhead, but alone does not solve sustained overload or dropped content. Introduce bounded producer credits tied to consumption, preserving ordering and session generations. A producer that indefinitely exceeds consumption must eventually slow down, spill to bounded storage, or lose data. Slowing it under overload is the simplest lossless policy, but its timing effects must be tested with terminal clients.

The limit of ten terminal sessions (`terminal.rs:614,1022`) applies per project, not globally. Existing legacy capacity behavior may evict a session; do not silently change that policy during a performance patch.

### 5. Local limits do not form an aggregate memory budget

`app/src/stability/resourcePressure.ts` samples JS heap every ten seconds with an 80% threshold and cooldown. The effective terminal listener releases WebGL resources. This does not account for native allocations, WebView2 child processes, providers, or all GPU resources. The 1536 MiB V8 setting in `app/src-tauri/tauri.conf.json:26` is not a whole-app cap.

`app/src-tauri/src/context_search.rs` bounds running workers to four and individual mutation payloads to 64 MiB, but requests can be materialized before worker admission. Waiting work therefore needs its own byte/count budget. Existing limits are useful and should be retained, with aggregate admission added at the earliest practical boundary.

The renderer watchdog already has retry limits and a recovery circuit (`app/src-tauri/src/renderer_watchdog.rs`). A new unconditional reload loop would worsen stability and risk replaying side effects. Recovery must preserve durable state and never automatically repeat an ambiguous provider/tool action.

### 6. History improvements must respect caller semantics

`app/src/features/chat/hooks.ts` already uses indexed bounded initial reads (400 messages) and older-page increments. This is not a missing optimization.

`messageRepo.list` in `app/src/lib/db/repositories.ts:955` can materialize and sort before slicing; `listByChat` intentionally loads complete history. Full-history consumers include usage calculation (`app/src/lib/usage/usageService.ts:326`), prompt-source preparation (`app/src/features/chat/Composer.tsx:4674`), and branching (`app/src/features/chat/chatLifecycle.ts:318`). Optimize each separately: exact incremental usage aggregates; bounded indexed scrollback queries; range-bounded branching with timestamp/ID ties preserved. Exports and model context must remain complete according to their current contracts. Never truncate model history simply to achieve a memory percentage.

`terminalScrollbackRepo` in repositories (`:2465,2475`) reads/sorts before limiting. Use the existing suitable index where its ordering matches the contract, with explicit deterministic tie handling.

## Items deliberately below the first batch

- Browser-chat surfaces parked at 1×1 offscreen remain shown intentionally to avoid a Windows compositor/reload regression (`app/src-tauri/src/browser_chat_surface.rs:236`). Unconditionally hiding, suspending, closing, or sharing browser storage risks active generations, media, uploads, form state, and account isolation. Investigate only after profiling and fixing those prerequisites; no credible general memory percentage yet. Workbench surfaces already close when hidden, so that is a different lifecycle.
- Existing bundle artifacts contain large terminal/tokenizer chunks, but their size does not prove eager loading or current-HEAD freshness. Measure actual cold-start dependency costs before changing splitting or claiming startup percentages.
- Workbench saves already debounce; undo history is bounded and shallow copies share immutable strings. Terminal transcripts also have batching/caps. Avoid claiming multiplicative memory savings from objects that share content, or rewriting already-bounded systems without a profile.

## Implementation plan

### Task 0 — establish bounded, reproducible measurements

Claim only the selected files after reading current coordination state. Record commit plus hashes of dirty audited dependencies. Use fixture databases and synthetic providers, never the user's live data. Add test-only counters for queue count/bytes, in-flight writes, candidate visits, IPC events, and completion latency. Record median and p95 across at least five comparable runs, separating cold and warm caches. Measure process memory using native process identities and deduplicate shared WebView2 PIDs; JS heap alone is insufficient. Avoid logging prompts, output bodies, tokens, or secrets.

Fixtures: 1/4/10 concurrent sessions; 100/5,000/20,000 pending sync entries; long growing message streams; storage delays of 0/120/1,000 ms; 1 KiB through maximum-size native frames; terminal output below and above rendering capacity. Native load runs are deferred until an authorized official-app test session. The current app must remain untouched.

### Task 1 — correct the streaming barrier first

Owned implementation scope to claim: `app/src/lib/ai/runtime.ts`, `app/src/lib/ai/runtime.test.ts`; add a small private writer helper only if needed for isolated testing.

1. Add a failing regression using deferred persistence: older flush pending, question resolves, older flush completes. Assert question write and final settlement complete in order.
2. Ensure a dependent write waits only on predecessors, never a mutable set containing itself. Audit every settlement call, including cancellation, errors, and finalization. Do not replace every barrier with a snapshot blindly: final drain must include all work it owns.
3. Separately bound supersedable progress snapshots to one active write and one latest pending snapshot. Keep question, permission, tool transitions, cancellation, and final state ordered and non-droppable. Persist full authoritative final content before reporting durable completion. Surface write failures through existing error handling.
4. Test slow writes, rejected writes, two question resolutions, final-event races, cancellation, and exact final parts. Verify no unresolved barrier and a bounded backlog. Run focused runtime tests and TypeScript check once after the final change.

First land the minimal correctness repair; land write coalescing separately if it broadens the review. Do not claim zero loss of unacknowledged in-memory progress after abrupt process termination.

### Task 2 — add the sync candidate index

Claim `app/src/lib/db/schema.ts`, `database.ts`, `repositories.ts`, `kernelTurnTransactionAuthority.ts`, and focused database/sync tests.

1. Add a new schema version (16 if still next), preserving versions 1–15. Add `[status+table+row_id]` to the existing sync queue indexes.
2. Replace both full-pending candidate scans with compound equality queries. Leave owner/claim filtering and coalescing decisions unchanged.
3. Test an existing-version database upgrade with queued entries and verify no data loss. Include different owners, active claims, legacy claims, unrelated rows, tombstones, and transaction rollback.
4. Benchmark candidate visits and wall time for the fixture sizes above. Run `kernelTurnTransactionAuthority.test.ts`, relevant repository tests, `src/lib/sync.transaction.test.ts`, and `src/lib/sync.test.ts` in the app's existing test runner. Inspect failures before expanding checks.

Acceptance: identical surviving queue records and ownership; lookup visits scale with matches rather than all pending records. An additive index migration is not reversed by deleting user data; rollback code must remain compatible with upgraded databases.

### Task 3 — native byte budgets and cancellation

Claim only after the Codex repair owner releases overlapping hunks: `app/src-tauri/src/harness/codex_server.rs`, `managed_codex_app_server.rs`, and their Rust unit tests.

1. Add byte accounting before retaining decoded frames; cover handshake and normal channel paths with one coherent per-session budget. Keep the existing frame cap and count bound.
2. Start with 16 MiB as a benchmark candidate, not a production promise. Account for decoded expansion and temporary decoder buffers when choosing the actual ceiling.
3. Make capacity waits cancellation-aware. Reserve a control path so shutdown/errors cannot sit behind a saturated data path. Release permits on normal dequeue, parse failure, initialization failure, receiver drop, and cancellation.
4. Test maximum frames, stalled receiver, handshake flood, timeout, cancellation while full, and repeated open/close cycles. Assert bounded bytes, termination, and no lost accepted protocol messages. Run targeted Rust unit tests and cargo check after implementation.

Then add app-wide admission for simultaneous sessions using measured per-session cost. Do not arbitrarily kill existing sessions, lower model quality, or change authentication/provider routing to meet a budget.

### Task 4 — terminal batching and credits

Claim `app/src-tauri/src/terminal.rs`, `app/src/features/terminals/terminalOutputRouter.ts`, `TerminalView.tsx`, `terminalRenderQueue.ts`, and focused tests.

1. Batch output with a maximum size and maximum latency (initial candidates: 64 KiB and 8–16 ms). Flush partial output promptly; preserve byte/ANSI/UTF-8 order across split reads.
2. Add session-generation-scoped sequence/credit accounting. Return consumption credit at the real consumer completion boundary; ensure shared subscribers cannot double-ack. Specify hidden/detached consumers and transcript-only sessions before coding.
3. Bound native and IPC outstanding bytes; make disposal, renderer failure, and process exit unblock waits. Keep exit/cancel/control delivery independent. Retain compatibility during transport rollout.
4. Test exact output under floods, delayed write callbacks, session reuse, detached panes, resize, split escape sequences, exit while blocked, and renderer reconnect. Existing `terminalRenderQueue.test.ts`, `terminalOutputRouter.test.ts`, `TerminalView.execution.test.tsx`, and scrollback durability tests provide integration coverage.

Acceptance: no new output loss, bounded outstanding bytes, unchanged interactive behavior, and measured IPC reduction. Official-app acceptance must check real terminal programs and long-running child processes, not just mocks.

### Task 5 — targeted reads and aggregate pressure handling

Do these after the first measurements identify remaining hotspots. For history, change one consumer at a time with ordering, full-export, usage-total, and branch-boundary equivalence tests. Introduce exact cached usage aggregates only with invalidation for edit/delete/import; do not cache an approximation as authoritative usage.

For aggregate pressure, extend existing `resourcePressure.ts` and native resource boundaries rather than building a second watchdog. Use hysteresis: normal, constrained, critical. First evict regenerable idle caches and release idle GPU resources; then defer admission of additional expensive jobs. Bound waiting requests before materializing payloads. Preserve active work, durable writes, and cancellation responsiveness. Reuse existing error/status handling without changing UI layout. Set production thresholds from actual supported-machine measurements, not the JS heap limit alone.

## Heavy-load acceptance and recovery

“Never crashes” cannot be guaranteed: OS exhaustion, driver failures, corrupt storage, and external processes remain possible. The achievable target is bounded resource growth, controlled overload, failure isolation, and verified recovery without silent data loss or duplicate side effects.

In a separately authorized native test session, run a two-hour stress matrix followed by an eight-hour representative soak. Treat durations as proposed acceptance work, not checks performed here. Cover slow/full storage, offline sync accumulation, saturated native frames, output floods, provider disconnect, cancellation, renderer failure, and repeated open/close cycles. Use synthetic fixtures and a disposable profile for fault injection.

Required gates:

- Every queue has an explicit count or byte ceiling and a cancellation/disposal rule; memory plateaus rather than growing with elapsed test duration.
- Final persisted messages, tool transitions, and sync ownership match the baseline semantics. No silent loss of acknowledged durable data and no automatic replay of ambiguous external actions.
- Proposed responsiveness target: p95 input handling below 100 ms under the supported load profile; record native measurements before promising it.
- After warm-up and repeated identical cycles, investigate more than 10% growth in retained memory; allocator high-water marks require interpretation, so this is an investigation threshold, not proof of a leak.
- Existing renderer recovery circuit terminates repeated failure attempts; one failed pane/provider does not cause a global restart storm. Recovery restores committed state and clearly handles any uncommitted window.
- UI structure, styles, accessibility, account isolation, model settings, prompt/context completeness, attachments, exports, and terminal content remain unchanged. Run only tests relevant to changed boundaries, followed by official desktop acceptance.

Each implementation should be its own reviewable commit, with measured before/after results and a rollback reference. Do not bundle all tasks into one optimization rewrite.

## Verification performed for this audit

- Read-only source inspection of the paths above and existing safeguards; current app was not launched, restarted, driven, or profiled.
- `node work/performance-audit-20260907/probes.mjs` passed: current extracted barrier/helper ordering left one pending write; predecessor model completed. Scenario arithmetic is saved in `probe-results.json` alongside the probe.
- No current native acceptance, app CPU/RSS benchmark, full build, or crash-rate measurement was performed. Code probes do not replace official-app checks.
- Prior Workbench/browser/Notes changes were already committed in `858ccca605a69e2afa2d7f5a08c5d3bba252d0c6`. Their earlier code checks passed; native acceptance was previously unavailable and is not retroactively claimed by this audit.

## Primary guidance checked

- [xterm.js flow control](https://xtermjs.org/docs/guides/flowcontrol/): producer speed must be tied to consumption; batching alone is insufficient.
- [Microsoft WebView2 performance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance): profile WebView workloads and their process/resource behavior before lifecycle changes.
- [Microsoft WebView2 process events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events): handle process failure explicitly and distinguish recovery cases.
- [WebView2 memory usage target proposal](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MemoryUsageTargetLevel.md): lifecycle/memory APIs require capability and version checks; this proposal is not proof that the installed Tauri integration exposes them.
- [Dexie collection limits](https://dexie.org/docs/Collection/Collection.limit()): use indexed bounded retrieval where caller semantics permit it.
- [Tokio channel guidance](https://tokio.rs/tokio/tutorial/channels): bounded queues apply backpressure. The existing synchronous Rust channel can implement the needed policy; this is not a recommendation to add Tokio solely for this work.
