# OpenCode Harness Phase 2: Native Runtime Detection

> Execute sequentially with strict RED/GREEN tests. Do not begin managed
> download, server lifecycle, or production Chat routing in this phase.

**Goal:** Truthfully classify a native OpenCode runtime as compatible system,
compatible managed, incompatible, or missing without executing Windows script
shims or trusting a replaced executable.

**Architecture:** Add a dedicated `src-tauri/src/harness/runtime.rs` boundary.
Discovery gathers deterministic candidate paths from injected environment and
managed roots, canonicalizes regular files, rejects `.cmd`/`.bat`/`.ps1`,
fingerprints bytes with SHA-256, probes `opencode --version` through an
injectable probe boundary, and registers the selected executable under an
opaque ID. Before later process use, the registry re-canonicalizes and
re-fingerprints the path so replacement fails closed. The production Tauri
command derives only known roots plus the Tauri app-local-data runtime root.

**Compatibility boundary:** Phase 2 validates native executable identity and
the minimum supported OpenCode version (`1.18.16`). The isolated
`opencode serve` health/capability probe belongs to Phase 4, where port,
authentication, child ownership, and cleanup are implemented together. The
Phase 2 result therefore names its positive state `systemCompatible` or
`managedCompatible` specifically for the native runtime gate.

---

## Task 1: Candidate discovery and path safety

**Files**

- Create: `app/src-tauri/src/harness/mod.rs`
- Create: `app/src-tauri/src/harness/runtime.rs`

**RED tests**

Add unit tests covering:

- PATH native `opencode.exe`;
- Scoop current install;
- Chocolatey native install;
- standalone local install;
- npm shim resolution to the underlying
  `node_modules/opencode-ai/bin/opencode.exe`;
- script-shim-only candidate rejection;
- missing runtime;
- deterministic deduplication and source priority;
- managed version-directory candidate.

Use temporary directories under `std::env::temp_dir()` with unique names.
Tests must clean their own fixtures. Candidate generation receives an injected
environment map and managed root; it must not mutate the real environment.

**RED command**

```powershell
cargo test harness::runtime::tests::candidate
```

Expected initial failure: the new module/functions do not exist.

**GREEN implementation**

Implement:

- `RuntimeSource` (`system`, `managed`);
- internal `CandidateOrigin` with explicit priority;
- deterministic candidate generation for Windows and portable PATH names;
- native-name allowlist (`opencode.exe` on Windows, `opencode` elsewhere);
- canonical regular-file validation;
- case-insensitive `.cmd`, `.bat`, and `.ps1` rejection;
- canonical-path deduplication.

Do not run wrappers, recursively scan arbitrary directories, or read user auth.

## Task 2: Version compatibility and truthful classification

**Files**

- Modify: `app/src-tauri/src/harness/runtime.rs`

**RED tests**

Add tests covering:

- `opencode 1.18.16`;
- `v1.18.16`;
- a newer compatible release;
- malformed version output;
- incompatible older version;
- valid fake native candidate selected through an injected probe;
- invalid fake executable rejected;
- incompatible system candidate followed by compatible managed candidate;
- all candidates unusable returns `missing` with bounded diagnostics.

**RED command**

```powershell
cargo test harness::runtime::tests::detection
```

**GREEN implementation**

Implement:

- bounded `--version` process probe with no shell;
- semantic numeric version parser;
- minimum supported version constant `1.18.16`;
- `OpenCodeRuntimeStatus` serialized as
  `systemCompatible`, `managedCompatible`, `incompatible`, or `missing`;
- selected path, version, source, opaque executable ID, and SHA-256 fingerprint
  only for a positive result;
- bounded safe incompatibility reasons.

Probe candidates in deterministic priority order. Never silently choose a
different executable after a compatible candidate is selected.

## Task 3: Fingerprint registry and replacement rejection

**Files**

- Modify: `app/src-tauri/src/harness/runtime.rs`

**RED tests**

Add tests covering:

- opaque ID differs from the executable path;
- unchanged executable resolves;
- replaced bytes fail resolution;
- deleted executable fails resolution;
- a directory or unsafe extension cannot register.

**RED command**

```powershell
cargo test harness::runtime::tests::registry
```

**GREEN implementation**

Implement `OpenCodeRuntimeState` with a mutex-protected trusted registry.
Fingerprint executable bytes by streaming SHA-256. Resolve by opaque ID,
re-canonicalize, verify the same canonical path, and compare a fresh hash.
Do not expose a command that accepts an arbitrary executable path for process
launch.

## Task 4: Tauri command and frozen registration authority

**Files**

- Modify: `app/src-tauri/src/harness/mod.rs`
- Modify: `app/src-tauri/src/harness/runtime.rs`
- Modify: `app/src-tauri/src/lib.rs`

**RED tests**

Add source-registration assertions proving:

- `OpenCodeRuntimeState` is managed only by the ordinary builder;
- `harness::runtime::opencode_runtime_detect` is registered only in the
  ordinary invoke handler;
- the minimal monochrome visual-test builder remains unchanged.

**RED command**

```powershell
cargo test ordinary_builder_manifest_matches_frozen_authority
```

**GREEN implementation**

Register state and the read-only detection command in the ordinary builder.
Resolve the managed root through Tauri app-local-data:

```text
<app-local-data>/runtimes/opencode
```

The command may inspect candidate files and execute only canonical native
OpenCode candidates with the fixed `--version` argument. It must not download,
install, start a server, or modify a system installation.

## Task 5: Verify and commit

Run fresh:

```powershell
cargo test harness::runtime
cargo test ordinary_builder_manifest_matches_frozen_authority
cargo fmt --check
cargo check
git diff --check -- app/src-tauri/src/harness app/src-tauri/src/lib.rs docs/superpowers/plans/2026-08-11-vibespace-opencode-harness-phase-2.md
```

Review the complete owned diff, confirm package/lockfiles are untouched, scan
added lines for credentials, then commit only the exact owned Phase 2 product,
test, and plan files. Release the coordination lock in a separate coordination
commit and continue to Phase 3.
