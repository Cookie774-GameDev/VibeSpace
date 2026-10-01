# PR-31 OpenCode/RLM Implementation Handoff

## Truthful status

`IMPLEMENTED LOCALLY — PR WRITE BLOCKED`

The authenticated GitHub write connector became unavailable before the target branch could be changed. The implementation, focused tests, guarded apply/verify/commit/push scripts, Git commit series, patch series and manifest are supplied as a deterministic handoff. Do not label the branch fixed until the apply script succeeds on the actual PR-31 worktree.

## Target

- Repository: `Cookie774-GameDev/VibeSpace`
- Pull request: `#31`
- Branch: `agent/pr30-fixes-and-updates`
- Keep PR draft.
- Do not merge, deploy, modify billing, mutate production Supabase/Stripe, or restore the protected installer deletion.

## Integrated implementation slices

### 1. Catalog and picker correctness

- connection-qualified canonical IDs;
- exact route retention for API versus subscription;
- intra-route dedupe;
- stale/unavailable duplicate suppression;
- live OpenCode priority;
- obsolete Codex CLI suppression only while modern OpenCode is healthy;
- generation-safe refresh, TTL and bounded retry;
- no verified catalog erasure on transient failure;
- explicit `refreshModels()`.

### 2. `/effort`, `/fast`, `/performance`

- model-specific live variants only;
- `Ultra -> xhigh`, `Max -> max` only when exposed;
- stale unsupported settings block before send;
- Fast uses an exact OpenCode/provider variant or exact supported service tier;
- Fast never switches model or effort;
- performance controls routing/budgets only.

### 3. Persistent OpenCode session transport

- `session.promptAsync` and SSE;
- explicit refusal of production per-turn CLI fallback;
- exact requested provider/model/variant;
- one runtime per scope, one session per chat;
- persisted session generation validation;
- single-flight startup/session creation;
- LRU warm-scope cap;
- cancellation during session creation;
- late-start and late-session leak prevention;
- lossless delta/snapshot/mixed text accumulation;
- cancelled/superseded event gate.

### 4. Credentials

- async non-destructive hydration;
- verified snapshot survives timeout/failure;
- partial provider refresh merges;
- explicit provider removal only;
- no secret values in diagnostics.

### 5. Default-on adaptive RLM

- `/rlm on|off|status|refresh|trace`;
- chat > workspace > user default resolution;
- Direct, Retrieval, and recursive RLM routes;
- high-level coordinator and bounded evidence;
- no destructive user-prompt replacement.

### 6. Pointer authority

- issue only visible completed result rows;
- exact tuple, scope, lease, source version/hash/range and repository generation;
- hybrid/forged/never-issued/stale/cancelled/cross-scope rejection;
- no range clamping;
- exact large logical positions.

### 7. Permissions

- complete 3×3 interaction/access profile;
- Ask+Full exact-request only;
- Plan+Full inspection/plan-artifact only;
- Agent+Full autonomous only inside grant;
- run-scoped Approve All;
- immutable hard denies;
- no child authority elevation.

## Apply and commit

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\APPLY_TO_PR31.ps1 -Push
```

The script fetches the exact remote PR-31 head, creates an isolated staging worktree, overlays only an explicit allowlist, runs repository gates, and verifies that every critical seam has a real production consumer. It never resets, cleans, rebases, merges, force-pushes, or touches the owner/main-agent worktree. Before pushing, it re-fetches and refuses the update if the remote head moved. It stages only listed paths and fast-forward pushes only to `agent/pr30-fixes-and-updates`.

## Validation labels

Use only:

```text
VERIFIED
IMPLEMENTED — NATIVE VERIFICATION REQUIRED
IMPLEMENTED — PROVIDER VERIFICATION REQUIRED
BLOCKED — EXTERNAL
NOT COMPLETE
```

This bundle is `IMPLEMENTED — NATIVE VERIFICATION REQUIRED` until applied and run in the actual Windows app.


## Critical integration truth

The contracts and central coordinator are source-verified, but the exact rapidly changing PR-31 Composer/router/OpenCode seams still require overlay integration and whole-repository/native verification. The guarded staging script refuses to push if the required production anchors remain definition/test-only.
