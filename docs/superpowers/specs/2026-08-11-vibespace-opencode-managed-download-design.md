# VibeSpace OpenCode Managed Download Design

Date: 2026-08-11

Status: Approved by the owner-supplied OpenCode-only master goal and the
owner's standing instruction to proceed without clarification or approval
pauses.

## Purpose

Phase 3 gives a fresh Windows VibeSpace installation a one-click, fail-closed
way to install the pinned OpenCode core runtime. Chat remains visible while
the runtime is unavailable, but sending stays gated until native detection
reports a compatible system or managed executable.

This phase does not start `opencode serve`, switch production Chat routing, or
configure providers. Those remain later sequential phases.

## Considered approaches

### 1. Native streaming download and install — selected

Rust owns HTTPS, byte limits, SHA-256, ZIP validation, staging, atomic rename,
installed manifests, cancellation, and cleanup. The WebView receives only
bounded state/progress events and invokes explicit detect/install/cancel
commands.

This has the narrowest trust boundary and allows the executable to remain
unavailable until all verification succeeds.

### 2. WebView download followed by native verification — rejected

This could reuse browser fetch progress, but it moves executable bytes through
the WebView, complicates cancellation and temporary-file ownership, and
creates additional states where unverified content exists outside the native
installer's control.

### 3. Bundle OpenCode with VibeSpace — rejected

Bundling would simplify first launch but violates the master goal's managed
runtime policy, increases every app artifact, and prevents independent pinned
runtime updates.

## Release manifest

VibeSpace owns a versioned JSON manifest embedded into the native binary. The
initial Windows x64 entry is:

- OpenCode version `1.18.16`;
- core artifact `opencode-windows-x64.zip`;
- official HTTPS GitHub release URL;
- exact compressed size `60,501,625` bytes;
- SHA-256
  `a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff`;
- expected executable `opencode.exe`;
- bounded uncompressed archive size and file count.

The parser rejects unknown schema versions, non-HTTPS URLs, non-official
hosts, unsafe names, invalid hashes, zero/oversized limits, and a platform or
architecture mismatch. No frontend-supplied URL, hash, version, or executable
name participates in installation.

## Native components

`harness/manifest.rs` owns manifest parsing and validation.

`harness/download.rs` owns one active install operation:

1. acquire a single-flight install lease;
2. create a random staging directory below app-local-data
   `runtimes/opencode`;
3. download to a staging file over HTTPS;
4. reject missing or excessive content length;
5. stream bytes to disk while hashing and emitting bounded progress;
6. honor cancellation between every network/read/write phase;
7. require exact byte count and SHA-256;
8. open the verified ZIP;
9. reject excessive entries, traversal, absolute paths, symlinks, and
   excessive expanded bytes;
10. extract only regular files/directories below the staging extraction root;
11. require exactly the expected native executable path;
12. write `manifest.json` only after extraction verification;
13. atomically rename the complete version directory into its final location;
14. atomically update `active.json`;
15. run the Phase 2 detector and return its typed result.

An RAII cleanup guard removes staging content on error or cancellation. A
completed final version is never removed by failure cleanup. Existing system
OpenCode installations are read-only and never modified.

`harness/runtime.rs` continues to own canonical native discovery and trusted
fingerprints. The installer calls back through that boundary after an atomic
install instead of inventing a second compatibility path.

## Progress and cancellation

Native code emits one event channel with the existing runtime-state union:

- `checking`;
- `downloading` with progress clamped to `0..1`;
- `verifying`;
- `installing`;
- `ready`;
- `failed`.

The install command is explicit and user-triggered. Detection alone never
starts a download. Cancellation sets an atomic flag scoped to the active
install. Cancel does not terminate unrelated processes or remove a previously
completed runtime.

Only one install can run at a time. A second request returns the current
operation state rather than starting a duplicate download.

## Frontend state manager

`runtimeManager.ts` is the sole frontend source of runtime readiness. It:

- starts at `checking`;
- calls native detection once on the first desktop subscriber;
- maps compatible detection to `ready`;
- maps missing to `download_required`;
- maps incompatible to `incompatible` with bounded copy;
- subscribes to native progress events;
- exposes `refresh`, `download`, and `cancel`;
- treats non-Tauri browser/test environments as ready so web previews and
  existing browser-only tests do not acquire a false desktop dependency;
- never logs native diagnostics, URLs, hashes, or executable paths.

The manager keeps the user's draft untouched across failure and retry.

## Composer UX

`HarnessReadinessGate` renders above the normal Composer controls only when
the desktop runtime is not ready.

For a missing runtime:

```text
Chat requires the AI harness

[ Download Harness ]
```

During work it renders the current plain-language state and progress. Failure
shows bounded repair copy and a retry action. No installer wizard, terminal
instruction, harness selector, restart request, or OpenCode brand education is
introduced.

The textarea and send path are disabled/gated while the desktop runtime is not
ready. Attachments and the draft remain in memory. Once installation returns a
compatible managed runtime, the gate disappears and the Composer unlocks
automatically. The current provider router remains unchanged in this phase.

## Error handling

Native errors are classified as download, hash, archive, cancellation,
install, or detection failures. Messages are bounded and exclude response
bodies, authorization data, temporary random paths, and raw OS diagnostics.
Detailed internal errors may use fixed codes but never include secrets.

Hash mismatch, archive rejection, cancellation, disk failure, or rename
failure must leave:

- no executable launched;
- no `active.json` pointing to a partial install;
- no final version directory created by the failed operation;
- no stale single-flight lease;
- no unbounded progress/event history.

## Verification

Rust tests use injected readers/responses and temporary directories. They
cover:

- manifest validation;
- success with exact size/hash;
- network/read/write failure;
- cancellation;
- hash mismatch;
- excessive compressed or expanded size;
- excessive entry count;
- traversal, absolute paths, and symlink entries;
- missing expected executable;
- cleanup on every failed path;
- atomic final install and active manifest;
- existing completed runtime behavior;
- single-flight enforcement.

TypeScript tests cover:

- detection-state mapping;
- first-subscriber lazy detection;
- event progress clamping;
- download/cancel calls;
- missing/incompatible/failure UI;
- disabled send/input while unavailable;
- automatic unlock on ready;
- non-Tauri compatibility;
- draft preservation.

Verification must not perform a live runtime download or install. The official
release metadata is validated as static manifest evidence; live fresh-machine
installation remains an explicit desktop acceptance scenario.
