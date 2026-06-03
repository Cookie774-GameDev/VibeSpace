# Jarvis — Model Access, Local Models, and UI Dedup

_Progress log for the round that (1) made a Google Gemini API key the required setup path, (2) added an optional fully-offline Local Models option, and (3) removed the repeated buttons across the side panel / top bar. Built on top of the 0.1.3 work logged in `PROGRESS_v0.1.3.md`._

---

## TL;DR

- **You now have to connect a model before reaching the app.** After onboarding, a hard gate (`RequireModelAccess`) blocks the workspace until the user either pastes a free Google Gemini key (the pushed path, no card) or flips on offline mode. No more silent mock replies.
- **Local Models are a real, optional feature now.** A new `Ollama` provider adapter actually talks to a local daemon (no key, no internet), a new Settings → Local Models tab lets you connect/scan/pick/download models and flip a global Offline toggle, and the router honors offline mode by forcing all chat through the local model.
- **UI repetition fixed.** The Terminal / Kanban / Benchmarks icon buttons that were duplicated in the top bar (they already live in the side panel + the breadcrumb route switcher) were removed. Every route is still reachable; nothing was lost.

Build status: typecheck clean, Vite clean, Rust release clean, both installers rebuilt (MSI 4.3 MB, NSIS 3.6 MB, jarvis.exe 6.6 MB). Jarvis restarted on the new binary.

---

## 1. Require a Google API key (with an offline escape hatch)

The problem: a new user could click through onboarding, land in chat, and get placeholder "mock" replies forever because no key was ever required. Now Jarvis requires a real model before the app opens.

**New gate screen** — `app/src/features/auth/RequireModelAccess.tsx`:
- Primary path: a Google Gemini API key field with a "Get a free key" link to `https://aistudio.google.com/apikey`. Saving it stores the key locally and sets `defaultProvider = 'google'`.
- Secondary path: a "Run fully offline instead" button that turns on offline mode and deep-links into Settings → Local Models.
- The gate is reactive — the instant a key is saved or offline mode flips on, `AuthGate` re-renders and falls through to the app. No manual continue.

**Gate wiring** — `app/src/features/auth/AuthGate.tsx`:
- Added `REAL_PROVIDER_KEYS = ['google','anthropic','openai','groq']`.
- `hasModelAccess = offlineMode || any real provider key present`.
- Render order is now: no user id → seed → `!onboardingComplete` → `<Onboarding/>`; else `!hasModelAccess` → `<RequireModelAccess/>`; else the app.
- It runs every launch, so a user who later removes their only key is re-prompted (rather than silently dropping to mock).

**Default provider flip** — `app/src/stores/auth.ts`:
- `defaultProvider` default changed from `'mock'` to `'google'` so the store-level default matches the seeded Jarvis agent (already on `gemini-2.5-flash-lite`).

**Onboarding copy** — `app/src/features/onboarding/steps/Providers.tsx`:
- Removed the "Skip this and the built-in mock provider keeps you running" line (it contradicted the new gate). New copy tells the user they'll be asked to connect a model before starting and names the free Gemini + offline paths.

Note: the existing Composer "add a free key" banner (`features/chat/Composer.tsx`) is left in place as a belt-and-suspenders nudge for the rare case a key is removed mid-session.

## 2. Optional Local Models (offline, no key, no internet)

This is the genuinely-keyless path. It connects to a user-installed **Ollama** daemon over its OpenAI-compatible API. Nothing is bundled into the installer (keeps it ~4 MB), so the user installs Ollama and pulls a model; Jarvis detects it.

**New provider adapter** — `app/src/lib/ai/providers/ollama.ts`:
- `ollamaProvider` (`id: 'ollama'`) — POSTs to `{base}/v1/chat/completions` with `stream: true`, no `Authorization` header, reusing the shared `parseSSE` (same SSE shape as OpenAI/Groq).
- `isAvailable()` → true whenever a base URL is configured (defaults to `http://localhost:11434`); real reachability is checked at request time, and the router falls back to mock with a clear toast if the daemon isn't running.
- Helpers: `ollamaBaseUrl()`, `listOllamaModels()` (GET `/api/tags`), `isOllamaReachable()`, plus `OLLAMA_DEFAULT_BASE` and `OLLAMA_DEFAULT_MODEL` (`'llama3.2'`).
- Friendly error when unreachable ("Is it running? ollama serve").

**Router integration** — `app/src/lib/ai/router.ts`:
- `ollama` and `local` now map to `ollamaProvider` (were both `mockProvider`).
- `defaultModelFor` returns the user's `defaultLocalModel` for `ollama`/`local`.
- `resolveProviderAndModel` now reads `offlineMode` first: when on, it forces `{ provider: ollamaProvider, model: defaultLocalModel }` and skips all cloud auto-detect. `local`-pinned agents also resolve straight to Ollama.

**AI barrel** — `app/src/lib/ai/index.ts`: exports `ollamaProvider`, `OLLAMA_DEFAULT_MODEL`, `OLLAMA_DEFAULT_BASE`, `ollamaBaseUrl`, `listOllamaModels`, `isOllamaReachable`.

**Cost table** — `app/src/lib/ai/types.ts`: added `'ollama:default': { 0, 0 }` (local inference is free, so the meter shows $0).

**Store fields** — `app/src/stores/auth.ts`:
- `offlineMode: boolean` (default `false`) + `setOfflineMode`.
- `defaultLocalModel: string` (default `'llama3.2'`) + `setDefaultLocalModel`.
- Both added to `partialize` so they persist.

**New settings section** — `app/src/features/settings/sections/LocalModels.tsx`:
- Offline-mode toggle (global switch that forces local inference).
- Connection card: editable base URL, live "Connected / Not running" badge, re-scan button, and a hint about `ollama serve` / `OLLAMA_ORIGINS=*` for packaged builds.
- Default-model picker populated from the daemon's installed models (`/api/tags`), plus a manual override field.
- "Download a model" list (Llama 3.2 3B/1B, Qwen 2.5 3B, Phi 3.5, Gemma 2 2B) with on-disk sizes and a "Copy pull" button that copies `ollama pull <name>`; links to the Ollama model library.

**Settings wiring** — `app/src/features/settings/SettingsModal.tsx`:
- Added `'localmodels'` to the `SettingsTab` union, a `Local Models` tab (HardDriveDownload icon) right after Providers, the import, and the render branch.

## 3. UI dedup — kill the repeated buttons

The audit found Terminal / Kanban / Benchmarks each exposed **three** ways (side panel row + top-bar icon button + breadcrumb route switcher), while the other five routes had only two. That asymmetric triple-exposure is what read as "the same buttons everywhere."

**Change** — `app/src/components/layout/TopBar.tsx`:
- Removed the three standalone route icon buttons (Terminals / Kanban / Benchmarks) from the top-bar right cluster.
- Removed the now-unused `Terminal`, `KanbanSquare`, `BarChart3` icon imports and the `ROUTE_BTN_ACTIVE` style constant.
- Updated the component docstring to describe the new layout.

**Result:** route navigation now has exactly one canonical home (the side NavPane), with the breadcrumb popover as the lightweight switcher when the sidebar is collapsed. Every route is still reachable; the top bar keeps only the global actions that have no other home (launcher, assistant, schedule, fullscreen, search, voice, call, what's new, settings, avatar).

The terminal page header (tiles/splits/swarm/add-pane/reset) was left as-is — those are page-local controls, not duplicates.

---

## File manifest

**New files (3):**
```
app/src/features/auth/RequireModelAccess.tsx     (model-access gate screen)
app/src/lib/ai/providers/ollama.ts               (real local-model adapter)
app/src/features/settings/sections/LocalModels.tsx (Local Models settings tab)
```

**Edited files (7):**
```
app/src/features/auth/AuthGate.tsx               (gate wiring: require model access)
app/src/stores/auth.ts                           (offlineMode + defaultLocalModel; default provider -> google)
app/src/lib/ai/router.ts                         (register ollama; offline-mode routing)
app/src/lib/ai/index.ts                          (export ollama provider + helpers)
app/src/lib/ai/types.ts                          (ollama:default cost row)
app/src/features/settings/SettingsModal.tsx      (Local Models tab)
app/src/features/onboarding/steps/Providers.tsx  (drop "mock keeps you running" copy)
app/src/components/layout/TopBar.tsx             (remove duplicate route icon buttons)
```

---

## Verification

- `npm run typecheck` — clean.
- `npm run build` (Vite) — clean (2594 modules; pre-existing 1.65 MB main-chunk + dynamic/static import warnings, not errors).
- `npm run tauri:build` — Rust release ~2m48s; both bundles produced.
- Artifacts on disk (timestamps 5/30/2026 9:25 AM):
  - `app/src-tauri/target/release/bundle/msi/Jarvis_0.1.3_x64_en-US.msi` (4.3 MB)
  - `app/src-tauri/target/release/bundle/nsis/Jarvis_0.1.3_x64-setup.exe` (3.6 MB)
  - `app/src-tauri/target/release/jarvis.exe` (6.6 MB)
- Jarvis restarted on the new binary.

## Version bump to 0.1.4

Bumped to **0.1.4** across `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `CURRENT_VERSION` in `releases.ts`, with a new 0.1.4 changelog entry (model-access gate, Local Models, top-bar dedup). Built fresh installers:
- `Jarvis_0.1.4_x64_en-US.msi` (4.3 MB)
- `Jarvis_0.1.4_x64-setup.exe` (3.6 MB)
- `jarvis.exe` (6.6 MB)

## Built-in agent files renamed

The three built-in agent markdown files were renamed to the `Agents<Name>.md` convention:
```
app/.jarvis/agents/scout.md     -> AgentsScout.md
app/.jarvis/agents/builder.md   -> AgentsBuilder.md
app/.jarvis/agents/reviewer.md  -> AgentsReviewer.md
```
Safe rename: the loader (`features/skills/loader.ts`) globs `/.jarvis/agents/*.md`, so the new names still match, and each agent's identity comes from its frontmatter `name:` / `title:` (not the filename). No code referenced the old filenames. Because these files are bundled at build time via `import.meta.glob`, the rebuild above was required for the change to take effect.

## Notes / follow-ups

- **Provider "Test" button is still a mock.** Real key validation against Google would make the gate even tighter (catch a typo'd key before the first message). Easy follow-up.
- **CORS in packaged builds.** Ollama rejects the `tauri://localhost` origin by default; the Local Models section documents the `OLLAMA_ORIGINS=*` workaround. The robust long-term fix is routing the local fetch through Rust (`tauri-plugin-http`) to bypass browser CORS — not yet wired.
- **No bundled runtime.** We connect to a user-installed Ollama rather than shipping one, keeping the installer tiny. If you ever want true zero-dependency offline, that's the sidecar/externalBin path (per-platform binaries + signing).
