# Adaptive Stability Envelope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make renderer failures self-heal without losing live terminals and bound long-run startup/resource bursts without changing product behavior.

**Architecture:** Add WebView recreation between reload and whole-process restart, then bound canonical projection concurrency and historical evidence hydration. Preserve durable data and hydrate complete detail on demand through existing repositories.

**Tech Stack:** Tauri 2/Rust, React/TypeScript, Dexie, Vitest.

## Global Constraints

- Preserve every visible UI feature, route, control, terminal, provider, model, and user record.
- Never reset, clean, stage, commit, push, deploy, or terminate a user-owned process.
- Modify only the files listed in each task and preserve unrelated dirty work.
- Use strict RED/GREEN focused tests before implementation.

---

### Task 1: PTY-safe native WebView recreation

**Files:**

- Modify: `app/src-tauri/src/renderer_watchdog.rs`
- Test: `app/src-tauri/src/renderer_watchdog.rs`

**Interfaces:**

- Consumes: Tauri main `WindowConfig`, existing heartbeat age, terminal restart gate.
- Produces: `RecoveryAction::RecreateWebview` and a bounded main-window recreation path.

- [ ] **Step 1: Write the failing policy test**

Add assertions proving that after two reloads a stale visible renderer selects
`RecreateWebview`, including when process restart is blocked by live PTYs, and
that process restart is considered only after a failed recreation.

- [ ] **Step 2: Run the focused native test and verify RED**

Run:
`cargo test --manifest-path app/src-tauri/Cargo.toml renderer_watchdog::tests --lib`

Expected: compilation/test failure because `RecreateWebview` does not exist.

- [ ] **Step 3: Implement the minimal recovery ladder**

Add a bounded recreation attempt to recovery state. On the Tauri main thread,
capture main-window presentation, destroy the failed main WebView window,
rebuild it with `WebviewWindowBuilder::from_config`, and restore presentation.
Never restart the process while `TerminalState::has_active_sessions()` is true.

- [ ] **Step 4: Verify GREEN**

Run the focused native test, `cargo fmt --check`, and a bounded `cargo check`
for the desktop library/binary supported by the current environment.

### Task 2: Bounded canonical projection hydration

**Files:**

- Create: `app/src/lib/concurrency/boundedMap.ts`
- Create: `app/src/lib/concurrency/boundedMap.test.ts`
- Modify: `app/src/App.tsx`
- Test: `app/src/App.stability.test.ts`

**Interfaces:**

- Produces: `boundedMap<T, R>(items, concurrency, mapper): Promise<R[]>`.
- Consumes: existing account-scoped run, event, and artifact repositories.

- [ ] **Step 1: Write failing bounded-concurrency tests**

Prove result ordering, a maximum number of simultaneous mapper calls, empty
input handling, and rejection propagation.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:
`npm --prefix app test -- --run src/lib/concurrency/boundedMap.test.ts src/App.stability.test.ts`

- [ ] **Step 3: Implement bounded mapping and projection budgets**

Use eight concurrent per-run reads. Keep 500 recent events/artifacts for active
or recoverable runs and a smaller recent window for settled historical runs.
Do not delete or mutate canonical records.

- [ ] **Step 4: Verify GREEN**

Run focused tests, formatting, and the affected TypeScript gate.

### Task 3: Hidden-renderer background throttling

**Files:**

- Modify: `app/src-tauri/tauri.conf.json`
- Test: `app/src/runtimeStabilityConfig.test.ts`

**Interfaces:**

- Preserves: `--js-flags=--max-old-space-size=3072`.
- Removes: production `--disable-renderer-backgrounding`.

- [ ] **Step 1: Write a failing configuration contract**

Assert the emergency heap ceiling remains and hidden-renderer backgrounding is
not disabled in the production main window.

- [ ] **Step 2: Run the contract and verify RED**

Run:
`npm --prefix app test -- --run src/runtimeStabilityConfig.test.ts`

- [ ] **Step 3: Apply the minimal configuration change**

Remove only `--disable-renderer-backgrounding`.

- [ ] **Step 4: Verify GREEN**

Run the contract, focused heartbeat/resource-pressure tests, production bundle,
and scoped diff checks.

### Task 4: Final bounded review

**Files:**

- Modify: coordination records only.

- [ ] **Step 1: Review the complete scoped diff**

Confirm no UI, provider, model, terminal semantics, database schema, external
system, or unrelated product file changed.

- [ ] **Step 2: Run final focused verification**

Run native watchdog tests/checks, bounded hydration tests, heartbeat/resource
pressure tests, production bundle, formatting, and `git diff --check`.

- [ ] **Step 3: Record exact evidence**

Document the crash dump hash, current unchanged HEAD, tests, skipped checks,
native restart requirement, rollback backup, and remaining soak risk.
