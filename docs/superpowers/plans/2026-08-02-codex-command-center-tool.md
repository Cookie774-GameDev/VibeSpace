# Codex Command Center Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex Command Center as an honest, downloadable, preloaded VibeSpace Tool.

**Architecture:** A focused renderer lifecycle module and card call a narrow native bridge for
verified detection, download, cancellation, installation, and launch. Release authority is
build-time configuration; the product never invents a public artifact.

**Tech Stack:** React, TypeScript, Vitest, Tauri 2, Rust, reqwest, SHA-256.

## Global Constraints

- Exact product name: `Codex Command Center`.
- No dependency additions or external release/deployment mutation.
- Explicit user action is required for download, installer launch, and application launch.
- Preserve every unrelated Tools feature and existing dirty change.

---

### Task 1: Renderer lifecycle contract

**Files:**
- Create: `app/src/features/tools/command-center/commandCenterTool.ts`
- Test: `app/src/features/tools/command-center/commandCenterTool.test.ts`

**Interfaces:**
- Produces: `readCommandCenterReleaseAuthority()`, `inspectCommandCenterTool()`,
  `downloadCommandCenterTool()`, `cancelCommandCenterDownload()`,
  `installCommandCenterTool()`, and `launchCommandCenterTool()`.

- [ ] Write tests for missing authority, native state mapping, progress, cancellation, and
  failure recovery.
- [ ] Run the test and confirm it fails because the lifecycle module is absent.
- [ ] Implement the typed lifecycle with no polling and sanitized errors.
- [ ] Run the focused test and confirm it passes.

### Task 2: Preloaded Tool card

**Files:**
- Create: `app/src/features/tools/command-center/CommandCenterToolCard.tsx`
- Create: `app/src/features/tools/command-center/CommandCenterToolCard.test.tsx`
- Modify: `app/src/features/tools/ToolsPage.tsx`
- Test: `app/src/features/tools/ToolsPage.commandCenter.test.tsx`

**Interfaces:**
- Consumes: Task 1 lifecycle functions and status types.
- Produces: one accessible, responsive card with truthful state and safe actions.

- [ ] Write failing component tests for the exact name, unavailable, download-progress,
  cancel/retry, install, and launch states.
- [ ] Run the tests and confirm the card/import is absent.
- [ ] Implement the card and mount it in Preloaded tools without altering custom tools.
- [ ] Run the focused Tools tests and confirm they pass.

### Task 3: Native verified artifact bridge

**Files:**
- Create: `app/src-tauri/src/command_center_tool.rs`
- Modify: bounded module and handler registration in `app/src-tauri/src/lib.rs`

**Interfaces:**
- Produces the single narrow Tauri command `command_center_tool`, whose tagged request supports
  inspect, download, cancel, install, and launch without exposing native paths to the renderer.

- [ ] Write Rust unit tests for HTTPS/host validation, SHA validation, supported paths, and
  refusal to launch an unverified path.
- [ ] Run the focused Rust test and confirm the module/behavior is absent.
- [ ] Implement bounded streamed download, digest verification, atomic promotion, detection,
  explicit installer launch, and explicit app launch.
- [ ] Register the commands and update the frozen handler authority evidence.
- [ ] Run focused Rust tests, formatting, and `cargo check`.

### Task 4: Integration verification

**Files:**
- Verify all Task 1–3 files.

- [ ] Run focused VibeSpace Tools tests.
- [ ] Run VibeSpace TypeScript.
- [ ] Run scoped Prettier and `git diff --check`.
- [ ] Record the missing official artifact as an external release configuration requirement
  when no URL/hash is configured; do not deploy it.
