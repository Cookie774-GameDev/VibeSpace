# VibeSpace OpenCode Tool Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Do not use subagents for this PR31 goal.

**Goal:** Give OpenCode a narrow authenticated semantic path to VibeSpace
features while preserving VibeSpace approval authority.

**Architecture:** A generated OpenCode plugin calls a loopback-only native
gateway with an ephemeral token. Native code validates and relays a typed
request to one renderer host, which dispatches fixed bounded handlers.
OpenCode permission events render through the existing permission card and
reply to the exact OpenCode approval.

**Tech Stack:** Rust 1.78, Tauri 2 events/commands, TypeScript, React, Vitest,
OpenCode 1.18 custom plugin tools.

## Global Constraints

- No generic Tauri/native invoke tool or model-controlled native command name.
- Bind only `127.0.0.1`; authenticate every request with a fresh process token.
- Bound request/response bodies, strings, arrays, concurrency, and timeouts.
- Ask mode has no mutation tools; Plan mode is read-only; Agent mode remains
  subject to both OpenCode and VibeSpace permissions.
- Preserve all unrelated dirty and untracked work.
- Do not use subagents.

---

### Task 1: Native authenticated relay

**Files:**
- Create: `app/src-tauri/src/harness/tool_gateway.rs`
- Modify: `app/src-tauri/src/harness/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `ToolGatewayState`, `start_tool_gateway_server`,
  `tool_gateway_respond`, and `ToolGatewayEndpoint { url, token }`.
- Emits: `vibespace://tool-gateway/request`.

- [ ] **Step 1: Write failing Rust tests**

Add tests for known-tool validation, unknown/generic invoke rejection, bearer
authentication, loopback endpoint validation, duplicate request IDs, bounded
body/result sizes, and one response per request.

- [ ] **Step 2: Verify RED**

Run:
`cargo test --no-default-features --lib harness::tool_gateway::tests -- --nocapture`

Expected: compile failure because `harness::tool_gateway` does not exist.

- [ ] **Step 3: Implement the minimal relay**

Use a loopback `TcpListener`, a 64-character NanoID bearer token, a bounded
HTTP/1.1 POST parser, a fixed `BTreeSet` catalog, a pending
`SyncSender<ToolGatewayResponse>` map, a 30-second timeout, and response
redaction. Register state, startup, and response command only on the ordinary
production builder.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 Rust command plus:
`cargo test --no-default-features --lib ordinary_builder_command_authority`

- [ ] **Step 5: Commit**

Commit message: `feat(harness): add authenticated tool relay`

### Task 2: Generated OpenCode plugin and restrictive permissions

**Files:**
- Modify: `app/src-tauri/src/harness/server.rs`
- Test: inline `server.rs` tests

**Interfaces:**
- Consumes: `ToolGatewayState::endpoint()`.
- Produces: `ServerLaunchSpec.tool_gateway_environment` and generated
  `config/plugins/vibespace-tool-gateway.ts`.

- [ ] **Step 1: Write failing config tests**

Assert the generated plugin contains every exact semantic tool key, only the
fixed `/v1/tool` request shape, bounded Zod schemas, session/directory context,
and no `invoke`, shell, dynamic tool name, or secret literal. Assert config
denies built-in edit/bash/task/external-directory authority and uses allow/ask
rules for read/mutation semantic tools.

- [ ] **Step 2: Verify RED**

Run:
`cargo test --no-default-features --lib harness::server::tests::generated_tool_gateway -- --nocapture`

Expected: FAIL because no plugin or permission config exists.

- [ ] **Step 3: Generate plugin and environment**

Write one private plugin with quoted dotted tool keys and a shared `call`
function. Pass URL/token only through child environment. Include plugin
directory creation in the same atomic scoped-config preparation.

- [ ] **Step 4: Verify GREEN**

Run all native harness tests, `cargo fmt --check`, and
`cargo check --no-default-features --lib`.

- [ ] **Step 5: Commit**

Commit message: `feat(harness): generate semantic OpenCode tools`

### Task 3: Frontend protocol and semantic dispatcher

**Files:**
- Create: `app/src/lib/harness/toolGatewayProtocol.ts`
- Create: `app/src/lib/harness/toolGatewayProtocol.test.ts`
- Create: `app/src/lib/harness/toolGatewayRuntime.ts`
- Create: `app/src/lib/harness/toolGatewayRuntime.test.ts`

**Interfaces:**
- Produces:
  `parseToolGatewayRequest(value): ToolGatewayRequest`,
  `createToolGatewayRuntime(deps).execute(request)`,
  and `ToolGatewayResponse`.

- [ ] **Step 1: Write failing protocol tests**

Cover plain-object enforcement, protocol version, safe IDs, exact catalog,
absolute project directory, per-field bounds, pagination limits, unknown
fields, prototype pollution, and response bounding.

- [ ] **Step 2: Verify RED**

Run:
`npm test -- --run src/lib/harness/toolGatewayProtocol.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement parser and fixed dispatcher**

Define one schema per tool. Dispatch with a static record keyed by the catalog;
never accept a command identifier in arguments. Return
`{ requestId, ok, code, message, data? }` with bounded sanitized data.

- [ ] **Step 4: Add RED/GREEN domain tests**

Using injected production-shaped dependencies, cover terminal list/open/focus/
spawn/write/read/schedule, context list/read/attach/update, profile read/update,
learning read/update, and app navigate/state. Mutations must receive a
permission-confirmed request; reads must not mutate. Then add command, skills,
plugins, tasks, and schedule handlers using the same static contract.

- [ ] **Step 5: Commit**

Commit message: `feat(harness): dispatch semantic VibeSpace tools`

### Task 4: Renderer relay host

**Files:**
- Create: `app/src/lib/harness/ToolGatewayHost.tsx`
- Create: `app/src/lib/harness/ToolGatewayHost.test.tsx`
- Modify: `app/src/App.tsx`
- Create: `app/src/App.toolGateway.test.tsx`

**Interfaces:**
- Consumes: Tauri event `vibespace://tool-gateway/request`.
- Calls: `tool_gateway_respond({ response })`.

- [ ] **Step 1: Write failing host tests**

Assert one listener, strict parsing, invalid-request response when a safe
request ID can be recovered, per-session serialization, concurrent independent
sessions, unmount cleanup, and exactly one native response.

- [ ] **Step 2: Verify RED**

Run the two host/App test files. Expected: missing component failure.

- [ ] **Step 3: Implement and mount host**

Follow `TerminalCliRuntimeHost` queue/cleanup structure, but use session ID as
the queue key and the new semantic runtime. Mount once in the ordinary app
shell whenever the renderer is active.

- [ ] **Step 4: Verify GREEN**

Run host/App tests and app typecheck.

- [ ] **Step 5: Commit**

Commit message: `feat(harness): host tool gateway in renderer`

### Task 5: OpenCode permission bridge

**Files:**
- Modify: `app/src/lib/ai/openCodeRunAgent.ts`
- Modify: `app/src/lib/ai/openCodeRunAgent.test.ts`
- Modify: `app/src/lib/ai/router.ts`
- Modify: `app/src/lib/ai/router.test.ts`
- Modify: `app/src/lib/ai/runtime.ts`
- Modify: `app/src/lib/ai/runtime.test.ts`
- Modify: `app/src/features/jarvis-interaction/types.ts`
- Modify: `app/src/features/jarvis-interaction/PermissionRequestCard.tsx`
- Modify: `app/src/features/jarvis-interaction/PermissionRequestCard.test.tsx`

**Interfaces:**
- Adds: `RunAgentRequest.onApprovalRequested`.
- Adds to permission request: exact harness `{ sessionId, approvalId }`.

- [ ] **Step 1: Write failing adapter/router tests**

Assert `approval.requested` calls the callback with exact identity, does not
finish the turn, and never auto-approves. Verify action/plan/ask tool policy is
forwarded without fallback.

- [ ] **Step 2: Verify RED**

Run adapter/router tests. Expected: callback and tool-policy assertions fail.

- [ ] **Step 3: Implement event callback and runtime presentation**

Append a transport-backed `permission_request` part to the live placeholder.
Keep it during streaming/final writes and reconcile its status from a bounded
in-memory bridge.

- [ ] **Step 4: Write failing card tests and implement replies**

Verify once/always/reject map to `openCodeHarness.respondToApproval` with exact
session and approval IDs. Edited requests reject first and then send the
narrowed VibeSpace instruction. Non-harness permission cards retain existing
behavior.

- [ ] **Step 5: Verify GREEN and commit**

Run adapter, router, runtime, and permission-card suites.
Commit message: `feat(harness): bridge OpenCode approvals`

### Task 6: Phase verification and release lock

**Files:**
- Modify: `C:\Users\viper\VibeSpace\AGENT_COORDINATION.md`
- Modify: `.agent-coordination.lock/owner.txt`

- [ ] **Step 1: Run focused suites**

Run all new frontend tests, router/runtime tests, terminal/context/profile/
learning tests selected by the dispatcher, and native harness/tool gateway
tests.

- [ ] **Step 2: Run static/security checks**

Run typecheck, production build, Prettier check, `git diff --check`,
`cargo fmt --check`, `cargo check --no-default-features --lib`, credential
scan, fixed-catalog scan, and ordinary-builder authority.

- [ ] **Step 3: Run safe live smoke**

Start the owned private OpenCode server and call one read-only
`app.getState`/`terminal.list` tool. Verify exact tool identity, authenticated
round trip, bounded structured output, and zero raw Tauri authority. Do not run
a mutation without explicit user approval.

- [ ] **Step 4: Record evidence and release**

Update central coordination with commits/tests/smoke, mark the owner record
`RELEASED`, and commit only the release record.
