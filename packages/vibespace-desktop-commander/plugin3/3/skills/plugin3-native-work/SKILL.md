---
name: plugin3-native-work
description: Use Plugin 3 for repository files, terminals, persistent Playwright sessions, and official native VibeSpace testing; diagnose selector, assertion, session, connector and host errors accurately.
---

# Plugin 3 operating guide

Read this guide once at the start of a Plugin 3 task. MCP exposes the same content through `plugin3_guide`, resource `plugin3://agent-guide`, and prompt `plugin3-operating-guide`. Initialization directs clients here. A host can ignore instructions or withhold the connector: this file cannot force loading, grant permissions, or override higher-priority rules.

## Live activity viewer: identify your work

At task startup, register your unique agent ID, descriptive name, task, the user's task prompt (exclude credentials), and actual model with the separate local viewer at `http://127.0.0.1:8094`. Write a small task-owned JSON file and invoke through @3's terminal tool:

```powershell
node %PLUGIN3_ROOT%/extensions/activity-viewer/report.mjs --file C:/absolute/task.json
```

Example: `{"agent":"unique-task-agent","name":"Diagnostics repair","task":"Repair and verify logging","prompt":"The actual task request","model":"observed model","state":"working","sessions":["your-own-session"],"pids":[]}`. Reuse your ID to report meaningful progress, blockers and completion; supply only session names and terminal PIDs you actually own. Never claim another agent's identity. Update this registration when acquiring your own terminal or browser session, so subsequent activity can be attributed. The viewer reads existing tool logs, results, jobs, edit receipts and terminal output; calls without an identity remain unassigned. It cannot reconstruct unrecorded prompts or model reasoning. If the viewer is unavailable, continue the authorized task; do not restart the plugin or interfere with active sessions to register. Viewer-only instructions: `%PLUGIN3_ROOT%/extensions/activity-viewer/README.md`.

## Work efficiently and keep going

Use the simplest correct implementation within the user's request. Diagnose a recoverable failure, fix its cause, verify the fix, and continue. If one independent test/build is blocked, record its exact limitation and continue useful authorized work. Do not abandon the entire task because one operation failed. Stop only when completed, explicitly stopped, or no independent permitted progress remains; identify what remains and why. Never fabricate a pass, an error, a permission, or a commit.

- For Playwright/UI QA, use the authorized native Playwright path first. After repeated, diagnosed blockers, use a bounded repeatable Playwright runner and/or the Luna testing bridge at `http://127.0.0.1:8771` for screenshots, diagnostics, and reports; never use either path to bypass an explicit host safety/permission denial.
- Luna is test/read-oriented by default and may create its own evidence artifacts. Do not delegate implementation/source edits to Luna unless the user explicitly authorizes Luna to implement; otherwise the parent agent owns implementation.

User authorization applies to the requested task, including ordinary native testing when requested. This guide is operating guidance, not blanket authorization for arbitrary actions. Preserve other agents' processes, changes, sessions and locks. Before repository writes, read its AGENTS.md, current live ownership and relevant coordination ledger, record branch/HEAD/upstream/integration state, and claim exact files. Follow ancestor subagent bootstrap rules; use subagents only when the user authorizes them for this task.

Commit your verified, task-owned source changes when the user/repository requires commits. Stage explicit paths; inspect staged diff and record the resulting SHA. Never commit unrelated work, credentials, browser profiles, private captures or generated caches. Do not create fake commits for read-only work or bypass a denied commit. Preserve evidence and state any uncommitted limitation. Run relevant regressions and required repository checks; a focused fix is not proof every other system is unaffected.

## Choose tools precisely

- Read focused pages with read_file/read_multiple_files and search; follow pagination/truncation indicators. Prefer direct reads over shell commands when sufficient.
- Use batch_edit for reviewed exact edits with hashes/counts; inspect partial commit receipts before retrying. Keep independent batches bounded.
- Reuse terminal PIDs and inspect output/exit status. A timeout does not mean the command did nothing; never blindly rerun it.
- Call browser_observe with `{"operation":"list"}` before assuming a named session exists. In shared-service mode, sessions belong to the broker and survive MCP reconnects. Broker restart loses live handles; inventing `vibespace-native` does not create it. Standalone compatibility mode remains process-local.
- browser_observe is actually read-only: list/status/snapshot and text, input_value, exact/contains assertions, wait. It rejects clicks, fills, keys, screenshots that write files, attachment, navigation and closure.
- browser_session retains explicit open/attach and interactions. Up to 32 ordered steps share one timeout and output budget. Reuse the session. No automatic click/submission replay. Open creates an isolated Edge browser, not the user's signed-in browser or native VibeSpace.

## Shared work engine: large repositories and cooperating chats

Use `health` to inspect the shared service and supported capabilities. Register a real root with `workspace_open`, inspect `workspace_status`, then use `query_repo` and `read_batch` for bounded source-grounded context. Reads check an open file handle before/after; range hashes are not whole-file hashes unless `complete` is true. Byte ranges that split UTF-8 are explicit errors; do not invent omitted text.

For broad staged changes, register a unique agent, claim exact paths with `lease_claim`, and call `edit_plan` with a local manifest containing `root`, `changes`, target `path`, staged absolute `source`, `expectedSha256` (null only for creation) and `sourceSha256`. `edit_plan`, `edit_apply` and `edit_rollback` start tracked background work and wait at most `wait_ms` (default 1 second). Poll `edit_status` with up to 25 seconds of bounded waiting until `planned`, `applied` or `rolled_back`; a pending state is not success or failure. Two workers maximum and one active edit per workspace; its lease cannot be released while active. Large operations have a 30-minute execution ceiling independent of the tool-call wait. The existing streaming preflight/journal engine supports (500 files, 1 GiB/file, 4 GiB combined staging/backup limit). `edit_status` preserves partial/uncertain results. Any interrupted/uncertain edit quarantines new shared edits and lease release in that workspace. Verify the former worker has stopped and reconcile actual journal/target hashes before an explicit repair; never clear state automatically. Read-only work and other workspaces remain available. `edit_rollback` refuses to overwrite later external changes. Leases coordinate participating clients; they do not sandbox legacy tools or external editors. Preserve the repository's own ownership protocol too.

Use `job_start` for noninteractive executable-plus-argument jobs, then `job_read`/`job_wait` for actual exit status and output. Four jobs may run concurrently. MCP disconnection does not cancel the broker's children. Logs are bounded and disclose truncation. Follow returned stdout/stderr byte cursors; non-UTF-8 output returns explicit base64 pages. `job_cancel` targets only children still owned by the service. Broker-crash jobs are marked interrupted/uncertain; never rerun them blindly. Existing terminals remain available for interactive work.

Every new mutating shared tool requires a unique `request_id`. Repeating the same ID and identical arguments returns its recorded result. Different arguments with that ID are rejected. An interrupted pending receipt is uncertain, not permission to replay. The state database has one OS-enforced owner and a bounded receipt capacity; do not delete state to hide or reset failed work.

For multiple agents, use `agent_register` with a unique ID, task and requested model, or `agent_start` to prepare a durable launch handoff including a prompt and parent identity. Three active agents maximum; recursive delegation is disabled. Both return an identity/mailbox, **not a running model**: agent_start explicitly reports awaiting_host_controller and launched:false. Launch the requested chat through an available authorized host browser controller, inspect the exact model/effort and @3 selection, then record the actual conversation URL/model with `agent_update`. If the host/controller cannot launch that model, report the unavailable launch capability accurately. No silent model substitution or paid API dependency.

Shared readable file: `%PLUGIN3_ROOT%/state/shared-v1/communication/AGENT-MESSAGES.jsonl` (or the `health.communication_file` path for a private service). Each new `agent_send` appends a flushed JSON message record; `agent_ack` appends an acknowledgement. Agents can read the file with authorized file tools and filter their `to` identity. Use the broker to write; do not overwrite or concurrently append by hand. Check `shared_file_written`: SQLite delivery and readable-file publication are reported separately. Historical pre-feature messages are not copied into this file. It does not wake agents or override a host refusal. Read the adjacent README.md for the file contract. Maximum 64 MiB; full/damaged history requires explicit preservation and repair, never automatic deletion.

Use `agent_send` to enqueue a bounded message, `agent_read`/`agent_wait` to receive it and `agent_ack` to acknowledge only fully read messages. These tools work across separate MCP connections sharing this installation. They do not wake an idle ChatGPT model or interrupt a running one. A parent with an authorized host browser controller starts a new turn only after observing that the target has stopped. Do not send monitoring nudges while it is thinking or running tools. Share task-owned diffs, hashes, file ranges and test receipts; treat peers' claims as evidence to verify. Release only your own leases and mark completed identities complete.

If a connected host has not refreshed the new tool catalog, the same shared APIs have a compatibility CLI through the already-authorized @3 terminal tool:

```powershell
node %PLUGIN3_ROOT%/scripts/p3.mjs health
node %PLUGIN3_ROOT%/scripts/p3.mjs agent_read --file C:/absolute/request.json
```

The JSON file contains the same arguments as the corresponding tool. This is a schema-discovery compatibility path, never a way to retry an explicitly denied operation. Do not treat a registry entry, local fixture or manually relayed text as proof of an autonomous browser launch or real cross-chat mailbox exchange.

Browser additions: assign a unique `owner` when opening/attaching and supply it on later calls; a different controller is rejected. Use `pages` to discover current indexes, `new_page`/`select_page` only for owned browsers, and `detach` to release an attached connection without closing the native app. Actions support `frame_selector`, `hover`, `check`, `uncheck`, `select_option`, `scroll_into_view` and read-only `count`. Attached native page navigation/closure/page switching stays disabled.


Direct shared-file helper (works immediately without restarting the shared broker):

```powershell
node %PLUGIN3_ROOT%/scripts/shared-chat.mjs send --file C:/absolute/message.json
node %PLUGIN3_ROOT%/scripts/shared-chat.mjs read --file C:/absolute/filter.json
```

message.json: `{"from":"agent-a","to":"agent-b","text":"Task update","request_id":"unique-task-message-1"}`. filter.json: `{"to":"agent-b","offset":0,"limit":20}`. Read without --file to see the first page for all recipients; follow next_offset. Writes use an exclusive lock, flush records, and deduplicate identical request IDs. A stale lock or incomplete final line requires explicit inspection; never remove another live writer's lock. Direct helper messages live in the shared file only; they are not imported into SQLite agent_read. Broker mirror publication applies after its next safe restart. Do not restart a broker while another controller owns a browser session.

## Select the native window before the first attachment

Never assume page 0 is the main app: it can be the dictation window (`?view=dictation`). Read-only `browser_observe` with `operation: "targets"` and the verified loopback `endpoint` returns target IDs, titles and URLs without attaching. Verify the main window against the current native process/profile and exclusive ownership. On a broker running the target-selection upgrade, attach once with that exact `target_id`; multiple windows without an explicit selection return `PAGE_SELECTION_REQUIRED`, and an absent target returns `PAGE_NOT_FOUND` without fallback. `target_id` and `page_index` are mutually exclusive. CDP inventory order is not a Playwright page index.

The target-selection upgrade requires a freshly started broker and refreshed MCP schemas. Do not restart a live broker while another agent owns its sessions. With an older live broker, this read-only discovery helper is available immediately and does not attach, detach, switch, or control any page:

```powershell
node %PLUGIN3_ROOT%/scripts/native-targets.mjs http://127.0.0.1:VERIFIED_PORT
```

If a host says it could not determine the safety status of a request, record it as a **host safety-review refusal**, not as a failed Playwright connection. Preserve successful earlier actions. Do not replay the denied attach/detach/main-window control through a shell, another connector, another session or renamed operation. Continue independent permitted work. The screenshot alone does not identify why the host refused; a skill cannot grant an exception. A future first attachment with explicit identity is a technical improvement, not a promise of host approval. Existing denied main-window control remains unverified until permitted by the host.

## Native VibeSpace verification

Repository: `%VIBESPACE_ROOT%`. Test the actual official Tauri desktop app through Playwright attached to its WebView. A standalone browser, headless copy, Vite preview, test fixture or mocked DOM is not native acceptance. Plugin fixture tests remain useful code checks only. Do not use Computer Use for VibeSpace QA.

Existing launchers (verify branch, process ownership and availability before use):

| Instance | Exact launcher | Cargo cache | Profile / configured CDP |
|---|---|---|---|
| C | `%VIBESPACE_ROOT%/work/dual-live-20260912/start-c.ps1` | `%VIBESPACE_ROOT%/app/src-tauri/target` | `%VIBESPACE_ROOT%/work/dual-live-20260912/profile-c`; 9251 |
| C2 | `%VIBESPACE_ROOT%/work/dual-live-20260912/start-c2.ps1` | `%VIBESPACE_ROOT%/work/dual-live-20260912/target-c2` | `%VIBESPACE_ROOT%/work/dual-live-20260912/profile-c2`; 9252 |

Both launchers run `npm run tauri:dev` from the repository with isolated Cargo target/profile settings. Shared Vite cache: `%VIBESPACE_ROOT%/work/dual-live-20260912/vite-cache`. C2's `tauri-c2.json` expects the shared Vite dev server already available; do not duplicate or restart another owner's server. These paths describe configuration, not proof both instances are running or binaries current. Reuse the assigned existing instance. If absent, start the appropriate official native launcher under the repository's ownership rules. Use hidden launcher terminals; do not force a competing window/process.

Before attachment, verify current jarvis.exe executable/PID, child WebView/profile, loopback CDP port and intended main page. Never assume a saved PID, page index, title or port remains correct. Record native identity and timestamp in test evidence. The historic main page was index 1 on 9251; discover it again. Attached sessions cannot be navigated or closed with the integrated interface. Operate only your assigned UI transaction; pending provider turns are not permission to select/type in a shared main window.

For each changed behavior, verify the relevant real native input and resulting output. Confirm the loaded binary contains native changes before claiming runtime success; cargo check does not update a running binary. New-chat testing should create one clearly named test chat, submit only an authorized prompt, observe the actual response, and retain evidence without touching another chat. A successful create/send stays successful even if a later assertion fails. Record each operation separately.

## Correct locator and assertion examples

```json
{"session":"returned-session-id","operation":"actions","actions":[{"type":"click","locator":{"role":"button","name":"Create chat","exact":true}}]}
```

Structured locators accept one strategy: role/name/exact, label/exact, text/exact, testId, or css. Do not also supply selector. Never append `[exact=true]` to a raw role selector; `exact` belongs to getByRole options. Read the snapshot to find the actual accessible name before acting. Keep raw selector support for existing valid callers.

```json
{"session":"returned-session-id","operation":"actions","actions":[{"type":"assert_text_contains","locator":{"role":"complementary","name":"Navigation","exact":true},"value":"Terminals"}]}
```

assert_text and assert_value compare the entire value exactly. assert_text_contains checks a substring. A whole navigation panel is not exactly equal to one button label. Do not weaken assertions to hide defects: choose the intended element/match semantics. Mismatches return bounded actual/expected diagnostics and `failedActionIndex` (zero-based). `completed` and `results` identify successful steps. Inspect state after partial failure; retry only necessary unfinished work, never replay a successful send.

## Diagnose the actual layer

| Evidence | Meaning and next step |
|---|---|
| INVALID_ARGUMENT / invalid selector / `[exact=true]` | Fix the call against the advertised schema. No claim of a ChatGPT block. |
| ASSERTION_MISMATCH | Inspect expected/actual and target; preserve previous successful actions. Fix the selector, expectation, or real app bug based on evidence. |
| TIMEOUT / LOCATOR_ERROR | Inspect fresh page state, ambiguity, selector and deadline; don't repeatedly click or lengthen every timeout. |
| SESSION_NOT_FOUND / BROWSER_DISCONNECTED / PAGE_CLOSED | List sessions; verify process and page identity. Establish an explicit session only when appropriate; no automatic action replay. |
| Windows os error 32 / SiYuan-Kernel.exe file lock | Blocks the specific file replacement/build. Preserve the running app; use an already-approved separate cache or continue independent UI/source checks. Don't kill unrelated processes. |
| `FORBIDDEN: This conversation does not support developer MCPs` | Conversation-level connector rejection before tool execution. Not a selector or VibeSpace defect. Verify supported connector availability with the host; a plugin file cannot enable this conversation. Continue independent permitted work where available. |
| Explicit OpenAI safety/permission rejection | Quote exact error, exact operation/context and any provided request ID. Do not repeat the denied action through a different tool, command or chat. Continue independent authorized work. Do not generalize it into a permanent ban on all Playwright operations. |
| Discovery returns unrelated schemas | Tools were not exposed in that turn. Do not claim plugin execution occurred or infer an outage/uninstall. Select the correct existing connector in a supported host; unchanged permissions are not established by a healthy local endpoint. |

A failed Playwright action is not proof Playwright is blocked. A historical unrelated denial is not proof the current operation is denied. Conversely a previous successful click does not erase a subsequent explicit denial. Scope evidence to exact operation, session, timestamp and host. Do not relabel a safety denial as a transport error or use direct tools to reproduce the same denied effect. Different independent allowed work may continue.

@2's installed companion at `%PLUGIN2_ROOT%/extensions/codex-kit/browser.mjs` excludes native attachment; its isolated Edge session is not a VibeSpace substitute. Do not strip its guards. Official Playwright Local can be used for ordinary browser work if exposed and authorized; native support must be verified separately. Keep @2 unchanged during @3 maintenance.

## Honest acceptance and performance

Measure cold attachment separately from warm calls; keep sessions and bounded snapshots to reduce overhead. Separate model/backend/tool latency, React commit latency and visible UI latency. Report sample count, median/p95, test environment, failures and truncation. Do not call ten trials >99% reliability or a render-count test sub-10-ms native latency. Use frozen answer keys for RLM acceptance; never overwrite evidence generators' source artifacts just to rerun verification. No claim that this guide makes the model obey perfectly, tools instant, ChatGPT restrictions disappear, or arbitrary regressions impossible.
