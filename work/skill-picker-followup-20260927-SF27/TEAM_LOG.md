# Skill picker follow-up — SF27

Branch: `integration/UnifiedChungus-final`; base `9613c1c5ceda3f28ab0d6be7b4e3e5ed78c741c9`. C2 only, CDP 9252 and `work/dual-live-20260912/profile-c2`; C1 and peer changes preserved.

| File | Change | Reason |
| --- | --- | --- |
| `app/src/features/chat/Composer.tsx` | Ordinary Codex discovery uses `forceReload: false`; manual Refresh uses `true`; occupied native route gets concise text; failed same-authority refresh retains its last catalog. | Faster opens, no internal route error in the picker, and no loss of selectable skills during transient contention. |
| `app/src/lib/ai/adapters/codexPersistent.ts` | Skill discovery lease wait aborts after one second, removing only its queued read. | A long turn cannot leave the picker spinning indefinitely; native owner is never stopped. |
| `app/src/features/chat/Composer.nativeSkills.test.tsx` | Checks initial and forced refresh, safe busy error, and retained catalog after failed refresh. | Covers the visible behavior and authority-preserving fallback. |
| `app/src/lib/ai/adapters/codexPersistent.test.ts` | Checks bounded wait without starting or stopping a native process. | Protects the active turn and verifies responsiveness. |
| `.learnings/LEARNINGS.md` | Appended SF27 correction. | Records why the prior compact UI change did not address first-open native contention. |
| `docs/AGENT_COORDINATION.md` | Appended own claim/checkpoints. | Live ownership and audit trail; peer ledger history remains intact. |
| `work/skill-picker-followup-20260927-SF27/*` | C2 launch scripts, native Playwright probe, logs, and this record. | Reproducible native verification without touching C1. |

Checks: focused Composer/Codex tests 61/61 pass. Typecheck passed before the final same-authority refresh assertion; rerun pending. Release manifest 45/45 pass. First web build failed on a test fixture type error, fixed; subsequent build was stopped to free memory for C2 native link, final build pending. First full app suite exited 1 with `HTMLMediaElement.play()` not implemented; no full-suite totals captured. C2 native Playwright, cargo check, final build, and commit pending.

Rejected approach: recovering a remembered native generation in read-only discovery. Existing model discovery explicitly forbids this because it could stop an active provider turn. The temporary change and its red test were removed before the focused green run.

Native C2 result: CDP9252/WebView2 PID11804 under C2 jarvis.exe PID21992, profile work/dual-live-20260912/profile-c2/EBWebView. Playwright: picker 163ms, OpenCode two live options/no alert; attach $typesafe-ai 166ms, next frame 7ms, chip removed and draft restored; manual native Refresh 2963ms, two options/no alerts. Evidence:
ative-identity.json, qa-native.json, qa-refresh.json, picker.png. This is the live OpenCode happy path; Codex occupied-route branch remains unit verified only.

Correction: evidence filenames are native-identity.json, qa-native.json, qa-refresh.json, picker.png; prior line break before native-identity.json came from PowerShell backtick escaping. HEAD advanced to peer relay commit ab94dd4b during native QA; SF27 source edits remain uncommitted and peer paths untouched.

Gate update 2026-09-27T05:02:55Z: post-peer-commit npm run typecheck exits 1 in peer-owned relayNativeRoomClient.ts:150:52 (snapshot.context possibly null). Own Composer/Codex focused tests 61/61 pass. Preserve peer file; do not patch it.

Gate update 2026-09-27T05:04:35Z: cargo check --manifest-path app/src-tauri/Cargo.toml passed with C2 target dir (exit 0, 225 pre-existing dead-code/unused warnings in lib). Final typecheck after peer null-guard is running; Vite build pending.

Gate update 2026-09-27T05:05:23Z: npm run typecheck exit0 after the peer Relay null guard; peer HEAD advanced to 5b3f53581a63e2fd01a235d151e029704d490562 with no SF27 file overlap. npm run build is running; final scoped commit pending.

Gate update 2026-09-27T05:07:36Z: npm run typecheck exit0 and npm run build exit0 (Vite 5330 modules/57.31s). Cargo check exit0, release manifest 45/45, focused tests 61/61. Full npm --prefix app run test is running with output in app-test.log. Peer HEAD 2956900199f45f177632fafe8e0517ea917ca86d; no owned-file overlap. Native C2 success evidence above.

Final verification 2026-09-27T05:42:42Z: full npm --prefix app run test exit0 — 1,735 files / 16,746 tests pass in 2,149.34s. This supersedes the earlier interrupted/diagnostic-only run. Other final gates: focused Composer/Codex 61/61, npm run typecheck exit0, npm run test:release-manifest 45/45, npm run build exit0, cargo check exit0, native C2 Playwright picker/attach/Refresh passes. Diff check of exact owned paths is clean. Peer HEAD at precommit 2956900199f45f177632fafe8e0517ea917ca86d; source patch preserved as owned-precommit.patch. Only six SF27 files are intended for commit; shared ledger remains append-only and uncommitted.
