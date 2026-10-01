# OpenCode Harness Phase 3: Managed Download Implementation Plan

> Execute sequentially with strict RED/GREEN tests. The owner-approved design
> is `docs/superpowers/specs/2026-08-11-vibespace-opencode-managed-download-design.md`.
> Do not perform a live download/install during verification.

**Goal:** Let a desktop user install the pinned OpenCode core runtime from one
Composer CTA with native, fail-closed verification and atomic installation.

**Architecture:** Rust owns immutable release metadata, HTTPS streaming,
hashing, archive validation, staging, cleanup, atomic install, cancellation,
and progress events. A TypeScript external store maps native detection/events
to the existing `HarnessRuntimeState`. A small Composer gate disables send
while preserving the draft. Phase 4 remains responsible for starting and
authenticating `opencode serve`.

---

## Task 1: Pinned release manifest

**Files**

- Create: `app/src-tauri/resources/opencode-runtime-manifest.json`
- Create: `app/src-tauri/src/harness/manifest.rs`
- Modify: `app/src-tauri/src/harness/mod.rs`

**RED tests**

Cover:

- embedded Windows x64 release parses exactly;
- schema/version/platform/architecture validation;
- HTTPS-only and official-host-only source;
- safe asset and executable basenames;
- exact 64-character lowercase SHA-256;
- positive byte/archive limits;
- unknown fields do not silently change the selected platform record.

**RED command**

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_PROFILE_TEST_DEBUG='0'
cargo test --no-default-features --lib harness::manifest
```

**GREEN implementation**

Embed and parse schema version 1. The selected record is wholly native-owned:
OpenCode `1.18.16`, `opencode-windows-x64.zip`, `60,501,625` bytes, SHA-256
`a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff`,
expected `opencode.exe`, bounded expanded bytes, and bounded entry count.

Commit this manifest slice after focused verification.

## Task 2: Streaming download verification primitives

**Files**

- Create: `app/src-tauri/src/harness/download.rs`
- Modify: `app/src-tauri/src/harness/mod.rs`

**RED tests**

Use injected `Read` implementations and temporary files to cover:

- exact bytes and hash;
- compressed byte overflow;
- short response;
- hash mismatch;
- read error;
- write/disk error through an injected writer;
- cancellation before and during streaming;
- progress is monotonic and clamped.

**GREEN implementation**

Create small pure functions that stream into `Write`, hash in the same pass,
enforce the exact byte count/upper bound, and call progress/cancellation hooks.
Do not retain archive bytes in memory.

## Task 3: Safe extraction and atomic installation

**Files**

- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/Cargo.lock`
- Modify: `app/src-tauri/src/harness/download.rs`
- Modify: `app/src-tauri/src/harness/runtime.rs` only for a narrow reusable
  post-install detection entry point

**RED tests**

Programmatically build ZIP fixtures covering:

- successful expected executable;
- `../` traversal;
- absolute and prefixed paths;
- symlink/non-regular entries;
- excessive entries;
- excessive expanded bytes;
- missing expected executable;
- cleanup after every failure;
- atomic final directory;
- installed `manifest.json`;
- atomic `active.json`;
- an existing complete identical runtime.

**GREEN implementation**

Add the already-resolved `zip` crate as a direct dependency. Extract only
`enclosed_name()` entries, reject symlinks and non-file/non-directory modes,
enforce totals before writes, require the exact native executable, then rename
the complete version directory and active-manifest temporary file atomically.
An RAII staging guard cleans failure/cancellation paths.

Commit the verified installer-core slice.

## Task 4: Native install commands and progress lifecycle

**Files**

- Modify: `app/src-tauri/src/harness/download.rs`
- Modify: `app/src-tauri/src/harness/mod.rs`
- Modify: `app/src-tauri/src/lib.rs`

**RED tests**

Cover:

- one active install lease;
- second install request rejected deterministically;
- cancellation scoped to the active install;
- lease released after success/error/cancel;
- state events contain only bounded safe fields;
- command/state registration exists only on the ordinary builder;
- frozen ordinary command hashes update intentionally.

**GREEN implementation**

Add managed `OpenCodeDownloadState`, async `opencode_runtime_install`, and
`opencode_runtime_install_cancel`. Use `spawn_blocking` around the blocking
native installer. `reqwest::blocking` accepts only the embedded HTTPS URL and
checks content length before streaming. Emit
`vibespace://opencode-runtime-state` without response bodies or filesystem
diagnostics. After atomic install, call Phase 2 detection and require
`managedCompatible`.

## Task 5: Frontend runtime state manager

**Files**

- Create: `app/src/lib/harness/runtimeManager.ts`
- Create: `app/src/lib/harness/runtimeManager.test.ts`
- Modify: `app/src/lib/harness/index.ts`

**RED tests**

Cover:

- lazy first-subscriber detection;
- native result mapping;
- missing → `download_required`;
- compatible → `ready`;
- incompatible and failed bounded copy;
- progress event clamping;
- explicit download and cancel invokes;
- download success refresh;
- subscriber cleanup;
- non-Tauri → ready compatibility.

**GREEN implementation**

Use a module-scoped external store with injectable native adapter for tests.
Expose `subscribe`, `getSnapshot`, `refresh`, `download`, and `cancel`.
Never log the native response or persist runtime paths/fingerprints.

Commit the verified state-manager slice.

## Task 6: Composer readiness gate

**Files**

- Create: `app/src/features/chat/HarnessReadinessGate.tsx`
- Create: `app/src/features/chat/HarnessReadinessGate.test.tsx`
- Modify: `app/src/features/chat/Composer.tsx`

**RED tests**

Cover:

- exact missing CTA copy;
- download click;
- progress text/progressbar;
- retry and cancel;
- incompatible/failure repair copy;
- gate absent when ready;
- Composer textarea disabled while blocked;
- send path refuses unavailable runtime;
- draft value survives blocked → ready.

**GREEN implementation**

Use `useSyncExternalStore` with the runtime manager. Render the gate above the
input, disable the textarea/send controls while unavailable, and add an early
send guard. Do not clear draft/attachments or change provider routing.

## Task 7: Final Phase 3 verification and commits

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
npm exec prettier -- --check "app/src/lib/harness/*.ts" "app/src/features/chat/HarnessReadinessGate*.tsx" "app/src/features/chat/Composer.tsx" "docs/superpowers/specs/2026-08-11-vibespace-opencode-managed-download-design.md" "docs/superpowers/plans/2026-08-11-vibespace-opencode-harness-phase-3.md"
```

Also:

- run `git diff --check` on exact owned paths;
- inspect all staged native/frontend changes;
- confirm only the intended direct `zip` dependency changed package/lock data;
- scan added lines for credentials;
- confirm no live runtime download/install ran;
- commit each verified logical slice immediately;
- release the Phase 3 coordination lock and continue to Phase 4.
