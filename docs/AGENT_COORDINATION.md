# VibeSpace — Agent Coordination Ledger

> **Single source of truth for multi-agent Cursor work.**  
> **Repo:** `C:\Users\viper\VibeSpace`  
> **Rule:** `.cursor/rules/agent-coordination.mdc` (always applied)

---

## Purpose

Prevent five concurrent Cursor agents from overwriting, reverting, or force-pushing each other's in-progress work. This document is the **coordination ledger**: read it before every task; update it after planning and after every significant action (commit, release, lock change).

---

## Rules

1. **Read first** — Open this file before any code change, commit, push, or release.
2. **Update after** — Append a work-log entry after planning and again after commit/release (or when abandoning work).
3. **Claim before edit** — Add rows to **File ownership / lock table** before touching shared areas.
4. **Never force-push** over another agent's in-progress branch or version without explicit user approval.
5. **Never revert** another agent's committed features without explicit user approval.
6. **One version target** — All agents work toward **Active version target** below unless the user directs otherwise.
7. **Release gate** — On "commit and push to next version", run the full verified release pipeline; **block publish on any error** (see [Release checklist](#release-checklist-reference)).
8. **Append-only log** — Do not delete or rewrite past work-log entries; add corrections as new entries.

---

## Active version target

| Field | Value |
|-------|-------|
| **Current released** | **v0.1.43** (2026-06-16) |
| **Next target** | **v0.1.44** (unstarted) |
| **Release channel** | `releases/channel.json` → GitHub Releases |
| **Branch convention** | `main` for releases; feature branches optional with ledger note |

---

## Agent registry

| Agent | Role | Primary duties |
|-------|------|----------------|
| **VibeSpace Helper** | Coordinator / release | Commits, pushes, releases, Q&A, ledger upkeep, conflict resolution |
| **VibeSpace Main** | Primary development | Major fixes, architecture, cross-cutting refactors |
| **VibeSpace Worker 1** | Feature worker | Fixes, updates, isolated features |
| **VibeSpace Worker 2** | Feature worker | Fixes, updates, isolated features (parallel to Worker 1) |
| **VibeSpace Tester** | Cloud QA (read-only) | Run actual app, report pass/fail — **no commit/push/edits** |

**Division of labor:** Main owns broad design; Workers 1/2 own scoped tasks; Helper owns git/release/coordination; Tester validates only.

**Live dashboard:** Open `agent-command-center.canvas.tsx` in Cursor Glass (Agent Command Center).

## Live status board (2026-06-17 — corrected)

| Agent | Status | Current task | Conflict? |
|-------|--------|--------------|-----------|
| **VibeSpace Helper** | **Active** | Live board, coordination ledger, releases when asked | No |
| **VibeSpace Main** | **Active** | URGENT 4-fix terminal pass (distortion, white screen, scrollback, APPLE prompt) | **Yes** — vs Worker 1 on agent prompts |
| **VibeSpace Worker 1** | **Active** | URGENT provider/model dropdown registry (Hive screenshot — no manual Model ID) | **Yes** — vs Worker 2 on `lib/ai/**`, `auth.ts`, `Hive.tsx` |
| **VibeSpace Worker 2** | **Active** | Hands-free voice turn-taking + URGENT model selection persistence | **Yes** — vs Worker 1 on `lib/ai/**`, `auth.ts`; overwrites own StackPicker |
| **VibeSpace Tester** | Standby | Cloud read-only QA — not running now | No |

**4 of 5 agents active.** Tester is the idle 5th.

### Active conflicts (needs your decision)

1. **CRITICAL — Worker 1 ↔ Worker 2** — Both edit `lib/ai/**` (providerRegistry vs modelSelection), `stores/auth.ts`, `Hive.tsx` with **no ledger locks**.
2. **HIGH — Main ↔ Worker 1** — `agentPromptDelivery.ts` (terminals) vs `AgentManager.tsx` (agents UI) — APPLE test alignment.
3. **HIGH — install.ps1 deleted** — `install/install.ps1` deleted locally; `install_new.ps1` untracked — v0.1.43 UTF-8 installer at risk.
4. **HIGH — Worker 2 router rewrite** — `router.ts` −138 lines — may break v0.1.43 chat routing.
5. **MEDIUM — Ledger unused** — Only Main claimed locks; Workers never claimed before editing.

---

## Current work log

Append new entries at the **bottom** of the relevant agent section. Use [How to update this doc](#how-to-update-this-doc).

### VibeSpace Helper

#### 2026-06-16 — UTF-8 install.ps1 hotfix + testing guide

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-16 (post v0.1.43 release) |
| **Version** | v0.1.43 (docs/install follow-up) |
| **Plan** | Restore UTF-8-safe `install/install.ps1`; add agent QA documentation |
| **Files touched** | `install/install.ps1`, `docs/AGENT_TESTING_GUIDE.md` |
| **Status** | committed |
| **Commit** | `023a69a` — `fix: restore UTF-8 install.ps1 and add agent testing guide` |

#### 2026-06-17 — Promote updater channel to v0.1.43

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.43 (channel promote) |
| **Plan** | Push `releases/channel.json` 0.1.42 → 0.1.43; archive manifest |
| **Files touched** | `releases/channel.json`, `releases/manifests/v0.1.43.json` |
| **Status** | committed + pushed |
| **Commit** | `484dfc8` — `Promote in-app updater channel to v0.1.43.` |

---

### VibeSpace Main

#### 2026-06-16 — v0.1.43 release (primary dev)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-16 |
| **Version** | v0.1.43 |
| **Plan** | Composer STT, workspace flush, Hive polish, voice/terminal improvements, version bump |
| **Files touched** | See **Committed this version** (92 files in release commit) |
| **Status** | released |
| **Commit** | `36fdbe5` — `Release v0.1.43: Composer STT, workspace flush, and Hive polish.` |

#### 2026-06-17 — Terminal production reliability pass

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 10:35 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Fix terminal route-switch distortion, white fallback risk, scrollback isolation, and terminal-agent prompt delivery |
| **Files touched** | `app/src/features/terminals/**`, `app/src/components/layout/PageRouter.tsx`, `docs/AGENT_COORDINATION.md` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-17 — Terminal reliability follow-up from trace agents

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 11:28 AM CT |
| **Version** | v0.1.44 |
| **Plan** | Add explicit terminal refits after layout transitions, WebGL context-loss recovery, Gemini instruction-file delivery, and CLI defaults for terminal agent panes |
| **Files touched** | `app/src/features/terminals/TileGrid.tsx`, `TileGrid.refit.test.tsx`, `TerminalView.tsx`, `TerminalsPage.tsx`, `TerminalsPage.command.test.ts`, `agentPromptDelivery.ts`, `agentPromptDelivery.test.ts`, `docs/AGENT_COORDINATION.md` |
| **Status** | in-progress |
| **Commit** | — |

---

### VibeSpace Worker 1

#### 2026-06-17 — Provider/model dropdown registry (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | Replace manual Model ID typing with provider-aware dropdowns; providerRegistry; API-key gating; Hive screenshot fix |
| **Files touched** | `app/src/lib/ai/providerRegistry.ts`, `providerModelCatalog.ts`, `useProviderModelOptions.ts`, `app/src/components/ai/ProviderModelSelect.tsx`, `Hive.tsx`, `Providers.tsx`, `AgentManager.tsx`, `AgentDetail.tsx` |
| **Status** | in-progress |
| **Commit** | — |

---

### VibeSpace Worker 2

#### 2026-06-17 — Hands-free voice + model selection persistence (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | voiceTurnCommit for hands-free turn-taking; model selection state persistence; no fake defaults |
| **Files touched** | `app/src/features/voice/voiceTurnCommit.ts`, `VoiceModal.tsx`, `Voice.tsx`, `app/src/lib/ai/modelSelection.ts`, `router.ts`, `runtime.ts`, `stores/auth.ts`, `Composer.tsx`, `StackPicker.tsx` |
| **Status** | in-progress |
| **Commit** | — |

#### 2026-06-17 — Voice module close + hands-free setting respect (URGENT)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.44 |
| **Plan** | Instant speech stop on voice module close; session invalidation; wake word only in hands-free mode |
| **Files touched** | `voiceRouter.ts`, `streamingVoice.ts`, `WakeWordHost.tsx`, `wakeWord.ts`, `ui.ts`, `App.tsx`, `VoiceModal.tsx`, `runtime.ts`, tests |
| **Status** | committed (tests passing) |
| **Commit** | — |

---

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-16 |
| **Version** | v0.1.43 |
| **Plan** | Persist workspace/terminal on hide/shutdown/update; StackPicker UI; Hive preset/benchmark polish |
| **Files touched** | `app/src/lib/persistence/workspaceFlush.ts`, `app/src/features/chat/StackPicker.tsx`, `app/src/lib/ai/stacks/**`, `docs/HIVE_PIPELINE_SIMULATION_TIERS.md`, `docs/TERMINAL_PERSISTENCE_SHUTDOWN_UPDATE_TRAY.md` |
| **Status** | committed (in `36fdbe5`) |
| **Commit** | `36fdbe5` |

---

### VibeSpace Tester

#### 2026-06-17 — Cloud QA (read-only)

| Field | Value |
|-------|-------|
| **Timestamp** | 2026-06-17 |
| **Version** | v0.1.43+ |
| **Plan** | Validate app behavior via `npm run jarvis` or installed build — report only |
| **Files touched** | None (no edits) |
| **Status** | standby |
| **Commit** | — |

---

## File ownership / lock table

> **Current v0.1.44:** No active locks. Claim rows before editing.

| Path / area | Owner agent | Version | Status | Notes |
|-------------|-------------|---------|--------|-------|
| `app/src/features/terminals/**` | VibeSpace Main | v0.1.44 | in-progress | Urgent terminal stability, scrollback isolation, agent prompt delivery |
| `app/src/components/layout/PageRouter.tsx` | VibeSpace Main | v0.1.44 | in-progress | Keep terminal surfaces stable across route switches |
| `docs/AGENT_COORDINATION.md` | VibeSpace Main | v0.1.44 | in-progress | Coordination ledger for terminal reliability fix |
| `app/src/features/voice/voiceRouter.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Voice module lifecycle + instant speech stop on close |
| `app/src/features/voice/streamingVoice.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Session-gated streaming TTS; no zombie playback |
| `app/src/features/voice/WakeWordHost.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Gate wake word on hands-free mode only |
| `app/src/features/voice/wakeWord.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | `isWakeWordAutoOpenAllowed` helper |
| `app/src/stores/ui.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Sync voice open/close with lifecycle |
| `app/src/App.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | VoiceModuleLifecycle backup sync |
| `app/src/features/voice/VoiceModal.tsx` | VibeSpace Worker 2 | v0.1.44 | in-progress | Close button instant stop |
| `app/src/lib/ai/runtime.ts` | VibeSpace Worker 2 | v0.1.44 | in-progress | Skip speech deltas when module closed |

**Unclaimed dirty paths (CRITICAL — Worker 1 + Worker 2 both editing):** `app/src/lib/ai/**`, `app/src/stores/auth.ts`, `app/src/features/settings/sections/Hive.tsx`, `app/src/features/agents/**` (Worker 1 + Main overlap)

**How to claim:** Add a row with `Status: in-progress` before editing. Remove or set `Status: committed` after merge/commit.

---

## Committed this version (v0.1.43)

Do **not** revert or overwrite without user approval.

| Feature / area | Key paths | Commit(s) |
|----------------|-----------|-----------|
| **Composer STT** | `app/src/features/composer-stt/**`, `app/src-tauri/src/faster_whisper.rs`, Settings → Composer STT | `36fdbe5` |
| **Workspace flush** | `app/src/lib/persistence/workspaceFlush.ts`, tray/shutdown hooks in `App.tsx` | `36fdbe5` |
| **Hive StackPicker + polish** | `app/src/features/chat/StackPicker.tsx`, `app/src/lib/ai/stacks/**`, `supabase/functions/stack-complete/` | `36fdbe5` |
| **Voice / terminal improvements** | `app/src/features/voice/**`, `app/src/features/terminals/**` | `36fdbe5` |
| **Local models expansion** | `app/src/features/settings/sections/LocalModels.tsx`, `app/src/lib/ai/localModelCatalog.ts` | `36fdbe5` |
| **UTF-8 install.ps1 fix** | `install/install.ps1` | `36fdbe5`, `023a69a` |
| **Agent testing guide** | `docs/AGENT_TESTING_GUIDE.md` | `023a69a` |
| **Release metadata** | `CHANGELOG.md`, `releases/RELEASE_NOTES_0.1.43.md`, version bumps in `package.json`, `app/package.json`, `tauri.conf.json`, `Cargo.toml` | `36fdbe5` |

**Release commits:** `36fdbe5`, `023a69a`

---

## Blocked / do-not-touch

| Item | Reason | Owner | Until |
|------|--------|-------|-------|
| *(none active)* | — | — | — |

### Known issues (not locks — coordinate before fixing)

| Issue | Notes |
|-------|-------|
| **`install/install.ps1` OS path lock on Windows** | UTF-8 rewrite landed in `023a69a`; Windows may still lock the script path during silent install or `irm \| iex`. Test with `docs/09-jarvis-calling-account-release.md` §6 smoke test before changing installer behavior. |

---

## Release checklist reference

Run **all** steps before tagging/pushing a new version. **Stop and fix on any failure** — do not publish.

| Step | Command / doc |
|------|----------------|
| Typecheck | `npm run typecheck` |
| Unit tests | `npm --prefix app run test` |
| Production build | `npm run build` |
| Release manifest | `npm run test:release-manifest` |
| Rust compile | `cd app/src-tauri && cargo check --release` |
| Windows release | `npm run release:windows` then `npm run release:stage` |
| UTF-8 installer | Verify `install/install.ps1` is UTF-8 (no BOM issues); smoke: `docs/09-jarvis-calling-account-release.md` §6 |
| Version bump | `package.json`, `app/package.json`, `app/src-tauri/Cargo.toml`, `tauri.conf.json`, `releases.ts`, `CHANGELOG.md`, release notes |
| Signing | `TAURI_SIGNING_*`, Authenticode per `docs/09-jarvis-calling-account-release.md` §6 |
| Pre-publish gate | `docs/09-jarvis-calling-account-release.md` §7 Verification checklist |
| QA reference | `docs/AGENT_TESTING_GUIDE.md` §7 Test Commands |

**Helper agent** owns running this pipeline on "commit and push to next version" requests.

---

## How to update this doc

### 1. Work-log entry (after planning or commit)

Add a new `####` subsection under the agent's **Current work log** section:

```markdown
#### YYYY-MM-DD — Short task title

| Field | Value |
|-------|-------|
| **Timestamp** | ISO or date |
| **Version** | v0.1.44 |
| **Plan** | One-line summary |
| **Files touched** | `path/a`, `path/b` or directory globs |
| **Status** | in-progress \| committed \| released \| abandoned |
| **Commit** | `abc1234` or — |
```

### 2. File lock (before editing)

Add a row to **File ownership / lock table**. Update **Status** when done.

### 3. New committed feature (after merge)

Add a row to **Committed this version** for the active target version.

### 4. Block another agent

Add a row to **Blocked / do-not-touch** with owner and expected completion.

### 5. Version bump

Update **Active version target**, roll **Committed this version** into CHANGELOG (already done in git), and start a fresh committed table for the new version.

---

*Maintained by all four agents. Last seeded: 2026-06-16 — v0.1.43 (`36fdbe5`, `023a69a`).*
