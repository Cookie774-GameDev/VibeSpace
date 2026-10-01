# Verification Report — PR #31 OpenCode + RLM Stabilization

## Verdict

`IMPLEMENTED — REPOSITORY INTEGRATION AND NATIVE VERIFICATION REQUIRED`

The source contracts in this bundle compile and their focused behavioral tests pass.
They are not a substitute for applying the files to the exact current PR #31 head,
running the full repository gates, launching the real Windows application, and
performing provider/RLM acceptance tests.

## Verified checks

| Check | Result | Evidence |
|---|---:|---|
| Strict TypeScript compile of core contracts | PASS | `verify/tsconfig.json`; `verification/LOCAL_TEST_OUTPUT.txt` |
| Core behavioral contracts | 20/20 PASS | `verify/run-core-tests.cjs`; `verification/LOCAL_TEST_OUTPUT.txt` |
| Central turn coordinator | PASS | `app/src/lib/harness/__tests__/OpenCodeTurnCoordinator.test.ts`; `verification/LOCAL_TEST_OUTPUT.txt` |
| Picker replacement isolated TypeScript check | PASS | `verify/useAccessible-typecheck/tsconfig.json`; `verification/LOCAL_TEST_OUTPUT.txt` |
| Picker runtime grouping/deduplication | PASS | `verify/useAccessible-runtime/test.cjs`; `verification/LOCAL_TEST_OUTPUT.txt` |

## Behaviors covered by the 20 core contracts

1. Exact connection model deduplication with live metadata precedence.
2. Qualified aliases collapse without collapsing distinct API/subscription routes.
3. Obsolete Codex transport is suppressed only while authenticated OpenCode is healthy.
4. Model-specific `/effort` and `/fast` resolve from exact live variants.
5. Unsupported effort fails before any provider/session send.
6. `/effort`, `/fast`, `/performance`, and `/rlm` remain independent controls.
7. Default-on RLM stays Direct for small tasks and escalates broad cross-source work.
8. Hybrid, never-issued, stale, out-of-range, hidden, cancelled, and cross-scope pointers fail closed.
9. Credential timeout/failure preserves the last verified snapshot with redacted diagnostics.
10. Provider-scoped credential refresh merges safely; explicit successful removal is exact.
11. Concurrent sends share one runtime and one session per visible chat.
12. A late runtime start self-disposes after scope invalidation.
13. Snapshot-only, delta-only, and mixed OpenCode text events reconstruct losslessly.
14. Cancelled and superseded events cannot commit into a later turn.
15. Exact live OpenCode combined effort+Fast variants preserve model identity.
16. Agent + Full + Approve All removes eligible prompts while hard denies remain.
17. Ask + Full remains exact-request scoped, not blanket autonomous.
18. Approve All is exact-run/exact-grant and expires.
19. Requested and observed model identity mismatch is rejected.
20. The central turn coordinator consumes VibeSpace commands locally, validates controls before session startup, derives one permission profile, and dispatches only through persistent async OpenCode transport.

## Required repository gates after overlay

Run on the exact staging commit:

```text
cd app
npm run typecheck
npm test -- --run \
  src/lib/ai/catalog/canonicalModelCatalog.test.ts \
  src/lib/ai/catalog/modelVariants.test.ts \
  src/lib/ai/useAccessibleChatModels.test.ts \
  src/features/chat/runtime \
  src/features/context/rlm \
  src/lib/harness \
  src/lib/permissions
npm test -- --run
npm run build
cd src-tauri
cargo check
cargo test --lib
```

Then run `git diff --check`, formatting, secret scanning, and the repository's release
manifest gate.

## Native/provider checks still required

- Warm messages create zero new OpenCode processes.
- One persistent authenticated loopback OpenCode server per active scope.
- Exact selected and observed provider/model/variant match.
- `/fast` works only when live metadata exposes a supported fast transport.
- `/effort` exposes only exact model variants.
- Model refresh removes stale/duplicate rows without losing credentials.
- OAuth/API key refresh survives app restart.
- RLM default ON remains Direct for simple messages.
- Physical 30M-token corpus natural-language 5/5 + fresh 5/5 test.
- Hybrid/stale/out-of-range pointer tests in the production query service.
- Cancellation reaches OpenCode root, child sessions, tools, RLM worker, and context operations.
- Restart/persistence and 30-minute memory/process soak.

## Git status

No real PR commit or push was performed because the GitHub write connector became
unavailable during execution. Do not interpret this bundle's existence as a commit on
PR #31.
