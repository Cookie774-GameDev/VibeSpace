# Learnings

## [LRN-20260924-G7M] correction

**Logged**: 2026-09-24T21:24:00Z
**Priority**: high
**Status**: in_progress
**Area**: tests

### Summary
Native RLM tool-call receipts do not prove model-originated tool use or complete the task's acceptance gates.

### Details
The user corrected an earlier long-running handoff: 200 direct production-tool calls were conflated with the RLM provider requirement, and a passing older suite was described alongside unfinished native checks. Each claim needs its own fresh receipt tied to the current source and official app.

### Suggested Action
Report direct and provider-originated calls separately; close native cancellation, pointer authority, both CLI routes, stability, and final build gates before claiming completion.

### Metadata
- Source: user_feedback
- Related Files: work/plan1-R27-S9F3/rlm-receipts/ROOT_NUTTX_20260924_DIRECT_200_003.json
- Tags: rlm, native-verification, provenance

---

## [LRN-20260924-G7N] correction

**Logged**: 2026-09-24T21:52:00Z
**Priority**: critical
**Status**: in_progress
**Area**: tests

### Summary
A recall scorer that hardcodes semantic-review booleans is not a correctness oracle.

### Details
The independent forensic audit replaced all twenty recorded answers with wrong text in memory; the current scorer still returned 10/10 for source and recall. Earlier reported 10/10 semantic scores are therefore unverified, even though the raw turns and citation metadata remain useful evidence.

### Suggested Action
Preserve the raw run, require attributable per-answer review against the private key and actual answer citations, and add wrong-answer and wrong-citation negative controls before reporting a semantic score.

### Metadata
- Source: user_feedback
- Related Files: work/plan1-R27-S9F3/native-ten-recall-score.cjs
- Tags: falsifiable-oracle, semantic-correctness, rlm

---

## [LRN-20260924-G7P] best_practice

**Logged**: 2026-09-24T21:52:00Z
**Priority**: high
**Status**: in_progress
**Area**: tests

### Summary
Verify one live end-to-end route before multiplying provider calls, worker reports, or full-suite runs.

### Details
The forensic audit found that adapter-level tests and 200 repeated direct RLM calls did not prove the active chat-to-tool route; two full suites predated later fixes. Queue lifecycle receipts also lacked complete usage provenance. Game retry and repaired outputs must keep their actual prompt sequence and artifact hashes distinct from the original arm.

### Suggested Action
Use a small native matrix with negative controls and source fingerprints, then 10–20 stable turns, then one frozen-source full gate. Reuse the authorized three workers and keep task cost/provenance denominators separate.

### Metadata
- Source: user_feedback
- Related Files: work/plan1-R27-S9F3/native-canonical-queue2-retest-final.json
- Tags: native-route, test-order, cost, game-provenance

---

## [LRN-20260924-G7Q] best_practice

**Logged**: 2026-09-24T21:52:00Z
**Priority**: high
**Status**: in_progress
**Area**: infra

### Summary
Check free space before native builds and redirect large disposable targets to D:.

### Details
C: reached zero free space during this task and two owned scripts plus a Rust source file were truncated on attempted writes. The source and receipts were restored; the interrupted Rust test is not a pass.

### Suggested Action
Keep source bytes verified after write, use the declared D: Cargo target, retain C: headroom, and record incomplete gates rather than retrying large builds on a full volume.

### Metadata
- Source: user_feedback
- Related Files: app/src-tauri/src/harness/server.rs
- Tags: enospc, native-build, source-integrity

---
## [LRN-20260925-G7R] correction

**Logged**: 2026-09-25T00:37:00Z
**Priority**: critical
**Status**: in_progress
**Area**: backend

### Summary
VibeSpace must not supply replacement file read/write or arbitrary command tools to Codex or OpenCode.

### Details
The user explicitly corrected a prior fix that routed file creation through a VibeSpace action card. Codex and OpenCode already supply native file and shell tools and their own permission system. VibeSpace-specific Context/SiYuan/RLM, URL, settings/navigation, terminal messaging and native CLI launch controls remain useful. Historical file-result evidence may remain readable even when new VibeSpace file actions are retired.

### Suggested Action
Remove live VibeSpace file/command registrations, fallbacks, prompts and assistant intents; verify the native CLI routes and retained app-specific actions separately.

### Metadata
- Source: user_feedback
- Related Files: app/src/lib/actions/registry.ts, app/src/lib/ai/runtime.ts, app/src-tauri/src/harness/server.rs
- Tags: native-cli, tool-ownership, correction

---

## [LRN-20260925-G7S] best_practice

**Logged**: 2026-09-25T15:40:33Z
**Priority**: high
**Status**: in_progress
**Area**: tests

### Summary
Native chat continuity tests must distinguish a driver timeout from a late completed CLI turn.

### Details
The official OpenCode GPT-6-Luna chat persisted correct state replies after a short driver deadline. The app also entered ambient mode during the long run, intercepting the next Send click. Repeating the prompt or starting a new chat would lose the same-session proof and could duplicate work.

### Suggested Action
Wake ambient mode before each send, wait for a visible terminal status with a wall-clock deadline, and verify persisted message counts and answer state before resuming the same chat from a bound receipt.

### Metadata
- Source: conversation
- Related Files: work/plan1-R27-chat-stability-G7M4/native-chat-stability.cjs
- Tags: native-app, cli-continuity, timeout, test-provenance

---

## [LRN-20260925-LQ35] best_practice

**Logged**: 2026-09-25T20:41:03Z
**Priority**: high
**Status**: in_progress
**Area**: tests

### Summary
Opening the official native app does not prove it contains the current Rust source.

### Details
VibeSpace was restarted with a visible official `jarvis.exe` and a live Vite frontend, but the executable was the D-drive debug build from September 24. Its running WebView proves startup and frontend loading, while backend edits made after that build remain untested until a coordinated rebuild. The startup receipt records PID, profile, CDP, and executable hash.

### Suggested Action
For each native acceptance, record the exact executable hash/build time and frontend source fingerprint. Rebuild affected Rust code once under the native/build lease, then run the real scenario. Keep app-start success and source-current feature acceptance as separate results.

### Metadata
- Source: conversation
- Related Files: work/vibespace-start-SV31/start.json, docs/CHAT-FORENSIC-LEARNINGS-2026-09-25.md
- Tags: native-app, build-identity, evidence-boundary
- See Also: LRN-20260924-G7P

---

## [LRN-20260926-RLM] best_practice

**Logged**: 2026-09-26T04:20:05Z
**Priority**: high
**Status**: pending
**Area**: tests

### Summary
Treat asynchronous cancellation as acknowledged only when the remote session explicitly confirms it.

### Details
OpenCode stream closure or a settled local child proves only local completion. The harness awaited bortSession but ignored a false response and swallowed request failures; the RLM abort wrapper also replaced a typed child failure with generic cancellation. A later session-cleanup rejection could mask the typed failure again.

### Suggested Action
At cancellation boundaries, require a positive abort response, preserve typed negative acknowledgements across wrappers and cleanup, and test positive, false, rejected, timeout, and no-follow-up behavior. Keep native acceptance separate from mocked source tests.

### Metadata
- Source: conversation
- Related Files: app/src/lib/harness/openCodeHarness.ts; app/src/features/context/contextRlmProduction.ts; app/src/features/context/rlmRuntime.ts
- Tags: cancellation, native-ack, RLM, async-cleanup

## [LRN-20260926-RLM-AUTH-SHAPE] best_practice

**Logged**: 2026-09-26T08:49:00Z
**Priority**: high
**Status**: pending
**Area**: authority-boundaries

### Summary
Check each authority field against the object that actually owns it.

### Details
The live RLM authority reader returns an observed execution record containing `executionIdentity`, `performance`, and `scopeRevision`; account/project/workspace scope remains on the session authority claim. Reading `observed.scope` made a correctly active Codex turn fail closed every time because the property does not exist. Also, a DOM can contain repeated visible nodes for the same chat ID; deduplicate identical IDs while still rejecting multiple distinct visible chats.

### Suggested Action
Before adding an authority predicate, inspect both its TypeScript shape and reader implementation. Keep current scope checks on the session claim, compare observed revision/performance/identity separately, and test the exact injected expression plus the actual supplied-Page probe callback with duplicate and distinct DOM identities.

### Metadata
- Source: conversation and verified repository source/tests
- Related Files: app/src/lib/harness/toolGatewayAuthority.ts; work/mini-prompts/02-siyuan-rlm/20260925T22S2L8/c2-rlm-negative-controls.cjs; work/mini-prompts/02-siyuan-rlm/20260925T22S2L8/c2-native-invoke-observer.cjs
- Tags: authority, fail-closed, DOM-identity, RLM

## [LRN-20260926-SP26] best_practice

**Logged**: 2026-09-26T17:10:11.4671918Z
**Priority**: high
**Status**: pending
**Area**: tests

### Summary
Native WebView source-current testing needs a native build whose configured dev URL matches the served frontend origin.

### Details
The official C2 WebView on a 5173-built executable could navigate to the current source on localhost:5174 and still expose `window.__TAURI_INTERNALS__`, but VibeSpace's runtime profile handshake failed with "native query unavailable". The injected object alone did not prove working native commands. The C2 chat page became unusable until the native binary was rebuilt with devUrl 5174.

### Suggested Action
For isolated native QA, build and launch the assigned instance with a devUrl that matches its task-owned frontend server. Verify the process/profile/CDP identity and successful runtime profile handshake before accepting Playwright UI results. Preserve other instances and their servers.

### Metadata
- Source: error and verified native C2 Playwright observation
- Related Files: app/src/lib/runtimeProfile.ts; work/skill-picker-20260926/root/tauri-c2-5174.json
- Tags: native-app, build-identity, dev-url, profile-handshake

---

## [LRN-20260926-SP26B] correction

**Logged**: 2026-09-26T23:52:00Z
**Priority**: medium
**Status**: resolved
**Area**: workflow

### Summary
Keep executing independent verification and commit preparation while a long required test suite runs.

### Details
The user corrected repeated passive waiting during this task's full app suite. Native C2 keyboard QA, staged-diff review, and scoped commit preparation could proceed without changing the suite or another agent's files.

### Suggested Action
During long checks, choose the next independent task-owned verification or preparation step and report concrete progress. Poll the suite at checkpoints; do not pause useful work simply because a gate is still running.

### Metadata
- Source: user_feedback
- Related Files: work/skill-picker-20260926/root/native-skill-keyboard.cjs
- Tags: parallel-verification, native-qa, long-checks

---

## [LRN-20260927-SF27] correction

**Logged**: 2026-09-27T04:47:51Z
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
A compact skill picker still needs bounded native discovery and safe handling of an occupied Codex app-server.

### Details
The prior picker reused an in-memory catalog but first-open Codex discovery forced a reload, could wait behind a long turn, and displayed the native owner/route error verbatim. Recovering a remembered generation during read-only discovery would risk stopping an active turn, so preserve the native ownership boundary.

### Suggested Action
Use cached CLI discovery for ordinary opens, reserve force reload for Refresh, bound the lease wait, and present a short retry message for occupied native routes. Verify attach latency in the official native C2 app.

### Metadata
- Source: user_feedback
- Related Files: app/src/features/chat/Composer.tsx; app/src/lib/ai/adapters/codexPersistent.ts
- Tags: native-skill-picker, busy-route, responsiveness

---
