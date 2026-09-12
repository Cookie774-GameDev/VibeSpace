# Build Your Own AI discovery record

Date: 2026-07-13

Baseline: `f9d2a849ade8ef14f9657ca30dfd309bfce4b60f`

This is the read-only discovery record required before broad implementation. It separates facts observed in the repository from implementation decisions.

## Repository and coordination

- VibeSpace is a Tauri 2 desktop application with a React 18, TypeScript, Vite, Zustand, Dexie, Tailwind, and Radix frontend.
- The active worktree is `C:\Users\viper\VibeSpace\.worktrees\build-your-own-ai` on `codex/build-your-own-ai`.
- Repository governance is in `AGENTS.md`; append-only ownership is in `docs/AGENT_COORDINATION.md`.
- Current concurrent work overlaps shared routing, `App.tsx`, native `lib.rs`, capabilities, Tauri configuration, terminals, account/settings, and package manifests. Initial Foundry work therefore uses new modules and a narrowly claimed Agents entry seam.
- Open PRs inspected during discovery include backend security/billing, terminal persistence, and pets work. They must be rebased or reconciled before shared integration files are edited.

## Frontend map

- `app/src/App.tsx` composes authentication, workspace startup, the application shell, and the active canvas.
- Routing is an internal Zustand `Route` union, not a URL router. A top-level route requires synchronized changes to `stores/ui.ts`, `PageRouter.tsx`, `NavPane.tsx`, and `TopBar.tsx`.
- The existing Agents surface is `app/src/features/agents/AgentManager.tsx`; it is the lowest-conflict initial entry point.
- The existing Jarvis creator builds prompt-based agent/skill drafts. It does not train model weights and must not be represented as the Foundry.
- Existing provider/model selection is centralized in `app/src/lib/ai/providerRegistry.ts`, `providerModelCatalog.ts`, and `modelSelection.ts`. Foundry deployment must register with these abstractions rather than inventing a second picker.
- Ollama is the current first-class local runtime, with loopback-only validation and native IPC in packaged builds.
- Local durability is split between Dexie repositories and guarded local storage. Raw model/dataset artifacts do not currently have a dedicated store.

## Native map

- `app/src-tauri/src/lib.rs` owns the Tauri builder, managed state, lifecycle hooks, and the centralized command handler list. It is a high-conflict integration point.
- No hardware profiler or durable Foundry job supervisor exists.
- Existing Ollama code supports readiness, list, pull, and chat, but lacks durable job snapshots and cancellation for pulls/chats.
- Existing model-download helpers have incomplete checksum and path constraints and are not safe templates for Foundry artifacts.
- The strongest local path boundary is Tauri's `app.path().app_data_dir()`. Foundry must use a fixed child tree, validated identifiers, atomic generations, and no renderer-supplied arbitrary root.
- Native background events are currently inconsistent and ephemeral. Foundry needs one stable event envelope plus snapshot reconciliation.
- No bundled training sidecar exists. A real worker must be isolated, opt-in, pinned, supervised, and packaged deliberately.

## Supabase and billing map

- Root `supabase/` is canonical. `app/supabase/` is a conflicting legacy history and must not receive new Foundry migrations.
- No Foundry project, dataset, job, model, evaluation, feedback, entitlement, usage, or audit tables exist.
- Authentication is revalidated in Edge Functions with `auth.getUser(jwt)` before service-role access. Client-persisted plan state is not an authorization source.
- Existing server plan identifiers are `free`, `starter`, `pro`, `ultra`, and `apex`.
- Existing Stripe checkout, portal, webhook, subscription, and plan primitives are reusable, but discovery found idempotency, transactional error-handling, and price-entitlement gaps that must be fixed or explicitly fenced before Foundry usage.
- Supabase must store safe metadata only. Raw examples, prompts, weights, checkpoints, and private feedback remain local unless a separately consented secure cloud feature is designed.
- CI currently omits Deno checks, Supabase reset/migration tests, SQL behavior tests, advisors, RLS/grant tests, and Edge-function tests.

## Baseline checks

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm run test:release-manifest` | Passed |
| `npm --prefix app run test` | Timed out silently at 304 seconds; no pass/fail claim |
| `npm run build` | Timed out silently at 304 seconds; no pass/fail claim |
| `cargo check --manifest-path app/src-tauri/Cargo.toml` | Timed out silently at 605 seconds; no pass/fail claim |

Windows security removed or locked `install/install.ps1` during dependency setup. Restoration returns `Permission denied`. This unrelated deletion is excluded from all Foundry commits.

## Reuse decisions

- Reuse the visual system, Radix primitives, provider registry, model picker, Ollama abstractions, authentication client, server plan identifiers, and existing Stripe surface.
- Persist real artifacts under an app-data-scoped Foundry store owned by the native layer.
- Keep a deterministic fixture backend for automated tests and unsupported hardware. Label it honestly.
- Add Foundry-specific contracts, local repository, worker protocol, supervisor, database metadata, RLS, and behavior tests as isolated modules before the narrow shared integration hunks.

## Deferred external gates

The following require explicit approval or external credentials and are not implied by implementation work: live database migration, live Edge deployment, production Stripe configuration, production checkout or charge, release signing, deployment, publishing, merging, or deleting user data.
