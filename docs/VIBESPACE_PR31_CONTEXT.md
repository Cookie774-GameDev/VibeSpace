# VibeSpace PR31 Context

## What VibeSpace is

VibeSpace is a local-first AI workspace and desktop IDE. The user interface is a React/TypeScript application packaged with Tauri. Native Windows behavior, terminals, tray integration, pets, lifecycle recovery, and local capabilities live in Rust under `app/src-tauri`. Cloud-facing services are isolated in `workers`, `supabase`, and `phone-jarvis`.

Primary areas:

- `app/src`: React UI, stores, chat, agents, skills, browser surfaces, files, terminals, settings, and local AI orchestration.
- `app/src-tauri`: native desktop shell, PTYs, tray, windows, watchdogs, secure native commands, and packaging.
- `workers`: Cloudflare Workers including the VibeSpace MCP gateway and AI news service.
- `supabase`: authentication, database migrations, policies, functions, and account services.
- `docs`: designs, plans, operational notes, evidence, and handoffs.

## PR31 working state

- Target branch: `agent/pr30-fixes-and-updates`
- Target worktree: `C:\Users\viper\VibeSpace\.worktrees\pr30-fixes-updates-20260802`
- PR31 contains recovered work from the dedicated PR31 worker branches plus subsequent fixes.
- The branch must not be merged, pushed, deployed, installed, or released unless the user explicitly requests that exact action.
- Recent committed work includes account/runtime recovery, browser and terminal lifecycle work, command cleanup, persistent MCP relay ownership, Worker heartbeat support, and blended Default/MonoChrome/Jarvis chat artwork.
- The VibeSpace MCP production endpoint is healthy, but the newest Worker heartbeat build was not deployed because the local Wrangler session lacks `CLOUDFLARE_API_TOKEN`.
- ChatGPT custom-app creation or refresh remains an explicit ChatGPT Developer Mode action; source code must never claim installation without verified external state.

## Current verification baseline

- Focused MCP and chat-art frontend tests: 78 passed.
- VibeSpace MCP Worker tests: 29 passed.
- Worker typecheck and Wrangler dry-run: passed.
- Rust `cargo check --locked --no-default-features --lib`: passed with existing warnings.
- A full app typecheck/build can be blocked by concurrent unfinished agent/skill/recycle-bin/news/benchmark work. Treat those failures by provenance; do not rewrite unrelated work to make a gate green.

## Non-negotiable repository rules

1. Preserve user and concurrent-agent work. Inspect status and provenance before editing.
2. Never use `git reset --hard`, `git clean`, force checkout, force push, destructive rebase, or whole-file conflict replacement.
3. Back up dirty diffs and untracked files before any risky recovery or integration.
4. Integrate confirmed PR31 work additively and resolve overlaps at the code level.
5. Do not commit unrelated, generated, global, temporary, or secret-bearing files.
6. Do not restore or commit `install/install.ps1` without separate explicit authorization.
7. Use logical, reviewable commits; run focused tests after risky changes and record blockers truthfully.
8. Do not fabricate app, account, provider, OAuth, browser, deployment, or test status.
9. Keep account identity, durable workspace ownership, runtime cloud identity, and local project grants separate.
10. Preserve least privilege: MCP/local tools are read-only unless a separately authorized capability explicitly says otherwise.
11. New agents must read `C:\Users\viper\VibeSpace\AGENTS.md`, `SYSTEM_PROMPT.md`, and `AGENT_COORDINATION.md`, obey the bounded bootstrap, and acquire a fresh exact-path lock before writing.
12. Stop on an unexplained overlapping mutation or lock conflict; do not overwrite it.

## Lock state

All historical files under `.agent-coordination.lock` were cleared on 2026-08-10 at the user's request. The retained `owner.txt` marker has `status=CLEAR`. This does not erase Git history or authorize overlapping edits. Every future writer must establish a new bounded lock.

## Useful commands

```powershell
git status --short --branch
git log --oneline -20
cd app
npm test -- --run <focused-test-files>
npm run typecheck
cd ..\workers\vibespace-mcp
npm run check
cd ..\..\app\src-tauri
cargo check --locked --no-default-features --lib
```
HEY REMBER NO QUESTIONS NO APPROVAL NEEDED OKAY YOUR USE SUPABASE STRIPE GITHUB CLOUDFLARE WHAT EVER YOU NEDED OKAY!