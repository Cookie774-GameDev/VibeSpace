# OpenCode Harness Phase 4: Server Lifecycle Implementation Plan

> Execute sequentially with strict RED/GREEN tests. The approved design is
> `docs/superpowers/specs/2026-08-11-vibespace-opencode-server-lifecycle-design.md`.
> Do not start a real OpenCode server during automated verification.

**Goal:** Lazily run one authenticated, loopback-only, VibeSpace-owned
`opencode serve` process and keep Composer blocked until authenticated health
passes.

## Task 1: Trusted runtime launch metadata

**Files**

- Modify `app/src-tauri/src/harness/runtime.rs`

**Tests**

- registry retains the compatible probed version;
- opaque resolution revalidates canonical path and fingerprint;
- replacement remains rejected;
- server code cannot accept a caller path.

**Implementation**

Store version in the trusted registry and expose one crate-private resolved
record containing only canonical path and version.

## Task 2: Pure server contract and health validation

**Files**

- Create `app/src-tauri/src/harness/server.rs`
- Modify `app/src-tauri/src/harness/mod.rs`

**Tests**

- fixed `serve --hostname 127.0.0.1 --port` arguments;
- fixed VibeSpace username and 64-character random password;
- scoped config has loopback and `mdns: false`;
- no secret in debug/event/error serialization;
- loopback ephemeral port allocation;
- Basic auth required by the mock health responder;
- healthy compatible version accepted;
- unhealthy, unauthorized, oversized, malformed, incompatible responses fail.

## Task 3: Owned process lifecycle

**Files**

- Modify `app/src-tauri/src/harness/server.rs`

**Tests**

- successful start owns child/PID;
- same live runtime is reused;
- changed runtime causes owned restart;
- failed start terminates its child;
- stop terminates only the owned child;
- unrelated PID is never targeted;
- credentials disappear when the slot drops;
- single-flight start;
- normal stop is not classified as a crash.

**Implementation**

Use injected process/health traits for deterministic tests. Production Windows
launch uses a hidden suspended process assigned to a kill-on-close job before
resume. Non-Windows owns and kills only its direct child.

## Task 4: Bounded crash recovery and native commands

**Files**

- Modify `app/src-tauri/src/harness/server.rs`
- Modify `app/src-tauri/src/lib.rs`

**Tests**

- unexpected exit clears matching generation;
- stale watcher cannot clear a replacement;
- at most two restarts within five minutes;
- failed/starting/ready events contain no connection secret;
- state and commands exist only on the ordinary builder;
- app final-exit invokes owned shutdown;
- frozen ordinary command hashes update intentionally.

**Implementation**

Register `OpenCodeServerState`, ensure/status/stop commands, watcher recovery,
and final app-exit cleanup. Never register on the monochrome visual-test
builder.

## Task 5: Runtime manager server readiness

**Files**

- Modify `app/src/lib/harness/runtimeManager.ts`
- Modify `app/src/lib/harness/runtimeManager.test.ts`

**Tests**

- compatible detection invokes ensure with only opaque executable ID;
- state is `starting` until ensure resolves;
- ready only after native server readiness;
- connection stays out of public snapshot;
- `getConnection()` returns ephemeral credentials;
- detection/install refresh replaces stale connection;
- missing/incompatible/failure clears connection;
- browser preview never invokes server commands;
- unsubscribe does not stop the persistent server.

## Task 6: Verification and commits

Run fresh:

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_PROFILE_DEV_DEBUG='0'
$env:CARGO_PROFILE_TEST_DEBUG='0'
cargo test --no-default-features --lib harness
cargo test --no-default-features --lib ordinary_builder_manifest_matches_frozen_command_and_lifecycle_authority
cargo fmt --check
cargo check --no-default-features --lib
npm test -- --run src/lib/harness/runtimeManager.test.ts src/features/chat/HarnessReadinessGate.test.tsx
npm run typecheck
```

Also run scoped Prettier, `git diff --check`, credential scans, staged review,
and confirm no live OpenCode server ran. Commit verified logical slices,
release the Phase 4 lock, and continue to Phase 5.
