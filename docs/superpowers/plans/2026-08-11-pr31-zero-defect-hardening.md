# PR31 Zero-Defect Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Eliminate every reproducible PR31 release-gate defect, re-audit
Browser Chat/MCP against the latest OpenCode harness head, and record only
freshly verified outcomes.

**Architecture:** Preserve the current local-first and OpenCode-only
boundaries. Diagnose each failure to its source, add a focused failing
regression first, apply one minimal correction, and commit only after focused
and adjacent gates pass.

**Tech Stack:** React, TypeScript, Vitest, Zustand, Dexie, Tauri 2, Rust,
Cloudflare Workers.

## Global Constraints

- Work only in `agent/pr30-fixes-and-updates` and its existing isolated
  worktree.
- Preserve every pre-existing dirty or untracked path until ownership and
  provenance are explicit.
- Do not push, merge, deploy, install, release, use account credentials, or
  mutate global OpenCode state.
- Keep Browser Chat account/workspace/project scope, provider WebView
  isolation, approval gates, and fail-closed revocation intact.
- Commit each independently verified correction immediately.

---

### Task 1: Account-identity failure closure

- [ ] Reproduce all failures in `App.accountIdentity.test.tsx`.
- [ ] Trace cloud-sync, authority, sign-out, and tier data to their source.
- [ ] Add one failing regression for each distinct root cause.
- [ ] Apply minimal source corrections and run focused plus adjacent auth
      suites.
- [ ] Commit the verified slice.

### Task 2: Benchmark failure reconciliation

- [ ] Reproduce `BenchmarksPage.warmSchemaB.test.tsx`.
- [ ] Determine whether source or fixture changed and preserve concurrent work.
- [ ] Add or refine a regression that asserts authoritative behavior.
- [ ] Apply the minimal additive correction and run the benchmark suite.
- [ ] Commit only exact benchmark paths after ownership is safe.

### Task 3: Browser Chat/MCP integration audit

- [ ] Review `9bfe4bde..HEAD` for native registration or authority regressions.
- [ ] Run the Browser Chat/bridge, Worker, capability-manifest, and native
      focused suites.
- [ ] Use TDD for every proven regression and commit each correction.

### Task 4: Repository and native gates

- [ ] Run all frontend shards, TypeScript, production build, release manifest,
      and PR31 OSS verification.
- [ ] Run Rust formatting, default/no-default checks, focused native tests,
      and the full no-default library suite.
- [ ] Run Worker tests, typecheck, and Wrangler dry-run without deployment.
- [ ] Complete available running-app acceptance without credentials or
      installation.

### Task 5: Independent closure

- [ ] Update exact evidence and blockers.
- [ ] Dispatch an independent bounded reviewer at the final implementation
      head.
- [ ] Fix every P0/P1 and correctness/security/persistence P2 finding.
- [ ] Rerun affected and final gates, commit evidence, and release locks.
