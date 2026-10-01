# PR31 Worker 7 Desktop and Release Evidence

Task: `VS-PR31-W7-DESKTOP-RELEASE-20260808`
Role: Worker 7 Desktop/Release writer
Requirements: master goal section 14 and sections 21-27
Starting and ending source HEAD: `b81d93489b39b307204fbb7b6747799d50c32384`

## Locally actionable gaps closed

- Replaced the prior two-Escape/600 ms intro skip with exactly three distinct, non-repeating Escape keydowns in an inclusive three-second window. Late input starts a new bounded window, and key repeat does not advance the gesture.
- Prevented raw updater errors from reaching either the user toast or background console. The UI and log now use fixed, non-secret-bearing messages.
- Kept the comprehensive taskbar interaction test intact while giving its load-sensitive 35-row interaction a bounded 10-second test timeout.
- Registered only the explicitly authorized `fsread::fs_rename_file` and `fsread::fs_delete_file` commands in the ordinary Tauri invoke handler, and updated both frozen command-authority hashes. A focused authority test verifies exact-once registration, ordering, and both hashes.
- Raised only the direct app `nanoid` floor and matching npm lock entry to 5.1.16, closing high-severity advisory GHSA-28wg-ghj8-5hjv without a general dependency refresh.

## Verification evidence

| Gate                                                                                                  | Result                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| Lifecycle, intro, fullscreen, taskbar, updater, error-boundary, stability, and capability Vitest gate | PASS: 30 files, 84 tests        |
| Pets, appearance, wallpaper library, onboarding, and developer console Vitest gate                    | PASS: 73 files, 372 tests       |
| Release manifest tests                                                                                | PASS: 44/44                     |
| Updater endpoint test                                                                                 | PASS: 1/1                       |
| Updater signature tests                                                                               | PASS: 9/9                       |
| Windows release tests                                                                                 | PASS: 25/25                     |
| OSS bundle tests                                                                                      | PASS: 2/2                       |
| Secret scanner self-tests                                                                             | PASS: 14/14                     |
| Native file command-authority test                                                                    | PASS: 1/1                       |
| `npm audit --audit-level=high`                                                                        | PASS: 0 vulnerabilities         |
| `npm ci --ignore-scripts --dry-run`                                                                   | PASS: lock consistency, exit 0  |
| `npm exec vite build`                                                                                 | PASS: Vite 7.3.6, 4,781 modules |
| `cargo fmt --check`                                                                                   | PASS                            |

The production build emitted existing chunk-size and mixed static/dynamic import warnings. The measured output was 501 files and 70,514,013 bytes (67.25 MiB). The largest outputs observed were the intro video (9,322,969 bytes), main JavaScript chunk (6,395,324 bytes), and loading-loop video (3,127,448 bytes). This is a current-state snapshot, not a before/after optimization claim.

The Tauri capability set was inspected read-only: all eight capability files have `remote: false`. Existing CSP includes `object-src 'none'`, `base-uri 'self'`, and `form-action 'self'`, with no `unsafe-eval`. No production publish, signing, secret, billing, database, or external-system mutation was performed.

## Independent-review follow-up

- Removed the stale hard-coded `153` count from the ordinary-handler assertion diagnostic. The assertion continues to compare the complete ordered handler against the frozen authority and hashes, while its failure text no longer becomes false when an authorized command is added.
- Added a behavioral updater rejection sentinel test. It renders the real update host, rejects the background updater check with arbitrary sentinel detail, spies on every toast method and relevant console method, and verifies neither the rejection object nor its text reaches any output. Mutation verification temporarily emitted the raw error and produced the expected RED failure; restoring the fixed production behavior returned 2/2 focused tests to GREEN.

## Honest blockers and external gates

- Focused native Cargo compilation could not complete in this workstation environment: the first attempt exceeded five minutes, retrying encountered rustc memory failure, and a single-job retry encountered Windows error 112 (insufficient disk space, approximately 1.78 GB free). Source formatting passes. The two newly registered functions must be integrated with Worker 4's separately owned and verified `fsread.rs` implementations before current integrated-head Cargo/CI verification.
- Workspace TypeScript checking reaches only sparse-worktree missing excluded fixtures/modules (chat monochrome fixtures, GitHub context proxy, gold-standard JSON, and runtime-profile visual manifests), plus two consequent implicit-any diagnostics. It reports no diagnostic in this worker's changed files.
- `cargo audit` is unavailable because the command is not installed; no tool installation or environment mutation was authorized.
- Live native gates remain controller/environment work: five-cycle cold/warm/restart/tray/exit verification, multi-monitor/DPI/4K fullscreen and recovery, taskbar restoration after crash, and a 30-minute soak.
- Signed Windows install/update, signature validation against production artifacts, public release, and signing-secret gates remain owner/external gated.
- Final current integrated-head CI must be green after combining this slice with Worker 4's command implementations and the other worker slices.

## Scope integrity

No protected `install/install.ps1`, `phone-jarvis/cloud/**`, `qa/**`, worker-owned native implementation, production release, or coordination file was changed. No file was staged, committed, pushed, published, or signed.
