# VibeSpace Chat UI Stability + <10 ms Streaming Master Plan

**Task:** VS-CHAT-UI-PLAN-20260918-C1
**Date:** 2026-09-18
**Branch observed:** `integration/UnifiedChungus-final`
**HEAD observed while planning:** `e75b8f077f3abcd00299936c2e7e554b7033332b`
**Scope:** implementation plan only; no production source changes in this planning pass
**Primary objective:** remove multi-second / missing chat UI updates and state-divergence failures while preserving or improving every existing chat feature, security check, model-quality control, tool receipt, MCP/RLM/SiYuan capability, recovery path, and no-model Jarvis command.

---

## 1. Definition of done

This work is done only when all of the following are true in the **official native Tauri app**:

1. A provider text event received by the renderer becomes visible in the active chat in **<= 10 ms** in the controlled native acceptance benchmark.
2. Stretch goal: P50 <= 5 ms, P95 <= 8 ms, maximum <= 10 ms for the fixed benchmark set.
3. No provider turn can simultaneously show contradictory states such as:
   - provider error + `Running`;
   - provider error + `Jarvis is thinking…`;
   - completed answer + live spinner;
   - cancelled turn + pending tool cards;
   - failed turn + active approval ownership.
4. Punctuationless public progress is not withheld.
5. Long streaming responses do not degrade superlinearly because the public-stream gate reparses the whole accumulated response.
6. Every safe provider error is surfaced even if VibeSpace has never seen its wording before.
7. Tool calls remain complete and ordered: text, reasoning, tool start, bounded public tool details, tool output, completion/failure, edits/diffs, questions, approvals, native child-task activity, and final results.
8. MCP `list` / `run`, plugins, terminals, file tools, task/subagent activity, questions, and approvals keep their current authority and permission checks.
9. RLM direct/retrieval/deep routing and SiYuan Context Map provenance continue to work with no reduction in answer quality or evidence integrity.
10. Instant Commands and local Jarvis/slash commands that do not require an LLM continue to execute **without model dispatch**.
11. Chat switching, hidden/background chats, cancellation, refresh, app restart, provider disconnect, and interrupted turns recover to one consistent state.
12. No user chat, peer work, unrelated dirty file, credential, auth setting, provider setting, billing path, voice path, or installer behavior is altered by the migration.
13. Final required repo checks pass, and native Playwright acceptance passes against the real `jarvis.exe` WebView.

---

## 2. Verified current-state findings

These are verified inputs to the implementation, not assumptions.

### 2.1 Too many representations of one turn

A single model turn currently fans out into several independently updated representations:

- provider/native stream;
- `ProviderEvent`;
- public stream projection;
- streaming preview state;
- chat activity state;
- agent run state;
- transient chat run state;
- canonical Jarvis run data;
- durable message parts;
- diagnostics;
- AgenticConsole derived state;
- activity ledger projections.

The same logical fact (for example, “the turn failed”) can therefore be correct in one surface and stale in another.

### 2.2 Native contradiction reproduced

Previous native Playwright audit reproduced a failed chat that simultaneously showed:

- a durable provider error;
- session status `Running`;
- `Jarvis is thinking…`.

The error reached the transcript, but terminal state did not converge across every UI state source.

### 2.3 Streaming gate caused multi-second withholding

The A8F1 audit measured **6.264 seconds** between safe public text arriving and becoming visible. Punctuationless progress was being withheld by the public-stream gate.

### 2.4 Current candidate streaming parser can become superlinear

The current gate design can re-examine the entire accumulated response for every small delta. A direct stress check showed cumulative growth to roughly:

- 3k chars: 17.5 ms;
- 12k chars: 40.8 ms;
- 24k chars: 124 ms;
- 48k chars: 523 ms.

The new design must process only the new delta plus a small bounded carry/tail.

### 2.5 React commit itself is close to target

The prior native audit measured preview publication -> React commit at approximately 8.5 ms median and 12.3 ms maximum. The biggest gains therefore come from removing pre-publication withholding and duplicate processing, then reducing React/store fan-out.

### 2.6 Provider errors already have a good generic public envelope

`ProviderErrorDetails` already supports:

- message;
- code;
- provider/model/connection identity;
- retryability;
- retry-after;
- reset time;
- request/run identity.

The missing work is preserving the richest safe error from the earliest failure boundary and atomically terminating the turn.

### 2.7 No-model Jarvis command lane is real and must be protected

`InstantCommandEntryBoundary` classifies input before model use. A matched command executes locally and only unmatched input may fall through to `sendToModel`.

Chat also has local slash/utility paths, including examples such as:

- `/rlm on|off|status|refresh`;
- permission/status responses;
- usage cards;
- attachment clearing;
- local interaction-mode changes;
- scheduled terminal actions.

The redesign must never route these through an LLM merely to simplify the architecture.

### 2.8 Current official native app was verified during planning

The planning audit verified:

- repo-native `jarvis.exe`;
- its WebView2 child;
- profile-c;
- loopback CDP 9251;
- the main Tauri page;
- the current Context route showing the SiYuan Context Map flow.

No UI mutation or provider submission was required for this planning verification.

---

# 3. Non-negotiable invariants

These rules define the architecture. An implementation that violates one is not acceptable even if it is faster.

## 3.1 Identity and ordering

Every provider turn has one immutable identity:

```ts
type TurnIdentity = {
  accountId: string;
  workspaceId: string;
  projectId?: string;
  chatId: string;
  runId: string;
  requestId: string;
  attempt: number;
};
```

Every canonical event carries the same identity plus a strictly increasing request-local sequence.

Stale events from an old attempt, cancelled generation, replaced provider session, or different chat are rejected before reducer mutation.

## 3.2 One active truth for one turn

There is exactly one authoritative live turn state.

Components may derive selectors from it, but they may not maintain independent “is running / thinking / failed” truth.

## 3.3 Terminal states are monotonic

Once a turn reaches:

- completed;
- failed;
- cancelled;
- interrupted;

it cannot return to running.

Late provider events are diagnostic-only and cannot reopen the turn.

## 3.4 Public / private separation stays intact

Public text, hidden reasoning, tool authority, raw provider payloads, credentials, prompts, and filesystem metadata retain their existing privacy boundaries.

The fast path may become simpler, but it must not bypass redaction or public-stream classification.

## 3.5 Tool authority stays outside the model

The model can request a tool. It cannot grant itself authority.

Session/account/workspace binding, read-vs-mutation classification, permission approval, cancellation ownership, and MCP/tool scope checks stay in the Tool Gateway.

## 3.6 Persistence never blocks first paint

Durable transcript persistence, canonical-run persistence, diagnostic formatting, analytics, and debug-log export are subscribers to the canonical turn events.

They must not sit between renderer event receipt and DOM visibility.

## 3.7 Local commands remain model-free

Matched Instant Commands and local slash commands terminate in the local command lane.

They do not create provider turns just to produce UI output.

---

# 4. Target architecture

## 4.1 High-level pipeline

```text
User input
  |
  +--> Local Command Classifier
  |      |
  |      +--> matched local command --> local authority --> durable local receipt/UI
  |      |
  |      +--> unmatched
  |
  +--> TurnController.start()
         |
         +--> immutable TurnPlan
         |      - model/provider/backend identity
         |      - access/interaction policy
         |      - ContextPlan
         |      - tool capability plan
         |      - attachments
         |      - cancellation authority
         |
         +--> provider/OpenCode/Codex
                |
                +--> canonical TurnEvent
                       |
                       +--> TurnReducer / TurnStore --> UI
                       |
                       +--> async persistence
                       +--> async diagnostics
                       +--> tool executor / ToolGateway
```

## 4.2 Latency-critical stream path

Only these steps may be on the renderer text-delta critical path:

```text
native/provider event received
    -> minimal provider normalization
    -> incremental public-stream guard
    -> TurnReducer(delta)
    -> store notification
    -> React commit
```

Everything else is off-path.

## 4.3 Canonical event model

Introduce one internal event union. Exact names can vary, but the semantics must remain stable.

```ts
type TurnEvent =
  | { type: 'turn.accepted'; identity: TurnIdentity; at: number }
  | { type: 'turn.context_planned'; plan: ContextPlan }
  | { type: 'provider.bound'; providerId: string; modelId: string; connectionId?: string; sessionId?: string }
  | { type: 'reasoning.delta'; text: string; mode?: 'append' | 'replace' }
  | { type: 'text.delta'; streamPartId: string; text: string }
  | { type: 'text.replace'; streamPartId: string; text: string }
  | { type: 'tool.started'; callId: string; tool: string; publicDetails?: PublicToolDetails }
  | { type: 'tool.updated'; callId: string; publicDetails?: PublicToolDetails }
  | { type: 'tool.completed'; callId: string; publicDetails?: PublicToolDetails }
  | { type: 'tool.failed'; callId: string; error?: string; publicDetails?: PublicToolDetails }
  | { type: 'approval.requested'; approval: SafeApproval }
  | { type: 'approval.resolved'; approvalId: string; decision: string }
  | { type: 'question.requested'; question: SafeQuestion }
  | { type: 'question.resolved'; questionId: string }
  | { type: 'usage.updated'; usage: UsageSnapshot }
  | { type: 'provider.warning'; message: string }
  | { type: 'provider.error'; error: TurnError }
  | { type: 'turn.completed'; finishReason?: string }
  | { type: 'turn.cancelled' }
  | { type: 'turn.interrupted'; reason: string };
```

Adapters may keep provider-specific parsing internally, but they must converge on this event model before UI state.

## 4.4 Canonical TurnState

```ts
type TurnState = {
  identity: TurnIdentity;
  revision: number;
  status: 'preparing' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

  provider?: {
    connectionId?: string;
    providerId: string;
    modelId: string;
    sessionId?: string;
  };

  contextPlan?: ContextPlan;

  textOrder: string[];
  textByPart: Record<string, string>;

  reasoning?: string;

  toolOrder: string[];
  toolsById: Record<string, CanonicalToolState>;

  approvalsById: Record<string, SafeApprovalState>;
  questionsById: Record<string, SafeQuestionState>;

  usage?: UsageSnapshot;
  error?: TurnError;

  acceptedAt: number;
  firstProviderEventAt?: number;
  firstPublicTextAt?: number;
  terminalAt?: number;
};
```

The header, thinking indicator, streaming preview, tool cards, activity ledger, retry affordance, and terminal state all derive from this state.

---

# 5. Migration strategy: do not big-bang delete the old chat system

The safest implementation is a strangler migration with parity checks.

The user has authorized a rewrite if useful, but a destructive “delete old system and hope” approach is not acceptable because the old system contains mature edge-case behavior around tools, approvals, context, commands, persistence, and recovery.

## Stage A — shadow only

Create the new event/reducer/store infrastructure but leave the existing UI authoritative.

For every provider event:

1. feed the legacy path;
2. feed the new TurnReducer;
3. record metadata-only parity diagnostics:
   - status;
   - visible text length/hash;
   - ordered tool lifecycle;
   - terminal state;
   - provider/model identity.

Never log private content to parity diagnostics.

## Stage B — text preview cutover

Move only live public text rendering to TurnStore.

Legacy durable messages remain unchanged.

If parity fails, one development switch can restore the legacy preview.

## Stage C — tools + errors cutover

Move tool chronology and provider errors to canonical events/store.

Keep legacy adapters as compatibility producers until every provider passes.

## Stage D — session/header/status cutover

Make AgenticConsole header, spinner, retry/cancel UI, and activity selectors use the same TurnState terminal status.

This is the phase that removes the reproduced “Provider Error + Running + Thinking” contradiction.

## Stage E — durable checkpoint/recovery cutover

Persist canonical turn checkpoints asynchronously and prove refresh/restart recovery.

## Stage F — retire redundant legacy state

Only after native parity and recovery pass:

- reduce `streamingPreviewStore` to a compatibility shim or remove it;
- reduce `chatRunState` to a compatibility event adapter or remove it;
- stop maintaining duplicate live run status in activity state;
- remove duplicate public chronology reconstruction where the canonical journal already owns it.

Do not remove a legacy path until its replacement has native evidence.

---

# 6. Phase-by-phase implementation plan

## Phase 0 — freeze baseline and create acceptance fixtures

### Goals

- capture current branch/HEAD/dirty paths;
- preserve all inherited edits;
- create task-owned evidence only;
- establish reproducible failing cases before source edits.

### Required evidence

1. Official native process identity:
   - `jarvis.exe`;
   - WebView child;
   - profile;
   - CDP target.
2. Existing A8F1 latency evidence.
3. Native failing-state fixture:
   - provider error present;
   - stale/contradictory live status if reproducible.
4. Focused current tests for:
   - streaming gate/projection/store;
   - provider errors;
   - OpenCode/Codex events;
   - tool activity;
   - RLM/context;
   - Instant Commands.

### No-feature-loss inventory

Before edits, write a machine-readable list of currently rendered message/tool part kinds and provider event types. Final acceptance compares against this inventory.

---

## Phase 1 — introduce TurnEvent + TurnReducer in shadow mode

### New code

Prefer a small runtime folder rather than spreading new state through old files, for example:

```text
app/src/features/chat/runtime/turn/
  turnTypes.ts
  turnReducer.ts
  turnStore.ts
  turnSelectors.ts
  turnController.ts
```

Keep the file count small; only split when a module has a separate responsibility.

### Reducer rules

- event identity must match;
- sequence/revision must advance monotonically;
- duplicate event id is idempotent;
- terminal state cannot reopen;
- text replacement is scoped by `streamPartId`;
- tool state transitions are validated;
- failed/cancelled turn terminalizes all pending tools;
- terminal event clears visible thinking state;
- approval/question ownership cannot survive a terminal turn.

### Tests

Table-driven reducer tests for every event transition, stale event, duplicate event, cancellation race, and terminal idempotency.

---

## Phase 2 — build the <=10 ms streaming path

### 2.1 Replace whole-buffer public parsing with an incremental scanner

Current behavior can become O(total response size) per delta.

New scanner state should contain only what is required to classify boundaries across chunks, for example:

```ts
type PublicStreamGuardState = {
  mode: 'public' | 'fence' | 'private-control';
  fenceType?: string;
  tail: string; // small bounded carry, e.g. <=128 chars
  emittedChars: number;
};
```

For each delta:

1. inspect previous bounded tail + new delta;
2. emit newly safe public spans;
3. retain only the bounded suffix necessary to recognize split fence/control tokens.

Never rescan the already-classified response.

### 2.2 Structural sharing

Do not clone/freeze every old segment on every token.

Use:

- stable part ids;
- immutable replacement only for the changed part;
- stable tool objects when unchanged;
- O(1) lookup by current chat/turn.

### 2.3 Direct active-turn index

The store must provide direct selectors:

```ts
getActiveTurn(chatId)
getTurn(requestId)
subscribeChat(chatId)
```

No scanning all active previews to find one chat.

### 2.4 Keep persistence out of first paint

The reducer updates synchronously.

Persistence receives the event after state publication.

### Performance unit gate

Add a deterministic benchmark that processes at least:

- 1,000 tiny text deltas;
- 4,000 tiny text deltas;
- 50k+ public text;
- split code/action fences across chunk boundaries.

The scanner must show approximately linear scaling.

---

## Phase 3 — Universal Provider Failure Collector

### Goal

Show every safe provider error automatically without hardcoding every phrase.

### Architecture

All failure sources feed one collector:

```text
HTTP response/error body
CLI stderr
native transport error
SSE/provider error event
session.error
session.status.error
retry/rate-limit headers
provider metadata
    -> normalizeProviderFailure()
    -> TurnError
```

### TurnError

```ts
type TurnError = {
  message: string;
  code?: string;
  providerId?: string;
  modelId?: string;
  connectionId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  resetAt?: number;
  requestId: string;
  runId: string;
  source: 'http' | 'cli' | 'native' | 'sse' | 'session' | 'runtime';
};
```

### Richest-evidence rule

A later generic error such as `OpenCode session failed.` must never overwrite an earlier richer safe error.

Rank candidate evidence using fields, not phrase lists:

1. safe explicit provider message + provider code/metadata;
2. safe explicit provider message;
3. transport/status code and retry metadata;
4. generic session fallback.

Phrase classification is allowed only for UX actions such as “Retry”, “Change model”, or “Sign in”. It is not required for visibility.

### Security

Retain existing:

- bounded message length;
- secret redaction;
- control-character filtering;
- no raw headers/body rendering;
- route identity authority.

### Atomic terminal reducer

`provider.error` performs one reducer transaction that:

- sets status failed;
- stores TurnError;
- seals text stream;
- stops thinking;
- marks pending tools interrupted/failed as truthful;
- releases approvals/questions;
- releases composer/run ownership;
- prevents later normal events from reopening the turn.

---

## Phase 4 — one canonical tool journal

### Goal

Every tool call has one request-local identity and one lifecycle journal.

### Canonical tool state

```ts
type CanonicalToolState = {
  callId: string;
  name: string;
  status: 'started' | 'running' | 'completed' | 'failed' | 'interrupted';
  fileLabel?: string;
  nativeTask?: NativeTaskActivity;
  details?: PublicToolDetails;
  startedAt: number;
  updatedAt: number;
};
```

### Provider adapters

OpenCode and Codex adapters continue parsing their native protocols but emit the same canonical tool events.

### UI

These all select from the same tool journal:

- live tool card;
- Agentic activity ledger;
- final durable tool_call/tool_result;
- native child-task status;
- file diff/result detail;
- tool timing diagnostics.

Do not rebuild a second chronology from persisted provider snapshots unless recovery requires it.

### Recovery snapshots

Provider public-timeline snapshots become reconciliation input, not a second live truth.

They may repair missing events by revision but cannot reorder or duplicate already accepted tool events.

---

## Phase 5 — preserve Tool Gateway / MCP authority and simplify provider bridges

### Keep unchanged semantically

- session authority;
- account/workspace/project scope;
- cancellation signal ownership;
- read vs mutation classification;
- approval requirements;
- MCP connection/tool validation;
- result bounds and redaction.

### Target flow

```text
provider tool request
 -> canonical ToolRequest
 -> ToolGateway
 -> MCP / plugin / terminal / file / app authority
 -> canonical ToolResult
 -> TurnEvent tool update
```

OpenCode and Codex can still have protocol-specific tool registration, but they should not each maintain a separate business-logic implementation of MCP/RLM authority.

### MCP native matrix

Verify:

- `mcp.list`;
- `mcp.run` read-only;
- permission-denied mutation;
- disconnected MCP;
- unknown MCP/tool;
- schema mismatch;
- cancellation during MCP invocation;
- restart/reconnect;
- bounded/redacted failure;
- no duplicate invocation after retry/recovery.

---

## Phase 6 — calculate ContextPlan once per turn

### Goal

Preserve RLM quality while avoiding repeated routing decisions.

### ContextPlan

At accepted turn creation, compute an immutable plan:

```ts
type ContextPlan = {
  mode: 'direct' | 'retrieval' | 'rlm';
  scope: ContextScope;
  rlmEnabled: boolean;
  citationsRequired: boolean;
  recursiveChildCallsAllowed: boolean;
  budget: RlmBudget;
  activePaths: readonly string[];
  exactIdentifiers: readonly string[];
};
```

### Rule

The adaptive router decides once.

The later `vibespace_context` tool executes/enforces the plan; it does not independently reinterpret the same user request and choose a conflicting route.

### SiYuan

Do not move SiYuan indexing into the text hot path.

Preserve:

- local project-scoped map;
- safe scan;
- source/privacy exclusions;
- searchable full eligible structure;
- optional summaries;
- RLM indexing;
- provenance/citations;
- graph/subfile navigation;
- official SiYuan vault integration;
- nightly maintenance behavior.

### RLM acceptance

Test:

1. direct small answer;
2. bounded retrieval;
3. full RLM investigation;
4. exact source/open/expand evidence;
5. broad project/history query;
6. RLM disabled optional enrichment;
7. required route still authoritative;
8. cancellation;
9. context unavailable failure;
10. SiYuan map reload/restart.

Quality gate: answer/evidence parity with the current accepted RLM fixtures before legacy context routing is removed.

---

## Phase 7 — preserve and isolate the no-model command fast lane

This is not a provider turn and must stay separate.

### Instant Command behavior to preserve

`InstantCommandEntryBoundary` remains:

```text
input
 -> classify locally
    -> matched: execute locally, return receipt
    -> rejected: local safe rejection
    -> unmatched: optional model fallback
```

No matched Instant Command may hit the provider.

### Local command regression matrix

Cover representative families:

- navigation;
- open/focus settings/launcher/schedule;
- open terminals;
- open Codex/OpenCode/other supported CLI terminals;
- terminal message/broadcast routing;
- model picker opening;
- project/chat creation;
- tasks/schedule;
- media/local controls where supported;
- Terminal Peer Fabric/team commands;
- local context-map navigation.

### Chat slash/local utilities

Protect local behavior including:

- `/rlm on`;
- `/rlm off`;
- `/rlm status`;
- `/rlm refresh`;
- permission/mode status;
- `/usage`;
- `/clearfiles`;
- scheduled terminal actions;
- local mode changes;
- other confirmed commands that mutate only composer/local app state.

### Optional shared UI contract

Local commands may emit a lightweight `LocalCommandReceipt` into the durable transcript/UI for consistency, but they do not create a provider TurnState unless they explicitly launch provider work.

---

## Phase 8 — migrate AgenticConsole and ChatThread to one status source

### Current issue

Agentic session evidence, chat activity, transient run-state events, preview state, and durable messages can disagree.

### Target selectors

Create selectors such as:

```ts
selectTurnStatus(chatId)
selectVisibleText(chatId)
selectThinking(chatId)
selectToolJournal(chatId)
selectProviderError(chatId)
selectCanRetry(chatId)
selectCanCancel(chatId)
```

### UI rules

- spinner only when canonical turn status is nonterminal;
- provider error card and terminal failed header come from same turn state;
- “Thinking” is false immediately on terminal event;
- retry affordance comes from terminal state + safe latest user turn;
- cancel affordance exists only while the exact current turn owns cancellation;
- tool cards never remain running after turn failure/cancel;
- durable transcript remains the history source after active-turn eviction.

### Legacy compatibility

Where old components still expect `jarvis:run-state`, publish a compatibility event from the TurnStore for one migration phase. Do not let that event become a second writable state source.

---

## Phase 9 — durable checkpoints and long-running stability

The “sometimes nothing shows up for a very long time” class of failure needs recovery, not just faster rendering.

### Async checkpoint writer

Persist bounded checkpoints off the UI critical path:

- accepted turn identity;
- provider binding;
- visible public text checkpoint;
- tool journal checkpoint;
- latest revision;
- terminal state/error.

Suggested coalescing policy:

- immediate accepted/terminal checkpoint;
- during stream: at most every ~250 ms or after a bounded text delta threshold;
- never await checkpoint before UI paint.

### Recovery behavior

On chat remount or app restart:

1. load durable transcript;
2. load newest nonterminal checkpoint/canonical run;
3. if live provider session can be proven current, resume display;
4. otherwise mark `interrupted · outcome unknown`;
5. preserve partial public text;
6. never fabricate completion;
7. never automatically replay mutation/tool work.

### Background chat behavior

The TurnStore is keyed by chat/request and remains independent of which chat is mounted.

Switching chats must not pause provider events or redirect them into the active chat.

---

## Phase 10 — diagnostics without hot-path cost

### Fast capture

At event ingress, capture only cheap metadata/timestamps needed for latency:

- request/run/chat ids;
- event kind;
- provider sequence;
- native handoff monotonic timestamp;
- renderer receive monotonic timestamp.

### Deferred formatting

Redaction traversal, JSON serialization, disk persistence, HTML/debug export, and batching happen after TurnStore publication.

### Required metrics

For every native streaming acceptance turn record:

- native handoff -> renderer receive;
- renderer receive -> reducer commit;
- reducer commit -> React commit;
- renderer receive -> React commit;
- dropped event count;
- dropped diagnostic count;
- coalesced UI revision count.

Diagnostics failure must never delay or fail chat execution.

---

# 7. Performance budget

The controlled acceptance target is renderer receipt -> visible DOM commit.

| Stage | Budget |
|---|---:|
| provider/native event -> JS normalized event | <= 1.5 ms |
| incremental public guard | <= 0.75 ms |
| reducer/store mutation | <= 0.75 ms |
| store notification / selector work | <= 1.0 ms |
| React render + DOM commit | <= 6.0 ms |
| **Hard total** | **<= 10 ms** |

Additional target:

- P50 <= 5 ms;
- P95 <= 8 ms;
- hard benchmark maximum <= 10 ms.

The benchmark starts when the renderer has the provider/native event. Provider/network/model generation time is intentionally outside this UI-latency metric.

---

# 8. Provider and model quality preservation

No quality-reducing shortcuts are allowed.

The redesign must not:

- change selected model;
- change provider;
- change connection;
- reduce reasoning effort;
- shorten system prompt/context to win latency;
- disable RLM;
- remove tools;
- skip source provenance;
- collapse tool output in the provider request;
- silently fall back to a weaker model;
- turn an Agent request into an Ask request;
- remove completion validation.

Latency improvements come from local state architecture and incremental processing only.

---

# 9. Expected source scope during implementation

Final exact ownership must be claimed from the then-current repo before edits. Do not assume today's dirty state remains unchanged.

## Likely core files

```text
app/src/features/chat/runtime/turn/*
app/src/lib/ai/runtime.ts
app/src/lib/ai/router.ts
app/src/lib/ai/adapters/types.ts
app/src/lib/ai/providerError.ts
app/src/lib/jarvis/response/streamingPreviewGate.ts
app/src/lib/jarvis/response/publicStreamProjection.ts
app/src/features/chat/StreamingChatPreview.tsx
app/src/features/chat/streamingPreviewStore.ts
app/src/features/chat/runtime/chatRunState.ts
app/src/features/chat/ChatThread.tsx
app/src/features/chat/agentic-console/AgenticConsole.tsx
app/src/features/chat/MessagePart.tsx
app/src/features/chat/activity/*
app/src/lib/diagnostics/appActivityLog.ts
app/src/lib/diagnostics/activityLogPersistence.ts
```

## Provider adapters likely touched only at canonical event/error boundaries

```text
app/src/lib/ai/adapters/opencodePersistent.ts
app/src/lib/ai/adapters/codexPersistent.ts
app/src/lib/harness/eventNormalizer.ts
app/src/lib/harness/openCodeNativeTransport.ts
app/src/lib/harness/codexNativeTransport.ts
```

## Context / tool files touched only if required for one-plan / one-event convergence

```text
app/src/features/context/adaptiveContextRouter.ts
app/src/features/context/rlmOpenCodeTool.ts
app/src/features/context/gateway/*
app/src/features/context/rlm/*
app/src/lib/harness/toolGatewayRuntime.ts
app/src/lib/harness/toolGatewayProduction.ts
app/src/lib/ai/adapters/codexContextTool.ts
```

## Paths to protect from unnecessary rewrite

Instant Command and SiYuan internals should remain unchanged unless a failing regression proves a required integration change.

```text
app/src/features/instant-command/*
app/src/features/assistant/*
app/src/features/context/siyuan/*
```

Their behavior is acceptance coverage, not a redesign target.

---

# 10. Test strategy

## 10.1 Focused deterministic tests before native work

### Turn reducer

- accepted -> running -> completed;
- accepted -> failed;
- accepted -> cancelled;
- duplicate event;
- out-of-order event;
- stale attempt;
- late event after terminal;
- multiple text stream parts;
- replace vs append;
- pending tools on terminal;
- approval/question cleanup.

### Streaming

- first single token visible;
- punctuationless progress;
- sentence text;
- split markdown fences;
- split action/control blocks;
- private/unsafe content remains withheld/redacted;
- 50k+ response;
- 4,000 tiny deltas linear performance.

### Errors

- quota;
- rate limit;
- overloaded/busy;
- auth;
- HTTP 429 + retry metadata;
- session.error;
- session.status.error;
- CLI stderr;
- native disconnect;
- totally unknown safe error string;
- generic later error cannot overwrite richer earlier error;
- secrets redacted.

### Tools

- read;
- write/edit/diff;
- shell/command output;
- question;
- approval;
- child task/subagent;
- tool output before lifecycle event;
- failure;
- cancellation.

### Context

- direct;
- retrieval;
- RLM;
- evidence/citation;
- context unavailable;
- cancellation.

### Local commands

- matched Instant Command executes with zero model dispatch;
- rejected Instant Command executes with zero model dispatch;
- unmatched input calls model exactly once;
- `/rlm` local commands;
- permission/status local command;
- usage local command;
- terminal scheduling local command.

---

# 11. Official native acceptance matrix

All final acceptance is against the full native Tauri app, not Vite web preview.

## 11.1 Identity gate before every native acceptance run

Record:

- `jarvis.exe` PID/path;
- WebView PID and parent;
- WebView profile;
- CDP endpoint;
- page target;
- branch/HEAD;
- exact provider/connection/model/reasoning effort.

If the WebView does not belong to the intended `jarvis.exe`, stop that verification.

## 11.2 Text latency cases

Run task-owned chats only.

1. one-token/simple answer;
2. punctuationless streaming answer;
3. multi-paragraph answer;
4. long answer;
5. rapid tiny-delta fixture;
6. switch away while streaming and return;
7. two concurrent chats.

Hard metric: renderer event -> DOM commit <=10 ms for the controlled fixture.

## 11.3 Provider routes

At minimum exercise:

- OpenCode persistent route;
- Codex persistent route.

Where currently accessible, include representative user-selected models/efforts used by VibeSpace acceptance, including OpenCode Go / DeepSeek V4 Flash high reasoning and an official/translated Codex route without silently changing the selected identity.

## 11.4 Tool/UI chronology

One read-only native turn must visibly prove:

- text before/after tool;
- tool start;
- tool details;
- completed result;
- file label/diff where applicable;
- final answer;
- no duplicate tool card.

One controlled mutation fixture proves approval and exact result without touching user files.

## 11.5 Error transport

Use controlled fixtures where possible; do not burn user quota intentionally.

Inject/provider-fixture cases:

- `quota_exhausted`;
- `rate_limit`;
- overload/busy;
- auth required;
- unknown error;
- retry-after/reset;
- transport disconnect.

For each case verify simultaneously:

- exact safe message is visible;
- session header is failed;
- no thinking indicator;
- no pending live tools;
- retry/change-model/sign-in action only when supported;
- reopen chat shows same terminal state.

## 11.6 MCP

Native fixture plus real scoped gateway where safe:

- list;
- read-only run;
- denial;
- disconnect/reconnect;
- cancellation;
- restart;
- schema error;
- unknown tool;
- no duplicate execution.

## 11.7 RLM + SiYuan

Native Context Map acceptance:

- local SiYuan map visible;
- source attach/index;
- searchable subfiles;
- direct route;
- retrieval route;
- RLM route;
- provenance receipt;
- map reload;
- cancellation;
- chat answer retains exact source evidence.

Do not replace this with mocked browser-only evidence.

## 11.8 Instant Commands / no-model lane

Native acceptance should prove at least:

- one navigation Instant Command;
- one terminal/open CLI Instant Command;
- one local chat slash command such as `/rlm status`;
- one unmatched normal prompt.

Capture provider request count:

- matched local commands: zero provider requests;
- normal prompt: exactly one accepted provider turn.

---

# 12. Playwright and fallback strategy

## Preferred

Plugin 3 Playwright attaches to the already-running official Tauri WebView over the verified loopback CDP endpoint.

## If Plugin 3's Playwright wrapper fails technically

Use a task-owned Node Playwright script with the repo's Playwright dependency and `chromium.connectOverCDP('http://127.0.0.1:9251')` against the **same verified native WebView**.

This is still native Playwright; it is not a standalone browser.

## If the app is not exposing CDP

Start the official Tauri dev app using the repo's supported CDP configuration, then re-verify process parent/profile before testing.

## If Playwright itself cannot be restored

A deterministic native fixture, app diagnostics, screenshots, and DOM/timing instrumentation may be used to diagnose the blocker, but they do **not** replace the final native Playwright acceptance gate. Report the limitation rather than claiming full UI verification.

Never use a standalone web preview as acceptance.

---

# 13. Rollback strategy

Until legacy retirement:

- one development/internal switch selects legacy preview/state projection;
- canonical provider execution is not duplicated;
- dual-state shadow comparison is metadata-only;
- no tool or mutation is executed twice.

If a cutover phase fails native parity:

1. restore the selector to the legacy projection;
2. keep the new reducer shadowing;
3. fix the parity defect;
4. rerun focused + native matrix;
5. retry cutover.

Never use Git reset/clean/stash to roll back shared peer work.

---

# 14. Commit / implementation boundaries

Recommended small commits after verification:

1. `feat(chat): add canonical turn event reducer in shadow mode`
2. `perf(chat): make public streaming incremental`
3. `fix(chat): unify provider failure terminal state`
4. `refactor(chat): project tool chronology from canonical journal`
5. `refactor(context): bind one immutable context plan per turn`
6. `refactor(chat): drive agentic status from canonical turn state`
7. `fix(chat): persist recoverable turn checkpoints off hot path`
8. `perf(chat): move diagnostics formatting off streaming path`
9. `refactor(chat): retire legacy parallel live state`

Only commit paths actually owned and verified in that phase.

---

# 15. Required repo checks before completion

Per repo instructions, final code must pass:

```text
npm run typecheck
npm --prefix app run test
npm run test:release-manifest
npm run build
cargo check --manifest-path app/src-tauri/Cargo.toml
```

Also run phase-specific focused tests first so broad CI is not used as the debugger.

---

# 16. Hard acceptance checklist

Do not declare the implementation complete until every row is PASS.

| Area | Acceptance |
|---|---|
| Native identity | correct `jarvis.exe` -> WebView parent/profile/CDP |
| First public delta | visible <=10 ms |
| Punctuationless stream | immediate safe progress |
| Long response | no superlinear gate growth |
| State convergence | no error+running/thinking contradiction |
| Refresh/remount | terminal state remains correct |
| Restart recovery | partial/interrupted turn recovered truthfully |
| OpenCode text | PASS |
| Codex text | PASS |
| Reasoning privacy | PASS |
| Tool chronology | PASS |
| File/tool details | PASS |
| Approval | PASS |
| Question | PASS |
| Cancellation | PASS |
| Provider unknown error | visible sanitized |
| Quota/rate error | visible structured |
| Retry metadata | preserved |
| MCP list/run | PASS |
| MCP cancel/reconnect | PASS |
| RLM direct | PASS |
| RLM retrieval | PASS |
| RLM deep | PASS |
| SiYuan map/index/provenance | PASS |
| Instant Command matched | zero provider calls |
| Slash local command | zero provider calls |
| Normal chat prompt | exactly one accepted provider turn |
| Background/multi-chat | correct routing |
| Diagnostics | no execution impact / no silent evidence loss |
| Full repo checks | PASS |

---

# 17. Implementation order for the next session

When implementation begins, use this exact order:

1. Re-read current locks and git state; claim only exact phase files.
2. Snapshot inherited bytes for every claimed existing file.
3. Re-run focused baseline tests.
4. Add TurnEvent/TurnReducer in shadow mode.
5. Add parity assertions and reducer invariants.
6. Replace the public streaming scanner with incremental O(delta) processing.
7. Native latency check before doing more architecture work.
8. Add Universal Provider Failure Collector and atomic terminal reducer.
9. Native error-state convergence check.
10. Move tool UI to canonical journal while keeping Tool Gateway authority unchanged.
11. Native tool/MCP chronology check.
12. Bind immutable ContextPlan and prove RLM/SiYuan parity.
13. Prove Instant Commands/slash commands still bypass the model.
14. Move AgenticConsole/header/status selectors to TurnStore.
15. Add async durable checkpoints/recovery.
16. Move diagnostics formatting/persistence off the critical path.
17. Run multi-chat/restart/cancellation matrix.
18. Retire legacy state only after parity.
19. Run full required checks.
20. Final native Playwright matrix + latency evidence.
21. Commit only verified owned files and release only task-owned claims.

---

# 18. Final design principle

The redesign is not “remove safety layers.”

It is:

> **One provider/local fact enters once, is validated once at the correct authority boundary, becomes one canonical event, reduces into one authoritative turn state, and every UI/persistence surface projects from that state.**

That gives VibeSpace fewer hops, lower latency, fewer races, truthful errors, stable recovery, full tool/RLM/MCP/SiYuan fidelity, and a realistic path to a hard <=10 ms renderer-event-to-DOM target without reducing model quality.


---

# 19. Planning-pass verification evidence

This plan was checked against the current repo and official native app before handoff.

## Native identity / UI

Read-only Plugin 3 Playwright attached to loopback CDP 9251 and verified the main target belongs to the repo's running native `jarvis.exe` WebView/profile-c. The current native Context screen exposed the SiYuan Context Map flow, confirming that SiYuan/RLM integration is part of the acceptance surface that must be preserved.

No provider prompt, UI mutation, settings change, authentication action, restart, or user-chat modification was performed for this planning verification.

## Focused baseline tests

Command:

```text
npm test -- --run   src/lib/jarvis/response/streamingPreviewGate.test.ts   src/lib/jarvis/response/publicStreamProjection.test.ts   src/features/chat/streamingPreviewStore.test.ts   src/features/chat/StreamingChatPreview.performance.test.tsx   src/features/chat/MessagePart.providerError.test.tsx   src/features/instant-command/entryBoundary.test.ts   src/features/instant-command/acceptanceCorpus.test.ts   src/features/context/adaptiveContextRouter.test.ts   src/features/context/rlmOpenCodeTool.test.ts
```

Result:

- **9/9 test files passed**
- **126/126 tests passed**
- exit code 0

This establishes a known baseline for the exact areas the migration must preserve. It is not a substitute for the final full CI/native acceptance after implementation.
