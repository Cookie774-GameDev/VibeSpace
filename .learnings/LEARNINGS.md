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

## [LRN-20260927-CH33A] best_practice

**Logged**: 2026-09-27T07:28:00Z
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
A verified native process can still display a failed page when its Vite dev server is down.

### Details
After rebuilding official C1, the jarvis/WebView parent, original profile, and CDP 9223 identity all matched. The main WebView showed chrome-error because localhost:5173 refused connections. The actual native main URL was the root path, while the QA helper assumed a chat query route. Starting the original Vite server and reloading that same main WebView restored the persisted chat; no replacement browser or app instance was needed.

### Suggested Action
Before a one-time native send, verify process/profile/CDP, the actual Tauri main label, live dev URL, and loaded chat state. Treat a chrome-error page as a serving failure rather than a changed app identity.

### Metadata
- Source: error
- Related Files: app/src-tauri/tauri.conf.json; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH33/preflight.cjs
- Tags: native-playwright, vite, identity, one-time-send
- Pattern-Key: native.qa.devserver_preflight

---

## [LRN-20260927-CH33B] best_practice

**Logged**: 2026-09-27T07:28:00Z
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary
Review shell approval needs a restrictive default because interpreters can write without matching obvious destructive-command patterns.

### Details
The generated OpenCode Review bash policy allowed wildcard commands and asked only for selected destructive prefixes. A native PowerShell Set-Content command wrote the disposable fixture with no approval card. Changing the generated and frontend Review policies to ask by default, with exact safe-read allowances, produced a native bash permission card; Approve once then allowed exactly one fixture write. Full access behavior remained separate.

### Suggested Action
Keep generated harness rules and frontend permission projections aligned. Test a native interpreter write, the approval decision, and the file side effect, not only pattern matching.

### Metadata
- Source: error
- Related Files: app/src-tauri/src/harness/server.rs; app/src/lib/permissions/OpenCodePermissionProfile.ts
- Tags: opencode, review, authority, native-approval
- Pattern-Key: harness.review_shell_default

### Resolution
- **Resolved**: 2026-09-27T07:23:00Z
- **Commit**: 93fc9458e7017b9501d5720ed43737c8ed283f14
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH33/native-review-once2-1790493753307.json

---

## [LRN-20260927-CH33C] correction

**Logged**: 2026-09-27T07:33:00Z
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Select the native main WebView by Tauri window label, not the shared localhost URL prefix.

### Details
The official C1 process exposes both dictation and main pages on localhost:5173. A read-only restart probe used Array.find on that URL prefix and twice selected dictation, then reported main missing before requesting exit. Checking each candidate's Tauri currentWindow label found main reliably; the corrected graceful process exit and postrestart dedup check passed.

### Suggested Action
In native Playwright helpers, enumerate CDP pages, inspect Tauri metadata for label main, then verify URL and app readiness. Preserve the failed pre-exit receipts separately from product failures.

### Metadata
- Source: error
- Related Files: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH33/native-c1-graceful-exit2.cjs
- Tags: native-playwright, multi-webview, selectors
- Pattern-Key: native.qa.main_window_selector

### Resolution
- **Resolved**: 2026-09-27T07:32:25Z
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH33/native-process-restart-dedup-1790494344573.json

---

## [LRN-20260927-CH34A] correction

**Logged**: 2026-09-27T13:08:30Z
**Priority**: high
**Status**: pending
**Area**: workflow

### Summary
Continue authorized Prompt 01 work after a passing slice; do not end the task because the broader acceptance matrix remains unverified.

### Details
The previous response closed CH33 after a verified OpenCode Review repair and passing suite, yet explicitly listed multiple unproven Prompt 01 requirements. The user corrected that early stop and required completion without routine questions. A green slice is a checkpoint, not completion of the assigned prompt.

### Suggested Action
After each verified slice, claim the next exact unlocked area and continue current-source native acceptance and focused repairs. Preserve partial receipts and mark externally unavailable paths honestly; end only when all feasible acceptance is exercised or a concrete external blocker remains.

### Metadata
- Source: user_feedback
- Related Files: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/RESULT.md
- Tags: scope, continuation, native-acceptance
- See Also: LRN-20260927-CH33A
- Pattern-Key: task.continue_partial_matrix

---

## [LRN-20260927-CH34B] best_practice

**Logged**: 2026-09-27T13:20:00Z
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
For a new VibeSpace chat, switch the coding runtime before selecting that runtime's model, and wait for the chat and composer to settle after transitions.

### Details
The first native provider-draft helper queried a Codex option while the picker still showed only OpenCode routes. Its create and reload snapshots also briefly saw a stale chat or unmounted composer immediately after Playwright's wait predicate passed. The unsent chat stored no explicit backend affinity, so the correct displayed backend came from resolveChatBackendAffinity rather than a raw nullable field. Selecting the runtime first, then its model, and reconciling the same fixture after stable UI readiness passed with one unchanged 51-character draft and zero provider turns.

### Suggested Action
Native helpers should attest the main WebView, use persisted-affinity resolution for unsent chats, wait for both the active chat and visible composer, choose coding runtime before the model picker, and preserve once-only guards before retrying UI probes.

### Metadata
- Source: error
- Related Files: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-provider-route-continue.cjs; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-provider-draft-reload.cjs
- Tags: native-playwright, provider-switch, draft, readiness
- Pattern-Key: native.qa.route_switch_readiness

### Resolution
- **Resolved**: 2026-09-27T13:19:16Z
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-provider-route-continue-1790515004272.json; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-provider-draft-reload-1790515156491.json

---

## [LRN-20260927-CH34C] best_practice

**Logged**: 2026-09-27T13:39:00Z
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
Reconcile native asynchronous command and question UI actions from persisted state before repeating them.

### Details
Dismiss on a native OpenCode question kept the request pending and rendered a compact Reopen control; a helper incorrectly expected the card to disappear. A Codex `/mcp` picker click also produced its local user/system messages, but the helper's immediate database snapshot reported no fresh messages. Later read-only reconciliation found exactly one local receipt and one status response. The original failures and once-only attempt guards prevented a duplicate question rejection or command selection.

### Suggested Action
For native Playwright acceptance, assert the actual UI transition, then poll or independently reconcile persisted messages and request IDs after asynchronous handlers settle. Preserve the first failure receipt and attempt guard; do not repeat provider sends or authoritative actions merely because a test helper sampled too early.

### Metadata
- Source: error
- Related Files: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-opencode-question-reject.cjs; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-codex-mcp-status.cjs
- Tags: native-playwright, async, deduplication, mcp, question
- Pattern-Key: native.qa.reconcile_async_actions

### Resolution
- **Resolved**: 2026-09-27T13:38:19Z
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-opencode-question-reject-1790515771361.json; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-codex-mcp-diagnostic-1790516299399.json

---

## [LRN-20260927-CH34D] best_practice

**Logged**: 2026-09-27T13:58:00Z
**Priority**: high
**Status**: resolved
**Area**: native acceptance

### Summary
When the native main WebView stops responding, reconcile guarded sends through another WebView in the same original profile before restarting the app.

### Details
After a selected OpenCode skill Send click timed out, the official C1 main target stopped answering Playwright and direct CDP, while the dictation target and host process remained live. The dictation WebView shared IndexedDB with main and proved the exact guarded prompt had zero user messages. A graceful process-plugin exit from dictation and relaunch of the exact same binary/profile restored the main WebView. The unsent draft and selected Codex-origin skill chip persisted, and one guarded resume completed with a native skill tool call. Repeating Send blindly could have duplicated a delayed turn.

### Suggested Action
Keep a once-only guard before authoritative clicks. If main is unresponsive, verify process/profile identity and read persisted message IDs from a responsive same-profile native WebView; restart only the owned native instance when that read confirms no send, then reattest identity and reconcile the draft before one guarded resume.

### Metadata
- Source: error
- Related Files: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-dictation-reconcile.cjs; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-opencode-codex-skill-load.cjs
- Tags: native-playwright, webview, process-restart, deduplication, skill
- Pattern-Key: native.qa.hung_main_reconcile_restart

### Resolution
- **Resolved**: 2026-09-27T13:56:16Z
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-dictation-reconcile-1790517170277.json; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-mcp-chat-preflight-1790517333061.json; work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/evidence/CH34/native-opencode-codex-skill-load-1790517376667.json

---
## [LRN-20260927-CH34E] knowledge_gap

**Logged**: 2026-09-27T15:07:00Z
**Priority**: high
**Status**: pending_verification
**Area**: frontend

### Summary
A protected Codex native question is projected through the canonical kernel as a separate assistant message, while OpenCode's legacy question path updates the streaming placeholder.

### Details
The first Stop fix modified `liveOpenCodeQuestions` and passed a focused legacy-path test, but official C1 Codex still left its new native question pending after the run became Cancelled. Source tracing showed the canonical `KernelQuestionProjectionPort.project` appends its own row and tracks IDs in `projectedQuestionBlockIds`; the outer legacy catch never owns those parts. A second repair closes pending IDs from that exact canonical turn in its `finally`, leaving prior or answered questions unchanged. Native post-repair verification remains pending.

### Suggested Action
Before changing a shared native question lifecycle, trace the selected harness through its actual persistence path. Test the canonical and legacy paths separately, and require a native Stop/reopen receipt for a Codex claim.

### Metadata
- Source: error
- Related Files: app/src/lib/ai/runtime.ts; app/src/lib/ai/runtime.test.ts
- Tags: codex, native-question, cancellation, canonical-kernel, acceptance
- Pattern-Key: chat.questions.canonical_vs_legacy_persistence

---
## [LRN-20260927-CH34E-VERIFY] resolution

**Logged**: 2026-09-27T15:18:19.1183073Z
**Status**: resolved
**Area**: frontend

The canonical-path repair described in LRN-20260927-CH34E passed official C1 native Playwright: one new Codex question was persisted pending, one Stop closed that exact new block as `cancelled` with the run `Cancelled`, and no duplicate user send. `evidence/CH34/operator/native-codex-canonical-cancel-v2-1790522131982.json` records the outcome and latency; prior pre-fix stale cards remain pending and were not migrated. Runtime tests 260/260, neighboring question tests 86/86, typecheck, and release-manifest 45/45 passed on this source. The distilled rule is to track and reconcile question IDs in the canonical kernel projection port, separately from legacy streaming-placeholder state.

- Related: LRN-20260927-CH34E
- Pattern-Key: chat.questions.canonical_vs_legacy_persistence

---

---
## [LRN-20260927-CH34F] error

**Logged**: 2026-09-27T15:52:00Z

**Priority**: medium

**Status**: resolved

**Area**: workflow

### Summary
PowerShell double-quoted append text can interpret Markdown backticks as escapes, corrupting evidence paths.

### Details
An append-only RESULT checkpoint used a double-quoted PowerShell string containing backtick-delimited Markdown paths. The backtick before `evidence` became an escape character. The historical line was preserved and a following correction supplies both exact paths.

### Suggested Action
Use a single-quoted here-string or a structured file-write tool for literal Markdown, then read the appended tail before citing it.

### Resolution
- **Evidence**: work/mini-prompts/01-native-chat-harnesses/20260925T2232Z-CH31/RESULT.md, CH34 broad suite scheduling checkpoint and its immediate correction.
- **Pattern-Key**: workflow.powershell_literal_markdown_append

---
## [LRN-20260927-CH34G] error

**Logged**: 2026-09-27T16:56:30Z

**Priority**: high

**Status**: open

**Area**: workflow

### Summary
A path-scoped `git add` followed by an unqualified `git commit` included other agents' already-staged files in a shared worktree.

### Details
Commit `3d1c7d2989778adfef44c9b885048373d328bcf5` was intended for `app/src/features/chat/assistant-rich-text.css`, but the shared index contained 23 staged voice/auth/chat paths. The commit retained their file contents under an inaccurate CSS-only title. The voice owner was informed; no history rewrite or peer file reset was attempted.

### Suggested Action
In a shared worktree, inspect `git diff --cached --name-only` and commit only explicit owned paths with `git commit --only -- <paths>` or a carefully isolated index. Abort if the staged set changed unexpectedly; do not treat `git add -- <path>` as restricting a later plain commit.

### Resolution
- **Evidence**: commit `3d1c7d2989778adfef44c9b885048373d328bcf5`, `docs/AGENT_COORDINATION.md` CH34 incident checkpoint.
- **Pattern-Key**: workflow.shared_git_index_unqualified_commit
