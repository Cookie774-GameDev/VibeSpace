# Browser Chat Workspace and Permission-Plan MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Turn Browser Chat into a durable VibeSpace workspace around isolated
provider WebViews and a truthful, permission-plan-based VibeSpace MCP gateway.

**Architecture:** Durable account/workspace-scoped Browser Chat records live in
Dexie and reference existing VibeSpace chats/projects. Provider-specific
adapters normalize only allowlisted top-level navigation metadata. A reusable
child WebView hosts the provider page without privileged IPC. The app-lifetime
desktop relay advertises only locally executable capabilities allowed by the
active permission plan; the Worker routes the resulting versioned catalog to
the matching account-scoped relay.

**Tech Stack:** React 19, TypeScript, Zustand, Dexie, Vitest, Tauri 2.11,
Rust, Cloudflare Workers, Durable Objects, MCP Streamable HTTP.

## Global Constraints

- Preserve all unrelated dirty PR31 work.
- Never scrape provider DOM, cookies, prompts, responses, or account secrets.
- Never infer MCP authorization from provider page load.
- Provider resume URLs are private metadata and must pass provider-specific
  HTTPS host/path validation.
- Every local record, grant, relay ticket, and tool call is account-scoped.
- Tool advertisement must equal executable local authority.
- ChatGPT Pro remains read/fetch only; current full write/modify MCP is limited
  to supported Business and Enterprise/Edu workspace flows.
- No push, merge, deployment, release, or installation without separate exact
  authorization.

---

### Task 1: Durable Browser Chat records and repositories

**Files:**

- Modify: `app/src/lib/db/schema.ts`
- Modify: `app/src/lib/db/index.ts`
- Modify: `app/src/lib/db/index.migration.test.ts`
- Create: `app/src/features/browser-chat/browserChatRepository.ts`
- Create: `app/src/features/browser-chat/browserChatRepository.test.ts`

**Interfaces:**

- Produces: `BrowserChatBindingRow`, `ProviderProjectLinkRow`,
  `createBrowserChatBindingRepository(database, clock, idFactory)`, and
  `createProviderProjectLinkRepository(database, clock, idFactory)`.
- Enforces: exact account/workspace scope, one active binding per chat,
  duplicate provider-conversation prevention per account/workspace/profile,
  pin/rename/project move/open-state updates, and scoped removal.

- [x] Write migration and repository tests that fail because V10 tables and
      repositories do not exist.
- [x] Run the exact tests and retain the expected RED output.
- [x] Add `STORES_V10`, typed Dexie tables, and additive V10 registration.
- [x] Implement repositories with constructor-injected database, clock, and ID
      factory; validate scope and immutable identity fields at every mutation.
- [x] Run the focused tests until GREEN, then run the adjacent migration suite.
- [x] Format, inspect the exact diff, scan added lines for credentials, and
      commit the verified slice.

### Task 2: Provider navigation adapters and durable session rail

**Files:**

- Modify: `app/src/features/browser-chat/providerRegistry.ts`
- Create: `app/src/features/browser-chat/providerNavigation.ts`
- Create: `app/src/features/browser-chat/providerNavigation.test.ts`
- Modify: `app/src/features/browser-chat/BrowserChatHub.tsx`
- Modify: `app/src/features/browser-chat/BrowserChatHub.test.tsx`
- Modify: `app/src/features/browser-chat/browserChatStore.ts`
- Modify: `app/src/features/browser-chat/browserChatStore.test.ts`

**Interfaces:**

- Consumes: Task 1 repositories.
- Produces: `normalizeProviderNavigation(providerId, rawUrl)` returning only
  allowlisted provider/conversation/project keys; Browser Chat rail actions
  for new, reopen, rename, pin, project move, remove binding, and mode switch.

- [x] Reproduce localStorage-only session inference and missing durable rail
      operations with focused failing tests.
- [x] Implement provider adapters without DOM inspection.
- [x] Migrate Browser Chat list selection to the durable binding repository
      while retaining per-chat engine/provider compatibility.
- [x] Implement keyboard-accessible pinned and provider-session sections.
- [x] Verify duplicate prevention, restart restoration, stale URL failure, and
      Provider/VibeSpace mode reuse.
- [x] Commit the verified slice.

### Task 3: True child WebView and top-level navigation bridge

**Files:**

- Modify: `app/src-tauri/src/browser_chat_surface.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/features/browser-chat/providerSurface.ts`
- Modify: `app/src/features/browser-chat/providerSurface.test.ts`
- Modify: `app/src/features/browser-chat/BrowserProviderSurface.tsx`
- Modify: `app/src/features/browser-chat/BrowserProviderSurface.test.tsx`
- Modify: `app/src/lib/security/tauriCapabilities.test.ts`

**Interfaces:**

- Produces: reusable child WebViews hosted by the main Tauri window and a
  bounded top-level navigation event containing provider, surface ID,
  normalized allowlisted URL, timestamp, and navigation kind.

- [x] Write failing Rust/frontend tests proving the current separate
      `WebviewWindow` path and missing navigation metadata.
- [x] Replace the supported path with a main-window child WebView using the
      repository-compatible Tauri API; retain the external-browser fallback.
- [x] Serialize show/hide/provider-switch operations and coalesce geometry.
- [x] Verify the remote provider receives no VibeSpace IPC capability.
- [ ] Run focused Rust/frontend tests, Cargo check, and native Windows smoke
      for drag/resize/maximize/mode/provider switching. The focused
      Rust/frontend tests plus default-feature and no-default-features Cargo
      checks pass; installed Windows smoke remains
      `BLOCKED — OWNER ACTION REQUIRED`.
- [x] Commit the verified slice.

### Task 4: History, project links, and official export snapshots

**Files:**

- Modify: `app/src/features/projects/ProjectDetail.tsx`
- Modify: `app/src/features/history/HistoryPage.tsx`
- Modify: `app/src/features/history/HistoryList.tsx`
- Create: `app/src/features/browser-chat/chatGptExport.ts`
- Create: `app/src/features/browser-chat/chatGptExport.test.ts`
- Extend Task 1 schema/repositories with versioned import snapshot records if
  repository inspection proves existing message authority cannot represent
  imported provider snapshots safely.

**Interfaces:**

- Produces: provider-project link/unlink/open states; Browser Chat history
  summary rows; cancellable defensive ZIP import with stable deduplication and
  separate provider-snapshot authority.

- [x] Write failing lifecycle, search, replay, dedupe, hostile archive, size,
      and cancellation tests.
- [x] Implement local project linking without claiming remote membership.
- [x] Implement history summary/open behavior for non-imported bindings.
- [x] Implement snapshot import without HTML/script execution.
- [x] Verify re-import updates rather than duplicates and delete affects only
      the local snapshot.
- [x] Commit the verified slice.

### Task 5: Permission plans and executable local tool adapters

**Files:**

- Extend exact paths only after confirming no concurrent owner:
  `app/src/lib/bridge/**`, `app/src/lib/mcp/**`,
  `app/src/features/browser-chat/**`, existing native file/terminal/Git/browser
  brokers, and `workers/vibespace-mcp/**`.

**Interfaces:**

- Produces: `off`, `read`, `project_developer`, `full_local_developer`, and
  `custom` plans; per-capability approval modes; dynamic registration/tool
  catalogs; structured denial source; immediate revocation; bounded file,
  terminal, Git, browser, and downstream-MCP execution.

- [x] Freeze current read-tool behavior with focused tests.
- [x] Add failing serialization, capability calculation, catalog-diff,
      revocation, sign-out cancellation, wrong-account, replay, timeout, and
      unavailable-tool tests.
- [x] Implement the permission registry before individual mutation tools.
- [x] Adapt existing approval-gated brokers one capability family at a time,
      with real fixture execution and structured results.
- [x] Keep provider-plan limitations distinct from VibeSpace authorization.
- [x] Run app/Worker/native focused suites, Worker typecheck, and Wrangler dry
      run; commit each verified capability family separately.

### Task 6: Final status, performance, native acceptance, and review

**Files:**

- Modify only exact status/evidence paths discovered and locked during the
  preceding tasks.
- Update: `docs/operations/PR31_BROWSER_CHAT_MCP_EXECUTION_LEDGER.md`
- Update: `docs/operations/PR31_FINAL_EVIDENCE.md`

**Interfaces:**

- Produces: independent provider/authorization/relay/tool/project/output
  states, provider-controlled model/quota unavailable states, performance
  evidence, requirement audit, and reviewer closure.

- [x] Verify status badges against their source stores and prove no fake
      working/connected/authorized state.
- [x] Exercise 10/50 saved sessions, WebView reuse, relay idle/reconnect, and
      bounded import/history behavior.
- [x] Run all focused suites and repository gates from the master goal;
      retain the exact technical blockers in the execution ledger.
- [ ] Run installed Windows/Tauri acceptance where the environment permits.
      This environment does not provide the required installed/provider
      control plane, so the gate remains `BLOCKED — OWNER ACTION REQUIRED`.
- [x] Dispatch the mandatory independent reviewer with the full bounded
      bootstrap, current head, goal, changed paths, migrations, tests, CI, and
      native evidence.
- [x] Fix all P0/P1 findings, rerun affected gates, and obtain bounded
      re-review.
- [x] Complete the requirement-by-requirement audit without narrowing the
      original goal; leave PR31 draft.
