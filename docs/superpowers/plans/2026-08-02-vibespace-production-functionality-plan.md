# VibeSpace Production Functionality Implementation Plan

**Goal:** `VS-PR31-PRODUCTION-FUNCTIONALITY-20260802`
**PR:** `#31`

## Execution policy

Planning is deliberately short. Complete Phase 0 once, then move directly through implementation slices. Independent slices may run in parallel, but shared contracts are serialized.

## Phase 0 — Bootstrap and evidence

1. Read `AGENTS.md` and all companion goal files.
2. Record current PR head and working tree.
3. Reproduce the reported bugs with a minimal evidence table.
4. Locate canonical provider, credential, usage, settings, voice, microphone, model, assistant-profile, window, and graph boundaries.
5. Create file locks and slice assignments.
6. Establish a small baseline: startup, idle memory/CPU, settings open time, and current focused tests.

**Exit:** one compact slice map, no extended design cycle.

## Phase 1 — Shared contracts first

### Slice 1A: provider family and connection mode

- Introduce or repair the family/mode normalized contract.
- Map existing API/OAuth/CLI/local connection IDs.
- Add pure migrations and tests.
- Update routing consumers without changing behavior beyond the requested exact-mode selection.

### Slice 1B: sanitized connection and request event bus

- Expose verified connection metadata and request lifecycle events.
- Ensure secrets remain behind native/backend handles.
- Add deduplication and narrow subscriptions.

### Slice 1C: selected assistant identity

- Centralize selected assistant name, wake phrases, labels, and default eligible voice resolution.
- Remove hardcoded Jarvis/Friday copy from consumers.

**Integration gate:** typecheck plus focused provider/identity tests.

## Phase 2 — Usage module critical repair

1. Audit the existing settings toggle and determine whether any window/runtime implementation exists.
2. Implement an idempotent taskbar-usage controller with `enable`, `disable`, `show`, `hide`, `recreate`, `resetPosition`, and `getStatus`.
3. Bind the settings toggle to the controller and rollback/surface error when creation fails.
4. Implement startup restoration and single-instance behavior.
5. Add placement validation and off-screen recovery.
6. Build normalized adapter registry with at least thirty provider-family definitions and capability metadata.
7. Wire existing connected providers/CLI/local runtimes automatically.
8. Add local request event tracking and one five-second reconciliation coordinator.
9. Add provider-specific remote refresh, cache, jitter, abort, dedupe, and backoff.
10. Render top-two ordered providers, compact activity, truthful unavailable/stale/offline/error states, and fixed dimensions.
11. Use shared appearance tokens and live theme synchronization.
12. Add provider reorder/hide/reset and persistence.
13. Ensure disabling closes the window and tears down timers/listeners.

**Focused tests:** toggle/controller, stale handle, startup restore, off-screen placement, top-two order, hidden providers, adapter isolation, theme serialization, five-second scheduling, deduplication, shutdown, no-secret payload.

**Manual native gate:** Windows taskbar placement, auto-hide, multi-monitor, restart, theme changes, idle overhead.

## Phase 3 — Connections and plugins

### Slice 3A: AI connection UI/runtime

- Render one provider family with supported modes.
- Fix Configure and connection actions.
- Correct valid Codex/CLI error states.
- Migrate duplicate selections.

### Slice 3B: OAuth coordinator

- Implement/reuse official provider authorization flows.
- Add callback validation and secure storage.
- Convert eligible plugin cards to OAuth-first.
- Keep explicit advanced manual setup only where necessary.

### Slice 3C: Deepgram canonical connection

- Share one secure key handle across provider/STT/voice.
- Add real validation/error mapping.
- Remove fabricated usage/connection state.

**Gate:** focused security tests plus browser authorization-shell visualization; actual provider flows only where test credentials/configuration exist.

## Phase 4 — Voice and microphone

1. Implement microphone broker/lease contract.
2. Separate click-to-talk and hands-free controllers.
3. Fix the three-second stop and hands-free interaction bug.
4. Wire selected-assistant wake phrases and labels.
5. Set Jarvis High as eligible default with explicit fallback state.
6. Ensure Deepgram STT/TTS consumes canonical connection.
7. Implement send-phrase, silence, abort, interruption, and device-error behavior.
8. Verify chat microphone, settings preview, and global hands-free.

**Gate:** deterministic state-machine tests and real microphone Tauri validation.

## Phase 5 — Local models, STT, and Ollama

### Slice 5A: model lifecycle service

- Manifest-backed download/verify/repair/update/remove.
- Accurate disk-space planning.
- Atomic promotion/rollback and cleanup.

### Slice 5B: STT catalog/runtime

- Repair Whisper/faster-whisper download paths and desktop gating.
- Simplify row copy and hierarchy.
- Verify selected model path and runtime before Ready.

### Slice 5C: Ollama adapter

- Health/model checks, streaming, cancellation, timeouts, and status errors.
- Fix indefinite no-output state.

**Gate:** filesystem fixture tests, mocked transport tests, and real desktop smoke using a small available model.

## Phase 6 — Build Your Own AI and hardware

1. Implement native hardware inventory with partial/unknown-safe values.
2. Add compatibility rules and reasoned disabled states.
3. Separate RAG from adapter/full training terminology and execution.
4. Repair wizard validation, persistence, and stage progress.
5. Apply only the requested cinematic/theme-aware improvements.
6. Verify no source upload occurs without explicit cloud selection.

**Gate:** hardware parser fixtures, compatibility matrix tests, browser placeholder, and native inventory smoke.

## Phase 7 — Phone, contacts, pet, auth timing, and chrome cleanup

- Add contact repository and UI with validation.
- Resolve approved outbound calls through contact/number selection.
- Preserve default verified user number behavior.
- Fix pet menu outside dismissal and listener cleanup.
- Move authentication to the first gated action and resume intent after sign-in.
- Remove obsolete Jarvis Assistant panel/icon/shortcut.
- Replace Focus Mode text exit with the accessible icon overlay.
- Keep Hotkeys otherwise unchanged.

**Gate:** focused tests and browser/native visual smoke.

## Phase 8 — Context Map

1. Audit and reuse the existing graph domain.
2. Repair node/edge CRUD and persistence.
3. Add/verify pan, zoom, search, filter, selection, grouping, keyboard access, and alternate list view.
4. Move Nightly Second Brain UI into a collapsible/dockable nonblocking inspector.
5. Replace hardcoded colors with semantic tokens.
6. Verify nightly ingestion uses the same graph repository.

**Gate:** graph interaction tests, persistence restart test, theme visualization, and large-map performance smoke.

## Phase 9 — Copy and settings cleanup

Perform a bounded pass only on touched surfaces:

- remove repeated filler copy;
- preserve essential privacy, billing, local/hosted, and compatibility information;
- strengthen typographic hierarchy for API/CLI/OAuth/provider/model states;
- use details disclosure for secondary technical text;
- verify accessibility descriptions remain available.

## Phase 10 — Quick performance pass

- Stop hidden/disabled timers.
- Remove leaked event listeners/subscriptions.
- Deduplicate usage/provider requests.
- Narrow store selectors and memoize stable rows.
- Virtualize long catalogs.
- Lazy-load heavy graph/training/model code.
- Avoid blocking UI on disk/network/native scans.
- Remeasure baseline metrics and record changes.

## Final verification matrix

### Automated

- all focused regression suites;
- `npm run typecheck`;
- `npm --prefix app run test`;
- `npm run test:release-manifest`;
- `npm run build`;
- `cargo check --manifest-path app/src-tauri/Cargo.toml`.

### Browser visualization

Test affected screens at minimum in the active warm appearance, default/dark appearance, a light appearance, reduced motion, and keyboard-only navigation. Verify no modal/inspector blocks required actions.

### Native validation

- taskbar usage enable/disable/restart/multi-monitor;
- CLI connection detection;
- OAuth system-browser callback shell;
- keychain status;
- microphone click-to-talk/hands-free;
- local model/STT operations;
- Ollama streaming;
- hardware inventory;
- Focus Mode exit placement.

### Evidence report

Report:

- exact commits and changed paths;
- reproduced root causes;
- tests and counts;
- browser/native checks actually performed;
- performance measurements;
- external blocks;
- remaining risks;
- confirmation that no merge/deploy/release occurred.
