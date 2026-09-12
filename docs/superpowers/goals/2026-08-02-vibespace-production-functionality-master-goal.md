# VibeSpace Production Functionality Master Goal

**Goal ID:** `VS-PR31-PRODUCTION-FUNCTIONALITY-20260802`
**Repository:** `Cookie774-GameDev/VibeSpace`
**Target branch:** `agent/pr30-fixes-and-updates`
**Target PR:** `#31`
**Priority:** Production-blocking functionality and truthful system state
**Execution mode:** Plan once, quickly; implement immediately; verify continuously; do not wait for approval between slices

## Mission

Turn the existing VibeSpace settings, provider, voice, local-model, plugin, usage, assistant, and context systems from partially wired or misleading surfaces into a connected, production-ready product.

This is not permission for an unrelated whole-app redesign. Preserve the current product structure and every working feature. Make only the visual changes required to make the affected systems clear, compact, theme-consistent, and truthful. Most work is backend/runtime integration, state correctness, error handling, persistence, and verification.

The implementation must never show a connection, quota, hardware capability, downloaded model, training option, or completed action unless the underlying system has verified it.

## Required operating method

1. Read `AGENTS.md` and the companion design, skills, implementation-plan, and usage-module specifications before editing.
2. Perform one fast reconnaissance pass. Identify the existing stores, Tauri commands, provider registry, settings persistence, keychain boundaries, request lifecycle, voice pipeline, local-model manager, plugin authorization system, and context-map implementation.
3. Write a compact slice map and file lock list in the repository's existing coordination files. Do not spend a long phase planning.
4. Implement independent slices in parallel only when their files and state contracts do not conflict.
5. Add focused regression coverage with each behavioral correction.
6. Run browser visualization after each coherent UI/runtime boundary. Native-only behavior must also be tested in the Tauri app.
7. Finish with the required repository checks, a short performance pass, and an honest evidence report.
8. Do not merge, deploy, publish a release, change live billing, or expose production secrets unless separately authorized.

## Global truth and safety rules

- No fabricated usage, quota, balance, connection, model availability, hardware result, download state, or training capability.
- No raw provider key, OAuth token, CLI credential, authorization header, phone secret, or user data may enter the frontend, logs, screenshots, fixtures, or documentation.
- Browser preview must clearly distinguish browser-supported behavior from desktop-only behavior.
- A disabled or unavailable capability must say why and provide the next valid action.
- One broken provider or subsystem must never crash the settings dialog, chat composer, usage module, or another provider.
- Preserve account isolation, authorization, billing, updater, terminal execution, and external-action approval boundaries.
- Avoid duplicate authentication systems. Reuse the canonical provider/plugin/account registry and secure credential store.
- Do not silently fall back to another paid provider when a selected connection fails.
- Do not claim an external integration was tested unless it was actually exercised.

## Workstream 1 — AI Connections: one provider family, two connection modes

### Required experience

Replace duplicate-looking entries such as OpenAI/Codex, Anthropic/Claude Code, or repeated Gemini variants with one provider-family surface whenever they represent the same model family.

Each provider-family card must expose the supported connection modes inside one place:

- **API key / OAuth cloud connection**
- **CLI subscription bridge**
- **Local runtime**, when genuinely supported

Use a clear segmented control or switch for the active route. The user chooses the exact route; the runtime persists it per provider family and per chat where the existing model-routing contract requires it.

### Functional requirements

- Correctly detect installed and authenticated Codex, Claude Code, Gemini, Copilot, OpenCode, Qwen, and other supported CLIs without scraping unrelated shell history.
- A detected executable is not automatically an authenticated session. Report executable, authentication, compatibility, and health separately.
- `Configure`, `Connect`, `Reconnect`, `Use`, `Test`, and `Disconnect` controls must perform real actions and return bounded, actionable status.
- Fix false `Error` states for valid CLI subscription bridges.
- Preserve exact selected-route behavior with no unapproved fallback.
- Migrate old duplicate preferences to the new family-and-mode contract without losing valid keys or selections.
- Add regression coverage for duplicate migration, CLI detection, authenticated/unauthed states, active-mode persistence, route isolation, cancellation, and no-fallback behavior.

## Workstream 2 — Plugins and connectors: OAuth-first where supported

### Required experience

For services that provide a supported OAuth or app-authorization flow, `Connect` must open the provider's real sign-in and authorization experience instead of asking ordinary users to manually paste IDs, tokens, URLs, or secrets.

Priority integrations include Supabase, GitHub, Figma, Slack, Google services, Notion, and other catalog entries that officially support an app authorization flow.

### Functional requirements

- Use PKCE, state, nonce, callback validation, bounded timeouts, and secure token storage where applicable.
- Open the system browser or approved embedded authorization path; never collect provider passwords inside VibeSpace.
- Keep manual credential entry only for providers that genuinely require it or for an explicit advanced/self-hosted mode.
- Explain required provider-side setup only when an OAuth app/client must be provisioned; never present an impossible one-click flow.
- `Connect` must lead to a real action, not a dead button.
- `Disconnect` must revoke or delete stored authorization according to provider capability and clear local state.
- Add tests for callback validation, canceled flows, expired state, duplicate callbacks, disconnected state, token redaction, and account isolation.

## Workstream 3 — Providers, Deepgram, and truthful usage

- Deepgram must not show estimated or recorded usage when no key is connected and no request occurred.
- The default empty state is `No usage recorded this month` or an equally direct truthful message.
- Connected styling, including the approved outer-rim effect, must derive from verified connection state and remain theme-aware.
- Deepgram key validation must use a safe, minimal supported probe or first real request; failures must distinguish network, invalid key, permission, rate limit, and service outage where evidence permits.
- Never send a desktop BYOK credential to the hosted call backend.
- Reuse the same secure key and canonical connection state across Providers, Speech to Text, Voice, and Phone & Voice without asking for the same key twice.
- Usage accounting must use real metering events and authoritative provider data. Local/BYOK services must not be presented as consuming VibeSpace company credits.

## Workstream 4 — Taskbar AI usage module: make the enabled feature actually exist

The existing setting cannot remain a decorative toggle. Implement the full module described in `docs/ideas/TASKBAR_AI_USAGE_MODULE.md`.

Minimum production requirements:

- Enabling the setting immediately creates or reveals one single taskbar-adjacent module window.
- Disabling it closes the module and stops its timers/subscriptions.
- Restore enabled state, monitor, taskbar edge, offset, provider order, and hidden providers after restart.
- Never allow an enabled-but-invisible state. Detect off-screen placement, invalid monitor IDs, stale window handles, and creation failures; recover to a safe visible default and show an actionable error.
- The module adapts to every VibeSpace appearance through shared semantic theme tokens, not hardcoded theme copies.
- The normal panel remains tiny and shows only the user-ranked top two providers, with thicker compact bars and stable typography.
- Local request activity updates from shared events immediately. Aggregate snapshots are reconciled at least every five seconds while enabled. Remote quota polling must respect provider limits, caching, jitter, deduplication, and backoff.
- Support at least thirty provider families through a data-driven adapter registry, while honestly marking quota unavailable when no supported endpoint exists.
- No setup duplication: automatically use already connected keys, OAuth accounts, CLI sessions, local runtimes, and request events.
- One provider failure must not affect the panel or other providers.
- Meet the performance and acceptance budgets in the dedicated specification.

## Workstream 5 — Pet context menu dismissal

- Right-clicking the pet opens exactly one mini panel.
- Pointer down outside, `Escape`, route change, window blur, and opening another context menu close it.
- Interacting inside the panel must not close it before the selected action runs.
- Clean up global listeners when the host unmounts; no duplicated handlers after repeated opening.
- Preserve pet motion, transparent-window behavior, and existing visual design.

## Workstream 6 — Voice identity, default voice, hands-free, and composer microphone

### Canonical identity

The selected assistant profile is the source of truth everywhere. When Jarvis is selected, labels and wake phrases use Jarvis. When Friday is selected, labels and wake phrases use Friday. Remove hardcoded `Ask Friday`, `Hey Jarvis`, or equivalent strings from shared behavior.

### Default voice

- Set the supported paid-plan **Jarvis High** voice as the new eligible default.
- Preserve a safe fallback chain for users without entitlement, connectivity, or model availability, but never silently label a fallback as Jarvis High.
- Stop using the old Kokoro voice when the active settings and entitlement select Jarvis High.
- Keep local/offline voices available as explicit options.

### Hands-free and click-to-talk

- Wake-word detection, `send it` finalization, silence handling, cancellation, interruption, and selected-assistant phrases must work end to end.
- Fix the bug where the chat microphone stops after approximately three seconds or only works when hands-free is disabled.
- Hands-free and click-to-talk must use separate, explicit state machines and microphone ownership. They must not fight over one media stream.
- Surface permission denied, no input device, capture interruption, provider error, and transcription timeout distinctly.
- Deepgram STT/TTS must use the canonical connection state and work after a valid key is connected.
- Add deterministic tests around microphone ownership, wake phrase routing, automatic stop rules, send phrase, abort, retries, and selected-assistant changes.

## Workstream 7 — Authentication timing

Do not force sign-in or sign-up merely to download, install, or open the basic local-first application.

- Prompt for authentication only when a user begins a capability that actually requires an account, cloud persistence, hosted credits, protected entitlement, or a remote service.
- Preserve production access controls for paid/cloud-only features.
- Local settings, supported local models, local files, appearance, and other approved local-first surfaces remain reachable before authentication.
- Use one reusable auth gate that can resume the requested action after successful sign-in.
- Add signed-out cold-start and gated-action regression coverage.

## Workstream 8 — Local models and Speech to Text

### Simplify without hiding truth

Reduce excessive catalog copy. Each model row should prioritize name, provider, size, language/capability, hardware fit, runtime state, and one clear action. Secondary details belong in an expandable details surface.

### Real lifecycle operations

- **Download:** resumable, checksum-verified, cancelable, atomic finalization, disk-space reservation, and cleanup after failure.
- **Verify:** check expected files, size, checksum/manifest, runtime compatibility, and report the exact failed item.
- **Repair:** calculate required additional space accurately; redownload only missing/corrupt artifacts where possible.
- **Update:** compare installed manifest/version to catalog, download safely, preserve rollback until verification passes.
- **Remove:** stop active use safely, delete the actual model files, clean metadata, and report reclaimed space.

Fix model controls that currently appear to work but do nothing. Do not show `Downloaded`, `Ready`, or `Selected` unless the runtime can resolve the model path and load it.

Speech-to-text model downloads, including supported Whisper/faster-whisper entries, must work in the installed app. Browser preview must explain desktop-only download/runtime limits rather than leaving dead controls.

## Workstream 9 — Phone & Voice and contacts

- Reduce the page to clear setup state, connection state, caller identity, default user number, contacts, call controls, and recent jobs.
- Add a contacts system with name, description, profile picture, phone number, validation, search, edit, and delete.
- The user's verified phone number is the default personal contact/caller target where appropriate.
- Jarvis must be able to call any user-approved valid number, business, or restaurant through the existing action-approval and telephony policy—not a single hardcoded person.
- Resolve contacts before calling, show the exact callee, and require approval at the existing external-action boundary.
- Hosted phone configuration must clearly separate operator/server credentials from local BYOK voice credentials.

## Workstream 10 — Accessibility and settings presentation

- Preserve semantic labels, reading order, visible focus, keyboard access, screen-reader announcements, reduced motion, and forced-colors behavior.
- Reduce repetitive card stacks and excessive explanatory text only where requested, while keeping accessible descriptions available.
- Use diagrams, status summaries, compact progressive disclosure, or richer layout only when they improve comprehension.
- Do not change the Hotkeys section except where required to remove the obsolete Jarvis Assistant shortcut.
- Upgrade Jarvis Actions so every listed action maps to a real registered capability and reports its approval requirement.

## Workstream 11 — Ollama and local chat runtime

- Validate Ollama process reachability, model presence, exact model name, server health, context limits, and stream availability before sending.
- Start or guide startup only through supported, safe paths; never report ready until a health check succeeds.
- Stream tokens to chat, propagate cancellation, enforce a bounded first-token timeout and idle timeout, and surface stderr/status safely.
- Fix the state where a model appears selected but every send reports unavailable or produces no output indefinitely.
- Do not switch to another model/provider without explicit user action.
- Add tests for unavailable daemon, missing model, slow first token, stream completion, malformed chunks, cancellation, and process restart.

## Workstream 12 — Build Your Own AI

- Replace shallow browser-only hardware guesses with a truthful installed-app hardware inventory: CPU model/cores/features, RAM, GPU adapter(s), dedicated/shared VRAM where available, free storage, OS/architecture, and runtime availability.
- Unknown values remain unknown; never infer VRAM from RAM or claim GPU readiness without evidence.
- Run compatibility checks before offering training methods. Disable unsupported LoRA, QLoRA, or full-weight training with the exact reason and next valid step.
- Distinguish retrieval knowledge/indexing from weight training. Do not call a prompt or RAG collection a newly trained model.
- Keep source files local unless the user explicitly chooses a cloud workflow.
- Improve the explicit Build Your Own AI flow with clear stage progress, stronger hierarchy, purposeful illustration/diagram use, and theme-aware cinematic polish without redesigning unrelated pages.
- The wizard must save resumable state, validate every step, and produce a verifiable model/project artifact.

## Workstream 13 — Remove obsolete Jarvis Assistant chrome and fix Focus Mode exit

- Remove the obsolete top-right Jarvis Assistant panel/icon and its `J` shortcut from UI, registry, help copy, and tests.
- Preserve the underlying assistant capabilities reachable through supported chat, command, and action surfaces.
- Replace the textual Focus Mode exit control with the approved compact blue two-arrows-together icon.
- Place it at the far top-right as a fixed overlay that does not reserve layout space or cover active controls.
- Keep an accessible name, tooltip, keyboard focus, and reduced-motion behavior.

## Workstream 14 — Context Map

- Ensure the Context Map is a real interactive graph with named nodes, readable descriptions, typed relationships, pan, zoom, selection, search, filtering, grouping, expand/collapse, and keyboard access.
- Use stable graph layout and persisted node positions without blocking the rest of the application.
- The Nightly Second Brain panel must not cover creation controls or the graph. Make it dockable, collapsible, or move it to a nonblocking inspector.
- Remove theme-breaking hardcoded blue surfaces; consume shared semantic appearance tokens.
- Verify actual creation, update, deletion, linking, persistence, restart restoration, and nightly update ingestion.
- Build on existing implementation rather than creating a disconnected second graph system.

## Performance quick pass

This goal includes a bounded quick optimization pass, not a months-long rewrite.

- Remove obviously duplicated polling, leaked subscriptions, repeated listeners, unnecessary full-store rerenders, and timers that continue while disabled or hidden.
- Memoize or select narrow state for live settings and usage surfaces.
- Batch provider/usage updates and deduplicate network requests.
- Lazy-load heavy settings sections and graph/training code where safe.
- Avoid importing native-only modules into the browser startup path.
- Measure startup, idle CPU, memory, settings-open latency, usage-module overhead, graph interaction, and chat first-token path before and after the quick fixes.
- Do not trade correctness, accessibility, privacy, or truthful status for benchmark numbers.

## Verification requirements

### Focused automated coverage

Every corrected bug receives a regression test. At minimum cover:

- provider-family migration and exact routing;
- OAuth state/callback security;
- Deepgram truth and error mapping;
- usage module creation, visibility recovery, top-two ordering, theme tokens, five-second reconciliation, adapter isolation, and timer shutdown;
- pet outside-click dismissal;
- selected assistant/wake phrase/default voice;
- hands-free versus click-to-talk ownership;
- auth-on-demand boot flow;
- local-model download/verify/repair/update/remove;
- STT download and runtime states;
- contacts and approved outbound call resolution;
- Ollama streaming and timeout behavior;
- hardware scan and training compatibility;
- obsolete shortcut/panel removal;
- context-map interaction and nonblocking nightly panel.

### Browser visualization

Use the browser control/visualization tool against `http://localhost:5173` to verify all browser-supported flows and every explicitly changed surface across relevant themes and responsive sizes. Capture evidence for settings, usage enablement/error state, provider mode selection, plugin connection flow shell, voice controls, local models/STT, Build Your Own AI, Focus Mode exit, and Context Map.

### Installed-app validation

Use the Tauri app for native-only behavior:

- secure key/credential store;
- CLI detection and execution;
- taskbar-adjacent usage window;
- multi-monitor/off-screen recovery;
- microphone ownership and global wake behavior;
- model download and filesystem lifecycle;
- hardware scan;
- Ollama/local runtime;
- system browser OAuth callback;
- native Focus Mode/window behavior.

### Repository gates

Run the exact required checks from `AGENTS.md` and report the real outcome. Do not hide unrelated pre-existing failures; distinguish them from failures caused by this work.

## Definition of done

The goal is complete only when:

1. Every enabled feature has a reachable working surface.
2. Every control performs a real action or is honestly disabled with a reason.
3. Connection, usage, hardware, model, and training states are evidence-based.
4. The taskbar usage module visibly appears, survives restart, adapts to themes, updates live, and remains lightweight.
5. Voice, microphone, selected-assistant identity, Deepgram, local-model, Ollama, and context-map regressions are corrected.
6. Authentication is requested only at the action boundary that requires it.
7. Focused tests, browser visualization, native validation, and repository gates have recorded evidence.
8. No unrelated redesign, secret exposure, unsafe fallback, merge, deployment, or release occurred.
