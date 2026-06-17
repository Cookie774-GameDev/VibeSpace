# Terminal Agent System — How It Should Work & Implementation Options

> **Audience:** VibeSpace builders, agents, and admins  
> **Repo:** `C:\Users\viper\VibeSpace`  
> **Status:** Planning / architecture reference (June 2026)

---

## 1. Target behavior (your spec)

When a user works in **Terminals**:

1. **Pick an agent** from the pane dropdown (Builder, Scout, Coder, etc.).
2. **Run any CLI** in that pane — `claude`, `opencode`, `codex`, `aider`, plain `powershell`, etc.
3. VibeSpace **automatically and silently** feeds prompts **before** the CLI starts (no paste, no modal).
4. Prompts split into two layers:

| Layer | Who controls it | Contents | User can edit? |
|-------|-----------------|----------|----------------|
| **System prompt (admin)** | VibeSpace admin / org | Immutable operating rules, safety, org policy, base agent behavior | **No** |
| **User / project prompt** | Project + agent assignment | Agent persona, skills, **full project context map**, sibling-agent activity, coordination doc pointer | Partially (agent persona yes; context map is generated) |

5. The CLI should behave as if it was **briefed on the whole project** without the user typing anything.

---

## 2. What exists today (v0.1.43)

### 2.1 UI flow ✓ (mostly)

| Piece | Location | Status |
|-------|----------|--------|
| Agent dropdown | `AgentRolePicker.tsx` on pane toolbar | **Works** — sets `agentSlug` on pane |
| Default CLI per agent | `TerminalsPage.commandForAgent()` | **Partial** — only `coder → claude`; most agents have no default |
| Pane + session binding | `TileGrid.tsx`, `TerminalView.tsx`, `transcriptStore.ts` | **Works** |

### 2.2 Prompt delivery ✓ (foundation in place)

Implemented in **`agentPromptDelivery.ts`**, called from **`TerminalView.tsx`** before PTY spawn.

**Delivery channels today:**

1. **`AGENTS.md`** in the pane working directory — managed block between HTML comment markers (user content outside markers is preserved).
2. **Environment variables** on the PTY — `JARVIS_AGENT_SLUG`, `JARVIS_AGENT_NAME`, etc.
3. **`.jarvis-coordination.md`** — shared scratchpad for multi-agent claims (created once, never overwritten by VibeSpace).

**Briefing composition today (inside managed block):**

```
1. Agent name + slug
2. Per-agent instructions (Agent.system_prompt + skills)     ← USER-EDITABLE today
3. BASE_TERMINAL_AGENT_RULES (hardcoded in code)             ← partial admin layer
4. Project context blob (Project.system_prompt_context)      ← user/project editable
5. Context map summary (bounded to 4 KB)                     ← generated, truncated
6. Other agents' live terminal activity
7. Pointer to coordination document
```

### 2.3 Gaps vs your spec

| Your requirement | Current reality |
|------------------|-----------------|
| Admin-only system prompt | `Agent.system_prompt` is editable in Agent Manager; only `BASE_TERMINAL_AGENT_RULES` is code-locked |
| Full context map | Summarized and capped at **4,000 chars** (not full tree) |
| Works with every CLI | Only CLIs that **read `AGENTS.md`** (or env wrappers) on session start |
| Fully silent / automatic | Delivery runs before spawn ✓ — but **CLI must restart** to pick up agent switch mid-session |
| System vs user prompt separation | Both merged into one `AGENTS.md` block — CLIs don't get a true API-level system channel |

---

## 3. How CLIs actually consume instructions

| CLI / tool | Primary instruction surface | Native system prompt API? |
|------------|---------------------------|---------------------------|
| **OpenCode** | `AGENTS.md` in cwd | No — reads markdown file |
| **Claude Code** | `CLAUDE.md` / project docs | Limited; project files at start |
| **Codex CLI** | `AGENTS.md` / config | Varies by version |
| **Cursor Agent** | `.cursor/rules`, `AGENTS.md` | Rules files |
| **Aider** | `.aider.conf.yml`, conventions | `--read` files |
| **Plain shell** | None unless wrapper | No |

**Implication:** There is no universal "inject system prompt into API" hook for arbitrary terminal binaries. The portable approach is **files + env + wrapper scripts**.

---

## 4. Architecture options

### Option A — Harden current `AGENTS.md` pipeline (fastest)

**What:** Keep `deliverAgentTerminalContext`, split briefing into admin vs user sections, write multiple files.

| Pros | Cons |
|------|------|
| Already 80% built | Still file-convention dependent |
| Silent, pre-spawn | 4 KB context map cap unless raised |
| Works offline | Claude may prefer `CLAUDE.md` not `AGENTS.md` |
| ~1–3 days to harden | Mid-session agent switch needs CLI restart |

**Changes:**
- Add `ADMIN_TERMINAL_SYSTEM_PROMPT` (bundled JSON or Supabase `org_settings`) — **never** exposed in Agent Manager UI.
- Refactor `composeAgentBriefing()`:
  - `## Admin system rules` ← immutable server/bundle
  - `## Agent persona` ← user-editable slug prompt
  - `## Project context map` ← full tree or tiered (see Option E)
- Write **symlinked or duplicated** instruction files: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/vibespace-agent.mdc` (same managed block).
- Raise or tier context map budgets (4K → 32K with summarization fallback).

**Best for:** Shipping in days while staying compatible with OpenCode + most agents.

---

### Option B — CLI wrapper launcher (most reliable per CLI)

**What:** VibeSpace spawns `vibespace-run <agent-slug> <cli> [args]` instead of raw `claude` / `opencode`.

```
vibespace-run builder opencode
  → writes instruction files
  → sets env
  → exec opencode with CLI-specific flags if available
```

| Pros | Cons |
|------|------|
| Per-CLI optimization | Must maintain wrapper matrix |
| Can pass `--system-prompt` where supported | Extra binary/script in PATH |
| Hides complexity from user | Slightly slower spawn (~100ms) |

**CLI-specific examples:**
- OpenCode: ensure cwd has `AGENTS.md` before exec.
- Claude Code: write `CLAUDE.md` + `/.claude/settings` if needed.
- Codex: env `OPENAI_*` + instruction file.

**Best for:** "It just works" across 3–5 named CLIs you officially support.

---

### Option C — Remote admin prompt via Supabase (true admin control)

**What:** Store immutable system prompt in cloud; app fetches on terminal spawn.

```
org_terminal_system_prompt (table)
  org_id, version, prompt_text, updated_at, signature
```

| Pros | Cons |
|------|------|
| Admin updates without app release | Requires network |
| Auditable versions | Offline mode needs cached fallback |
| Org-wide policy | More infra |

**Flow:**
1. `deliverAgentTerminalContext` fetches admin prompt (cache 1h in IndexedDB).
2. Merge: `adminPrompt + agentPersona + contextMap`.
3. User cannot override admin block in UI (read-only in settings for non-admins).

**Best for:** Multi-tenant / team deployments where policy must be centralized.

---

### Option D — MCP instruction server (advanced)

**What:** Local MCP server exposes `get_agent_briefing(slug)`; CLIs with MCP support pull live context.

| Pros | Cons |
|------|------|
| Live updates mid-session possible | Not all CLIs support MCP |
| Clean separation | Heavy setup |
| Good for OpenCode MCP plugins | Another process to manage |

**Best for:** Power users running MCP-enabled agent stacks.

---

### Option E — Tiered context map (solve "full project context")

**What:** Don't dump 500 KB tree into `AGENTS.md`. Use tiers:

| Tier | Size | When injected |
|------|------|---------------|
| **L0** | ~2 KB | Always — project summary + top-level map nodes |
| **L1** | ~8 KB | On agent spawn — module summaries for assigned area |
| **L2** | On demand | CLI reads `/.vibespace/context/<path>.md` via instruction: "use Read tool on …" |

| Pros | Cons |
|------|------|
| Feels "full project" without token blow-up | Requires context tree maintenance |
| Fast spawn | L2 needs capable CLI |
| Scales to monorepos | More files in cwd |

**Best for:** Large repos where full map exceeds any CLI's instruction budget.

---

### Option F — PTY input injection (not recommended)

**What:** Paste system prompt into terminal after spawn.

| Pros | Cons |
|------|------|
| Works on dumb shells | **Visible**, fragile, breaks TUI |
| | Race with CLI init |
| | User sees prompt flash |

**Verdict:** ❌ Conflicts with "silent background" requirement.

---

## 5. Recommended path (pragmatic)

### Phase 1 — Quick win (1 week)

**Option A + B lite**

1. Split **admin system prompt** (bundled `app/src/config/adminTerminalSystemPrompt.ts` or fetched from Supabase later).
2. Lock admin block: remove from Agent Manager; show read-only in Settings → Admin.
3. Multi-file delivery: `AGENTS.md` + `CLAUDE.md` (+ markers in both).
4. Expand context map budget: 4K → 16K with smart `summarizeContextTree()`.
5. Map all preset agents to default CLIs in `commandForAgent()`:

| Agent slug | Suggested default CLI |
|------------|----------------------|
| builder / coder | `claude` |
| scout / researcher | `opencode` |
| reviewer / critic | `opencode` |
| jarvis | `opencode` or shell |

6. Auto-run delivery on: agent pick, pane create, project switch, context map regen.

### Phase 2 — Admin cloud + scale (2–3 weeks)

**Option C + E**

1. Supabase `org_settings.terminal_system_prompt_v1`.
2. Tiered context map files under `.vibespace/context/`.
3. `vibespace-run` wrapper registered in PATH on install.

### Phase 3 — Polish

1. Mid-session agent switch → toast: "Restart CLI to load new briefing" (or kill+respawn optional).
2. Telemetry: delivery success, file sizes, CLI read confirmation.
3. Align with `docs/AGENT_COORDINATION.md` (repo-level) vs `.jarvis-coordination.md` (project-level).

---

## 6. Prompt layering model (target)

```
┌─────────────────────────────────────────────────────────┐
│  ADMIN SYSTEM PROMPT (immutable)                        │
│  - org policy, safety, VibeSpace terminal rules         │
│  - source: bundle or Supabase                           │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  AGENT PERSONA (per slug, user-editable)               │
│  - Builder / Scout / Reviewer behavior                  │
│  - skills addenda                                       │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  PROJECT USER PROMPT                                    │
│  - system_prompt_context (project settings)             │
│  - context map (L0 + L1 tiers)                          │
│  - sibling agent activity snapshot                      │
│  - coordination doc path                                │
└─────────────────────────────────────────────────────────┘
                          ↓
              Written to AGENTS.md / CLAUDE.md
              + env vars on PTY spawn
```

---

## 7. Key code paths (for agents implementing this)

| Concern | File |
|---------|------|
| Agent dropdown | `app/src/features/terminals/AgentRolePicker.tsx` |
| Prompt compose + write | `app/src/features/terminals/agentPromptDelivery.ts` |
| Spawn + delivery timing | `app/src/features/terminals/TerminalView.tsx` |
| Default CLI mapping | `app/src/features/terminals/TerminalsPage.tsx` → `commandForAgent` |
| Context map load | `app/src/features/context/tree.ts` → `loadStoredContextTree` |
| Agent definitions | `app/src/stores/agents.ts`, `app/src/features/agents/registry.ts` |
| Transcript / sibling awareness | `app/src/features/terminals/transcriptStore.ts` |
| Tests | `app/src/features/terminals/agentPromptDelivery.test.ts` |

---

## 8. FAQ

**Q: Can we force the CLI's internal system prompt API?**  
A: Only per-CLI. Universal approach = instruction files at cwd before exec.

**Q: Will switching agents mid-session update the CLI?**  
A: Not today. `AGENTS.md` is rewritten, but OpenCode/Claude read instructions at session start. User must restart the CLI (or we auto-respawn — optional aggressive mode).

**Q: Is delivery truly silent?**  
A: Yes — file writes happen before `terminal_spawn`. No PTY paste. User sees nothing unless delivery fails (console warn).

**Q: How does this relate to `docs/AGENT_COORDINATION.md`?**  
A: **Repo-level** ledger for Cursor agents working on VibeSpace itself. **`.jarvis-coordination.md`** is **per-project** for terminal CLIs working in the user's repo. Both serve coordination; different scope.

---

## 9. Decision summary

| Priority | Recommendation |
|----------|----------------|
| **Fastest path to "it works"** | Option **A** — harden existing `agentPromptDelivery` |
| **Best cross-CLI reliability** | Option **A + B** — multi-file + wrapper |
| **True admin-only system prompt** | Option **C** — Supabase-backed immutable prompt |
| **Large monorepos** | Option **E** — tiered context map |
| **Avoid** | Option **F** — PTY paste |

---

*Last updated: 2026-06-17 · VibeSpace v0.1.43*
