# VibeSpace chat retrospective: failures, causes, and faster working rules

**Cutoff:** September 25, 2026, after the user asked to restart VibeSpace. **Purpose:** learn from this conversation and its recorded implementation, tests, corrections and audits. This is a retrospective, not a claim that the unfinished features are fixed. Exact remaining product work is in [REMAINING-WORK-2026-09-25.md](REMAINING-WORK-2026-09-25.md). The separately owned Plan 2 handoff is `work/plan2-execution-20260924/root/REMAINING-WORK-20260925.md`.

**Evidence basis and limit:** user requests/corrections visible in this chat; the [20-hour forensic audit](<C:/Users/viper/Downloads/2026-09-24-VibeSpace-Agent-20h-Forensic-Audit.md>); `docs/AGENT_COORDINATION.md`; `.learnings/LEARNINGS.md`; and the named receipts below. The forensic audit sampled source, logs and receipts rather than reviewing every byte of every worker transcript. Some delegated payloads were not readable. Therefore, this file distinguishes a **confirmed defect**, a **confirmed missing proof**, and a **plausible cause**. It does not assign an exact number of wasted hours or account usage to each cause. The user's changing scope and real provider/native failures also consumed time; not all elapsed time was avoidable.

**Repository snapshot for this audit:** `C:\Users\viper\VibeSpace-UnifiedChungus-Final`, `integration/UnifiedChungus-final`, HEAD `8b7a194b5a08cb720bb0efe14399b7f25fccdb8e`, upstream `origin/UnifiedChungus`, many peer-owned uncommitted changes. This audit edits documentation and one append-only learning entry only. The app was started separately under `SV31`; it must remain untouched by this audit.

## The central mistake

We often proved a nearby component and then talked about the whole user-facing feature as though its end-to-end path had been proved. We also multiplied workers, scripts, and full-suite runs while the active native app and shared runtime were still the serial bottleneck. The fastest reliable strategy is to define the observable result first, prove one real native vertical path, repair its first missing boundary, and scale the test only after that path passes.

This is a change in **test order and evidence quality**, not a reason to skip tests, strip permission checks, rewrite the CLI, or lower product quality.

## 1. Confirmed failures and what I should do differently

### 1.1 I allowed the wrong tool ownership boundary

**User correction:** VibeSpace must not supply replacement file-read, file-create/edit, or arbitrary command-run tools to Codex CLI or OpenCode. Those CLIs already provide their native file/shell tools and permission systems. VibeSpace-specific Context/SiYuan/RLM, URL, settings/navigation, terminal messaging and native CLI controls are valid. Earlier work created or retained a VibeSpace file/action route the user explicitly did not want, leading to confusing approval cards and an extra way for the agent to act.

**Quality risk:** duplicate tool choices, inconsistent permission prompts, unclear provenance, and behavior that differs between users because of local configuration. A generic “command.run high risk” card on an ordinary command is not evidence that the underlying native CLI paused.

**Next time:** write a one-line ownership rule before touching adapters: *native CLI owns file and shell operations; VibeSpace exposes only app-specific capabilities*. Inspect the live native tool catalog, not just source registry names. Remove/keep one exact registration at a time, with a focused catalog test and a real native read/write/permission check. Do not invent a VibeSpace permission engine to compensate for a native CLI behavior that should be configured through the supported CLI route. Preserve historical tool cards as readable records without re-exposing retired actions. Existing learning: `LRN-20260925-G7R`.

### 1.2 I tested adapter primitives before the active runtime handoff

**Confirmed:** the forensic audit found `native-c1-closure-audit.json` with an active controller and Codex backend but `liveControls:false`; a later receipt after the bridge fix recorded `liveControls:true`. Protocol, adapter, steer and queue patches had accumulated before the missing runtime-to-kernel control handoff was proved. This does not prove every earlier timeout had that cause, but it identifies a real late-tested boundary.

**Time cost:** many local passing tests did not answer the user's immediate question, “does my chat actually work in the app?” Work then had to be reintegrated and retested after native failures.

**Next time:** reproduce the smallest failing action in the official WebView first. Trace one request with the same ID through **UI send → runtime controller → active kernel port → router → selected adapter → native CLI acknowledgement/event → durable store → reopened UI**. Stop at the first missing handoff. Add one failing integration test there; make the smallest fix; run focused tests; repeat the same native action. Only then add edge cases or batch calls. Do not mistake an adapter unit pass for this vertical pass.

### 1.3 I did not use a falsifiable RLM correctness oracle early enough

**Confirmed at the forensic cutoff:** the original ten-question scorer assigned both manual-correctness booleans to `true`. With all 20 answer texts replaced in memory by deliberately wrong answers, it still produced 10/10 source and 10/10 recall. Later work tightened citation equality and accepted/idle state, but the active private key and fresh answer semantics were not fully re-reviewed at the September 25 stop point. A syntactically valid citation is not proof that an answer is correct.

**Quality cost:** a numeric score looked precise while it did not validate the user-requested hard questions. The historical 8/10 and 10/10 figures cannot be promoted to final semantic acceptance solely from that scorer.

**Next time:** before any costly model run, test the scorer against **wrong answer with valid-looking citation, wrong citation, extra citation, missing review, stale source hash, rejected/non-idle turn and private-note leakage**. Preserve the raw run. Require per-question fact and citation decisions against the private key with reviewer/evaluator type and source version; unreviewed stays unreviewed. Do not rerun expensive model turns to fix a deterministic parser. Existing learning: `LRN-20260924-G7N`/the matching semantic-oracle entry in `.learnings/LEARNINGS.md`.

### 1.4 I blurred direct backend calls and model-originated RLM

**Confirmed:** one 200/200 result consisted of direct production-tool calls in the WebView (`providerGenerated:false`): 20 describe, 100 search, 40 open and 40 expand, repeatedly around one file. It proved useful backend operations. It did not include `investigate` in those 200 calls or prove the model selected the tools, built correct arguments, synthesized answers or used recursive child results. The provider-originated pilot was underfilled and semantically weak.

**Next time:** name three separate denominators: **direct backend invocations**, **parent model tool calls**, and **recursive child calls**. First prove one model-selected operation through the real dispatched manifest/native journal with a correct answer. Then one recursive `investigate` and a negative case. Then one representative batch. Only then run 200 calls with varied known facts, retries/failures counted separately. Never report “200 model calls” from a direct-tool receipt. Do not turn a finite 99% sample into an uptime claim.

### 1.5 I treated missing or zero token data as a usable number

**Confirmed:** the Ponytail collector initially searched assistant messages for receipts stored as system messages. Five recovered Saver receipts totaled 89,391 before and after and showed **0% local trimming**. Separately, a genuine queued follow-up completed, but the recovered second turn's saved usage was `{input:0, output:0}` without availability/provenance; that cannot prove it used zero tokens. The older matched OFF/ON result increased eligible input by 7.04%; the required ≥5% saving was not met.

**Time/quality cost:** extra parsers and experiments were built while the persistence-role/schema and metric definition were still unresolved. “Ponytail installed,” “local duplicate trimming,” and “whole task saved tokens” became conflated.

**Next time:** validate the exact persistence schema and a known receipt before writing a collector or spending provider turns. Carry `reported/estimated/unavailable` provenance through every queued/recovered turn; unknown is not zero. Define eligible-input baseline and matched OFF/ON workload before the run, include all retries/audit overhead/cache/output/reasoning where exposed, and keep answer quality/model/effort/tools equal. Report activation/delivery, local trimming and whole-task saving as three different results. Do not weaken prompts, output, or reasoning to reach 5%.

### 1.6 I inferred queue semantics from schema before watching the installed CLI

**Confirmed:** early queue code assumed explicit start/orchestration; later installed-version observation showed automatic dispatch on normal completion/resume, with explicit start mainly a recovery path. Later tests exposed generation shutdown and successor-authority issues. A completed queued turn with a nonempty answer did not automatically have complete usage evidence.

**In-app risk:** duplicate queued submissions, invisible continuation, stale tool authority, or a queue that appears complete but loses cost attribution.

**Next time:** observe the installed CLI's state machine with one queued item and exact native IDs before adding lifecycle logic. Test acknowledgement, automatic dispatch, lost acknowledgement, restart, cancellation, dedupe by client message ID, successor-tool authority and recovered usage. After an uncertain timeout, inspect state; never blindly resend or force-start the same submission. Test “once-only delivery” and “complete usage accounting” independently.

### 1.7 I mixed original, retried and repaired games

**Confirmed:** the native case-03 first run was `Failed` with zero artifact. Its retry used an additional prompt about the denied external directory and yielded a 13,523-byte artifact, but the native turn still said `Failed`. A later CSS repair changed the artifact; case-02 CLI Play Again repair also changed an artifact. Backups/disclosure exist, so this is not evidence of hidden tampering. It does mean the arms are not an unchanged, single-prompt comparison. Rewriting a `prompt.txt` metadata file cannot undo an extra live prompt.

**Next time:** keep three immutable identities: **original provider output**, **retry output with complete prompt sequence**, and **post-repair artifact**. Hash each, retain each failure/status and use separate gameplay and app-lifecycle columns. Compare the original matched prompt arms first; count retries and repairs separately. A playable game does not make the native `Failed` state pass. A corrected artifact can prove the repair, not the model's untouched generation quality.

### 1.8 I ran full gates before the final relevant source was stable

**Confirmed:** one pre-fix “final” suite attempt was cancelled after 12 minutes. Passing app suites later took about 1,889 and 1,714 seconds, with 16,516 and 16,517 tests respectively. More source changes followed, so those were not a clean final frozen-source gate. These passes are useful historical evidence; rerunning a truly invalidated gate is necessary. The avoidable part was calling it final while known native blockers still required source edits.

**Next time:** use focused tests for each bounded repair. Prove one real native path and settle its repair cluster before running the full app suite/build/Cargo check. Freeze and fingerprint the actual dirty source/dependencies, not just HEAD. Run the five repository gates once on that stable state; rerun only invalidated gates after later changes. Preserve cancelled/partial output as such. Do not search massive logs for the word “Error” and assume every negative-test expected error is a production failure.

### 1.9 I added too many parallel workers for a serial bottleneck

**Confirmed for the audited period:** nine direct helper threads were created despite that period's three-worker reuse contract. The audit does not show nine simultaneous billable workers or that each was useless; some late workers found real issues. The problem was overlapping prep/audit output while only one native C1 controller and a small shared runtime seam could be integrated at a time. “READY” often meant offline patch prepared, not native verified. Later user instructions changed the authorized worker count; the current explicit instruction always governs.

**Next time:** use only the currently authorized number, and only for independent bounded work with exact files, a test/receipt and a clear integration owner. The root must keep implementing and integrate each completed slice promptly. A documentation worker records meaningful events, not a constant polling diary. Do not create a new helper to restate a diagnosis an existing helper already owns. It is faster for a worker to be idle briefly than to generate another overlapping script or audit for the same C1 bottleneck. Serialize native UI/build ownership; keep C2 untouched.

### 1.10 I allowed C: storage pressure to become a build/evidence risk

**Confirmed:** the forensic audit observed C: nearly full and an `ENOSPC` retention failure. A subsequent learning records zero free space and interrupted writes that truncated two owned scripts and a Rust source file before restoration. This is an operational failure, not proof that disk caused the entire prior 20 hours. At this audit C: again has roughly 9 GB free, but large Cargo and test outputs can consume it.

**Next time:** check disk headroom before large native builds and full suites. Use declared D: target/evidence paths for large regenerable outputs, verify path containment before any move/delete, and hash/inspect source after an interrupted write. Preserve receipts and existing users' data. A Cargo run that stopped at “Compiling” has no passing test result. Avoid repeated build attempts on a full volume.

### 1.11 I did not finish the large SiYuan map before treating its index as success

**Confirmed current state:** 6,147 eligible source entries were indexed, but SiYuan node creation resumed only from 556 to 571 before durable `siyuan_response_too_large`. This is **not** a completed map, full graph, or proof every file/subfolder is visible. A Rust audit suggests oversized echoed batch-append transactions as a plausible cause; it has not proved the exact live response. The user also complained that progress animation was too subtle, failure was unclear, and redo did not obviously resume.

**Next time:** trace one failed batch's request/response and durable marker first. If size is confirmed, split same-parent batches conservatively **before send**, preserving order and IDs; never blindly retry an ambiguous mutating response. Run a focused HTTP regression, rebuild native, use safe recovery, and wait for a terminal Complete state. Compare production filesystem paths with stored index rows and visible SiYuan graph nodes; inspect deep folders. Capture two or more frames to prove hex motion and test clear Failed/Retry/Redo and Axo loading feedback. “Indexed” and “created in SiYuan” are separate acceptance states.

### 1.12 I allowed the Codex model picker blocker to linger without a direct catalog answer

**Confirmed current state:** OpenCode GPT-6 Luna LOW had a bounded native 10/10 same-chat result. Codex GPT-6 Luna had **0/10** turns because `openai-codex:gpt-6-luna` was absent from the picker. A safe isolated Codex `model/list` probe was prepared and self-tested but not run. The picker timeout by itself cannot say whether the installed Codex app-server lacks the model, entitlement differs, or VibeSpace's catalog mapping is wrong.

**Next time:** run one direct native catalog query early, with installed binary/version and sanitized IDs. Compare app picker to the actual list; fix mapping only if the native list contains the requested model. Verify both CLI paths by process/protocol/log identity and a real response; asking the model “which CLI?” is a supporting check, not proof. Do not substitute an OpenCode route or another model and call the requested Codex test complete.

### 1.13 I needed clearer stop conditions and user communication

**Conversation evidence:** the user repeatedly asked for speed, progress, an exact remaining list, and eventually a stop-point audit. Long source/test cycles and many parallel “ready” reports made completion hard to see. The final remaining-work MD arrived only after the user asked explicitly for it. Once the user asked to stop, stopping implementation and documenting what remained was correct; stopping earlier merely because a test was hard would not have been.

**Next time:** give compact progress at meaningful milestones and at least once per minute during active work: current result, one blocker, next measurable step. Keep one short acceptance table: requirement, exact native route, evidence, current status and owner. A failed check stays Failed or Pending, never “basically working.” Ask only when authorization or missing information is genuinely required; work on independent authorized tasks otherwise. When the user says stop, preserve the current receipt and stop. Avoid extra handoff prose, duplicate dashboards and repeated status polls that consume time without changing the result.

### 1.14 I must not confuse “app launched” with “latest source validated”

**Recent example:** on September 25 the official VibeSpace debug app was started and verified as a visible native window (`jarvis.exe` PID 35112, WebView PID 31908, CDP 9223, Vite HTTP 200). Its executable was the D: debug binary last written September 24. Live Vite serves current frontend files, but that older Rust executable does not include later backend edits until rebuilt. The statement “VibeSpace is open” is correct; “the latest source passes in this app” would not be.

**Next time:** record executable hash/build time, frontend served source fingerprint and profile before every native acceptance. Rebuild/restart affected Rust code once under the exclusive native/build lease. Reuse a running app for startup/use requests, but never promote it to proof of unbuilt changes. Receipt: `work/vibespace-start-SV31/start.json`. This is a new learning from the immediately preceding turn.

## 2. Working changes that should be preserved

- The actual OpenCode same-chat 10/10 native receipt, with its original route and source identity; it is a bounded pass, not all CLI modes.
- The native queue once-only lifecycle receipt and targeted kernel/authority tests; keep its usage gap visible rather than discarding the real queue progress.
- The SiYuan index and durable checkpoint work; fix the node-creation failure rather than rebuilding a second map system.
- The tightened RLM scorer's citation-equality/accepted-state checks and private-note exclusion; add semantic review rather than revert these checks.
- The pinned Ponytail vendor/generator/verifier work and focused tests; the savings target remains separate.
- The recent changed-files/token panel focused pass (51/51), dropdown native scroll evidence and clone-tool removal; still do their specified post-fix/native acceptance.
- Existing app-specific Context/RLM, terminal messaging, settings and native CLI controls. The user explicitly wants these retained.

Preserve original failure receipts, raw tool logs and artifact hashes. A diagnosis that says “this did not prove the whole feature” is not a reason to remove a working partial fix.

## 3. Faster execution protocol for the next implementation turn

### Step A — Prepare a falsifiable five-minute entry check

1. Read root `AGENTS.md`, live exact locks and latest ledger; record branch/HEAD, dirty relevant files and any active native/build owner. Check C:/D: headroom. Do not dump the entire enormous worktree or all logs; use exact `rg` targets, bounded reads and receipt paths.
2. Choose **one** user-visible outcome. Define its route/model/effort, isolated project/fixture, pass condition, negative control and evidence file **before** editing. Mark code-only, native, quality and usage claims separately.
3. Verify the current native app is the official Tauri process with PID/path/hash, WebView parent/profile/CDP and build fingerprint. If source under test is newer than its backend binary, coordinate one rebuild; preserve the other instance and other users' sessions.

### Step B — Prove one vertical transaction before scaling

1. Send one real request or perform one real app action. Trace the same ID from UI to CLI/SiYuan/Relay and back to persisted, reopened UI. For model work, corroborate selected CLI with process/protocol and exact model list; do not trust picker label or model self-description alone.
2. If it fails, classify the **first missing boundary** (catalog, dispatch, authority, native event, durable storage, projection or UI). Add one failing focused regression at that boundary. Repair only owned files. Re-run that focused test and the same native action; do not launch a 200-call run or full suite yet.
3. Verify one negative case for the same boundary: denied authority before read, missing data, cancellation, rejected approval, stale session, duplicate queue ack or bad citation as appropriate. This catches false passes early.

### Step C — Scale in dependency order

1. Stabilize both real CLI routes, modes, approvals and 10–20 back-and-forth turns. Ensure native file/shell tools remain native, app-specific tools remain available, and saved chat/tool/usage projections are correct.
2. Complete the SiYuan map and path/graph comparison. Then do one correct model-originated RLM operation and one recursive investigate; repair semantic scorer/answer key; only then run the 200-call sample and ten-question recall.
3. Run original matched game prompts on stable native dispatch, preserve original/retry/repaired arms and actually play the outputs. Complete Skills/questions/Relay with one real native vertical exchange each before broad matrices.
4. Measure Ponytail **last**, after functional behavior is stable, with a predeclared matched OFF/ON benchmark and whole-task usage provenance. Keep a failed 5% target visible.

### Step D — Freeze and finish once

1. Freeze relevant source/fixtures; record dirty file hashes, CLI/app binary, route, permissions and test data. Run focused checks already due and then the five required repository gates on the frozen state. A later relevant edit invalidates only its dependent evidence.
2. Run the final official native Playwright workflow, including the exact Codex Luna Max Plan/refine/implement/three steers/queue/gameplay path if the installed catalog truly supports it. Preserve actual failure states and external blockers.
3. Report a small matrix of **Passed / Failed / Blocked externally / Unrun**, with exact receipts and remaining work. Commit only attributable owned changes after inspecting the index, then release only own claims. Do not claim complete while required native or measurement proof is missing.

## 4. Rules for parallel work and speed

- A subagent is useful only with a bounded independent objective, exact files, a concrete test and a compact handoff. Follow the current user's authorization/limit; do not infer authorization from task size or keep helpers busy with redundant audits. The root integrates and also codes.
- C1 native UI, Vite/build state, shared runtime/router and private answer key are serial resources. One controller at a time. Other agents can make disjoint source/test progress, but their “ready” messages do not equal integration or native proof.
- Batch independent reads. Do not parallelize edits to shared files, app restarts, native interactions, commits or actions dependent on a previous result. Use logs with bounded summaries rather than giant tool outputs.
- Keep source changes small and preserve approved UI. Do not add new file/command/permission/queue systems when installed native CLIs or existing app bridges already provide them.
- Do not treat a 30% or later 40% usage target as a reason to omit required tests; also do not spend usage on repeated failed probes with unchanged inputs. The record does not provide a trustworthy exact percentage of account usage for the 20-hour interval.
- Reuse verified evidence when its inputs match. Repeat a test only for a changed dependency, contradiction, unfinished result or final required gate. Distinguish a one-time app-start check from source-current product acceptance.

## 5. Quick quality checklist before any future “done” claim

- [ ] Exact requested harness, model, effort, permission mode and source/build identity recorded; no silent fallback.
- [ ] Real native app/WebView and correct profile; current backend contains the change under test.
- [ ] One full UI→native→persisted→UI path passed, including a meaningful negative case.
- [ ] Tool/file/command ownership matches the selected CLI; no replacement VibeSpace clones.
- [ ] Map job reached Complete and graph/path comparison covers files **and** folders, not merely an index count.
- [ ] RLM denominator says direct vs model-originated vs recursive, and semantic answers survive wrong-answer controls.
- [ ] Original, retry and repaired artifacts have separate hashes, prompts, app status and gameplay scores.
- [ ] Token counts carry provenance; unavailable does not become zero; matched saving and quality are measured honestly.
- [ ] Required focused and final gates ran on the source actually shipped/tested; no interrupted compile is called pass.
- [ ] Remaining failures, external blockers and unrun checks are stated plainly; peer claims/processes and private data preserved.

The practical rule is simple: **prove the smallest real user path with a falsifiable oracle, then scale**. That would have surfaced the tool-boundary, live-control, scorer, catalog, map and measurement gaps earlier without sacrificing quality.
