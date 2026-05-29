# MASTER PLAN — Jarvis V2 Mega-Update

> Synthesis of plans A / B1 / B2 / C / D / E into 11 executor wave assignments with non-overlapping scope, ordered by dependency.

---

## Wave assignments

### E0 — Foundation (must complete before E1-E10)
**Owner files**:
- `app/src/lib/db/schema.ts` — extend STORES with all v2 tables (B2 §6.1)
- `app/src/lib/db/index.ts` — add `db.version(2).stores().upgrade()` (B2 §6.2)
- `app/src/lib/db/repositories.ts` — add `eventRepo`, `quickLinkRepo`, `quickLinkGroupRepo`, `terminalPresetRepo`, `terminalSessionRepo`, `terminalScrollbackRepo`, `terminalLayoutRepo`, `integrationRepo`
- `app/supabase/migrations/0002_v2.sql` — new file (B2 §7)
- `app/src/types/agent.ts` — add `effort`, `effort_custom`, `persona`, `skills`, `source` fields
- `app/src/types/event.ts` — new file
- `app/src/types/quick-link.ts` — new file
- `app/src/types/terminal.ts` — new file
- `app/src/types/integration.ts` — new file
- `app/src/lib/agents/skills.ts` — SKILLS map (B2 §3.3, 16 skills)

**Why first**: every other wave needs these types and repositories. Total ~600 lines, low risk, no UI.

**Verification**: `npm run typecheck` passes, Dexie auto-upgrades on dev launch (no manual reset needed).

---

### E1 — Tauri plugins, security, installer (Plan B1 owner)
**Files**:
- `app/src-tauri/Cargo.toml` — add 9 plugins + `portable-pty`, `keyring`
- `app/src-tauri/src/lib.rs` — register all plugins, single-instance handler, deep-link handler
- `app/src-tauri/src/main.rs` — unchanged
- `app/src-tauri/tauri.conf.json` — strict CSP, bundle targets, updater config, plugin metadata
- `app/src-tauri/capabilities/default.json` — tightened permissions
- `app/src-tauri/capabilities/pip-media.json` — new (D §10)
- `app/src-tauri/capabilities/terminal.json` — placeholder; E1 ships skeleton, E2 fills PTY commands
- `app/src/index.html` — drop Google Fonts CDN
- `app/package.json` — add `@fontsource-variable/inter`, `@fontsource/jetbrains-mono`
- `.github/workflows/release.yml` — new
- `.github/workflows/ci.yml` — new
- `app/src/lib/secrets.ts` — Stronghold/keyring abstraction with localStorage fallback
- `app/src/stores/auth.ts` — migrate apiKeys read-path to use `secrets.ts`

**Why second**: foundation for installable app + secret storage. Other waves depend on `secrets.ts`.

**Verification**: `cargo build` succeeds, `npm run tauri:build` produces installer artifact (test on Win), `secrets.set/get` round-trip works.

**Dependencies on**: E0.

---

### E2 — AI providers + effort + skills runtime (Plan B2 §1-3)
**Files**:
- `app/src/lib/ai/registry.ts` — new ProviderRegistry (B2 §1.1)
- `app/src/lib/ai/types.ts` — extend LLMRequest with `reasoning_effort`, `thinking_budget_tokens`
- `app/src/lib/ai/router.ts` — read from registry, apply effort presets
- `app/src/lib/ai/providers/openai-compatible.ts` — new factory (B2 §1.2.4)
- `app/src/lib/ai/providers/xai.ts` — new (B2 §1.2.1)
- `app/src/lib/ai/providers/ollama.ts` — new (B2 §1.2.2)
- `app/src/lib/ai/providers/opencode-local.ts` — new (B2 §1.2.3) — flag opencode HTTP API assumption for verification
- `app/src/lib/ai/providers/anthropic-compatible.ts` — new (B2 §1.2.5)
- `app/src/lib/ai/providers/anthropic.ts` — add `thinking` field handling, filter `thinking_delta` from output
- `app/src/lib/ai/providers/openai.ts` — add `reasoning_effort` field for o-class/gpt-5 models
- `app/src/lib/ai/providers/google.ts` — add `thinkingConfig.thinkingBudget`
- `app/src/lib/agents/jarvis-agent-md.ts` — gray-matter parse + zod validate + serialize
- `app/src/features/agents/registry.ts` — backfill `effort: 'medium'`, etc on built-ins
- `app/src/types/agent.ts` — finalize EffortPreset type

**Verification**: typecheck passes; mock chat with each provider (using mock keys; real providers fail gracefully with clear error); `parseAgentMd` round-trips; effort overrides actually flow into provider request bodies.

**Dependencies on**: E0 (types).

---

### E3 — Schedule subsystem (Plan B2 §4)
**Files**:
- `app/src/types/event.ts` — already in E0
- `app/src/features/schedule/ScheduleView.tsx` — new
- `app/src/features/schedule/DayGrid.tsx` — new
- `app/src/features/schedule/DayEvent.tsx` — new
- `app/src/features/schedule/DayList.tsx` — new
- `app/src/features/schedule/EventEditDialog.tsx` — new
- `app/src/features/schedule/ReminderPicker.tsx` — new
- `app/src/features/schedule/RecurrencePicker.tsx` — V2 minimal (none/daily/weekly/monthly)
- `app/src/features/schedule/parseEventInput.ts` — regex first, LLM fallback
- `app/src/features/schedule/EventQuickAddModal.tsx` — Mod+Shift+E
- `app/src/features/schedule/reminders.ts` — `scheduleEventReminders` + `speakReminder`
- `app/src/features/schedule/hooks.ts` — `useEvents`, `useEventsInRange`
- `app/src/features/schedule/index.ts`
- `app/src/lib/hotkeys.ts` — register `EVENT_QUICK_ADD: 'Mod+Shift+E'`
- `app/src/features/tasks/NotificationEngine.ts` — extend to support `voice` channel via speechSynthesis

**Verification**: create event via Quick Add, regex-parsed; create via LLM fallback (mock provider); reminder fires (mock time); voice channel speaks via Web Speech.

**Dependencies on**: E0 (eventRepo, types), E2 (LLM for fallback).

---

### E4 — Quick Launch + MediaPlayer (Plan D)
**Files**:
- `app/src/features/launcher/LauncherPanel.tsx` — collapsible NavPane section
- `app/src/features/launcher/LauncherGrid.tsx` — drag/drop grid
- `app/src/features/launcher/LinkCard.tsx`
- `app/src/features/launcher/LinkEditDialog.tsx`
- `app/src/features/launcher/GroupChip.tsx`
- `app/src/features/launcher/BookmarkImport.tsx` — HTML parser via DOMParser
- `app/src/features/launcher/hooks.ts` — `useQuickLinks`, `useStaleQuickLinks`, `useGroupedLinks`
- `app/src/features/launcher/index.ts`
- `app/src/features/media/MediaPlayer.tsx` — YouTube iframe + HTML5 `<video>` switch
- `app/src/features/media/MediaPlayerHost.tsx` — dock/PiP shell
- `app/src/features/media/youtube-player.ts` — YT.Player wrapper
- `app/src/features/media/auto-skip-ad.ts` — heuristic loop
- `app/src/features/media/store.ts` — useMediaStore
- `app/src/features/media/voice-intents.ts` — pause/play/skip/etc keyword map
- `app/src/features/media/hooks.ts` — `useMediaState`, `useMediaCommand`
- `app/src/features/media/index.ts`
- `app/src/components/layout/AppShell.tsx` — mount `<LauncherPanel>` in NavPane (gated by ambientLevel? no, always visible)
- `app/src/App.tsx` — mount `<MediaPlayerHost />`
- `app/src-tauri/src/lib.rs` — `cmd_youtube_oembed` proxy command (per Plan D handoff to B1, but B1 doesn't include — so E4 owns)
- `app/src-tauri/src/lib.rs` — `cmd_open_pip_window` (spawn webview window 360x220)

**Verification**: create quick link, click → opens. Paste YouTube URL → plays in dock. Click PiP button → window spawns. Pause/play work. Auto-skip-ad fires (test with cheap free ad-bearing video manually after build).

**Dependencies on**: E0 (quick_links), E1 (Tauri capabilities, CSP allowing YouTube).

---

### E5 — Terminal subsystem (Plan C)
**Files**:
- `app/src-tauri/src/pty/mod.rs` — new module
- `app/src-tauri/src/pty/session.rs` — PTY session struct
- `app/src-tauri/src/pty/registry.rs` — session map + lifecycle
- `app/src-tauri/src/lib.rs` — register `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `pty_list`, `pty_attach`, `pty_detach`
- `app/src-tauri/capabilities/terminal.json` — fill in PTY allowlist (E1 left placeholder)
- `app/src/features/terminals/TerminalGrid.tsx`
- `app/src/features/terminals/Terminal.tsx` — xterm wrapper
- `app/src/features/terminals/PaneHeader.tsx`
- `app/src/features/terminals/LayoutSwitcher.tsx`
- `app/src/features/terminals/PresetLauncher.tsx`
- `app/src/features/terminals/PresetEditDialog.tsx`
- `app/src/features/terminals/TerminalDashboard.tsx` — multi-project view
- `app/src/features/terminals/presets/builtin.ts` — Claude/OpenCode/Bash/PowerShell/Cmd/Python/Node/Git/npm-dev
- `app/src/features/terminals/store.ts` — useTerminalStore
- `app/src/features/terminals/hooks.ts` — `useTerminalSessions`, `useRecentTerminalOutputs`
- `app/src/features/terminals/voice-intents.ts` — run X, switch to N, etc
- `app/src/features/terminals/index.ts`
- `app/src/components/layout/AppShell.tsx` — mount `<TerminalGrid>` in workspace area (route-aware)
- `app/src/lib/hotkeys.ts` — terminal hotkeys (Ctrl+`, Ctrl+1..8, Ctrl+Shift+T → reassigned, etc)
- `app/package.json` — `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-search`, `react-resizable-panels`

**Verification**: spawn terminal, type `ls`, see output. Split into 4 panes. Voice "run npm test in terminal 2" routes correctly. Detach + reattach works (within session lifetime). xterm theme matches Voltage tokens.

**Dependencies on**: E0 (terminal_* tables), E1 (Cargo deps + capabilities + secrets).

---

### E6 — Voice TTS + reactive orb + intents (cross-feature)
**Files**:
- `app/src/features/voice/VoiceService.ts` — add `speechSynthesis` TTS path; mic AnalyserNode for RMS
- `app/src/features/voice/store.ts` — add `rmsLevel`
- `app/src/features/voice/Orb.tsx` — subscribe to RMS, drive scale 0.95-1.05 via useMotionValue
- `app/src/features/voice/IntentClassifier.ts` — extend with intents from B2/C/D/E plans
- `app/src/features/voice/personas.ts` — already exists; add voice/pitch/rate per persona for TTS
- `app/src/features/voice/VoiceModal.tsx` — fix aria-live conditional (P2 polish)

**Verification**: orb visibly responds to mic level; voice "remind me to eat at 3" creates task; voice "play workout playlist" launches quick link; voice "ambient mode" toggles ambient.

**Dependencies on**: E0, E2 (LLM for intent fallback), E3 (schedule), E4 (media + launcher), E7 (ambient toggle).

---

### E7 — Ambient home + cursor glow + grain + drift orb (Plan E + Plan A §6)
**Files**:
- `app/src/features/ambient/AmbientHome.tsx`
- `app/src/features/ambient/AmbientCard.tsx`
- `app/src/features/ambient/cards/AgentThoughtCard.tsx`
- `app/src/features/ambient/cards/TaskGlanceCard.tsx`
- `app/src/features/ambient/cards/SchedulePeekCard.tsx`
- `app/src/features/ambient/cards/NowPlayingCard.tsx`
- `app/src/features/ambient/cards/TerminalGlanceCard.tsx`
- `app/src/features/ambient/cards/LinkHintCard.tsx`
- `app/src/features/ambient/cards/SystemCard.tsx`
- `app/src/features/ambient/cards/QuoteCard.tsx`
- `app/src/features/ambient/AmbientOrb.tsx`
- `app/src/features/ambient/DriftField.tsx`
- `app/src/features/ambient/useAmbientFeed.ts`
- `app/src/features/ambient/useIdleTrigger.ts`
- `app/src/features/ambient/store.ts`
- `app/src/features/ambient/quotes.ts` — 30 curated quotes
- `app/src/features/ambient/drone.ts` — optional Web Audio drone
- `app/src/features/ambient/index.ts`
- `app/src/components/ambient/CursorGlow.tsx` — Plan A §6.1
- `app/src/components/ambient/GrainOverlay.tsx` — Plan A §6.2
- `app/src/components/ambient/DriftOrb.tsx` — Plan A §6.3
- `app/src/App.tsx` — mount `<AmbientHome />` + `<CursorGlow />` + `<GrainOverlay />` + `<DriftOrb />` (gated by `ambientLevel` and `useUIStore.ambient`)
- `app/src/stores/ui.ts` — add `ambient`, `ambientLevel`, `ambientPosts`, `ambientDrone`, `ambientThresholdMs`, `ambientPauseOnBattery` keys
- `app/src/lib/hotkeys.ts` — add `AMBIENT_TOGGLE: 'Mod+Shift+.'`

**Verification**: idle for set threshold → ambient takes over. Cards drift. Wake on input restores AppShell. SFX cues suppressed in ambient. Screen reader announces new cards.

**Dependencies on**: E0 (memory_items repo, events repo, quick_links repo), E2 (agent thoughts), E3 (events), E4 (media + links), E5 (terminal scrollback), E10 (theme tokens).

---

### E8 — Integrations: Supabase auto-wire, GitHub, Google (Plan B2 §5)
**Files**:
- `app/src/lib/integrations/supabase.ts` — connect/disconnect/test/applyMigrations
- `app/src/lib/integrations/github.ts` — Device Flow + Octokit
- `app/src/lib/integrations/google.ts` — PKCE + loopback + Calendar API
- `app/src/lib/integrations/registry.ts` — central status/state map
- `app/src-tauri/src/oauth/loopback.rs` — local HTTP server for Google callback
- `app/src-tauri/src/lib.rs` — `cmd_oauth_loopback_start(port_hint?) -> port`, `cmd_oauth_loopback_wait(port) -> code`, `cmd_oauth_loopback_stop(port)`
- `app/src/features/schedule/google-sync.ts` — pull/push loop
- `app/package.json` — `@octokit/rest`

**Verification**: GitHub connect → device code shown → after authorizing in browser, "Connected as @username" appears. Voice "add to repo: test issue" creates a real GitHub issue. Google connect → auth flow → calendar events sync into events table.

**Dependencies on**: E0 (integrations table), E1 (secrets, capabilities, fs:scope-appdata for token cache), E2 (LLM for parsing), E3 (events table consumer).

---

### E9 — Settings expansion (Plan A §9)
**Files**:
- `app/src/features/settings/SettingsModal.tsx` — refactor to support grouped headers (Personal / Connections / Workspace / System), 16 sections
- `app/src/features/settings/sections/Account.tsx` — display name inline edit, avatar seed picker, sign in/out, delete data
- `app/src/features/settings/sections/Providers.tsx` — rebuild for registry; per-provider key, base URL, auth header, custom endpoints
- `app/src/features/settings/sections/Models.tsx` — new; per-agent provider/model/effort selectors
- `app/src/features/settings/sections/Appearance.tsx` — theme/accent/density/font/motion-level/SFX/cursor-glow/grain/ambient-level
- `app/src/features/settings/sections/Voice.tsx` — TTS engine/voice/persona/wake-word/PTT/auto-listen
- `app/src/features/settings/sections/Hotkeys.tsx` — rebuild as editable
- `app/src/features/settings/sections/Integrations.tsx` — Supabase/GitHub/Google/OpenCode/Ollama with Connect buttons
- `app/src/features/settings/sections/Workspaces.tsx` — list/CRUD/switch
- `app/src/features/settings/sections/Agents.tsx` — list/import-MD/edit/export
- `app/src/features/settings/sections/Schedule.tsx` — defaults, calendar sync controls
- `app/src/features/settings/sections/Notifications.tsx` — channel × severity matrix
- `app/src/features/settings/sections/Privacy.tsx` — telemetry, crash reports, anonymous usage
- `app/src/features/settings/sections/Storage.tsx` — DB size, clear, export, import, vacuum
- `app/src/features/settings/sections/QuickLaunch.tsx` — group/link CRUD
- `app/src/features/settings/sections/Terminals.tsx` — defaults, presets list
- `app/src/features/settings/sections/About.tsx` — version, channel, updates, log dir, diag bundle, OSS

**Verification**: every section renders, primary fields persist via settingsRepo.

**Dependencies on**: E0 (everything), E1 (secrets used by Providers/Integrations), E2 (registry), E3, E4, E5, E8.

---

### E10 — UX polish across the board (Plan A §10)
**Files** (delta-only for each, see Plan A §10 inventory):
- `app/src/styles/globals.css` — token swap (Plan A §2.1), new utility classes (§2.3), focus ring (§8.2), scrollbars
- `app/tailwind.config.ts` — extend colors with `amber`, `surface-warm`, `ink-soft`; extend fontSize with new scale
- `app/src/lib/motion.ts` — new (Plan A §4.2)
- `app/src/lib/sfx.ts` — new (Plan A §5.2)
- `app/src/components/ui/button.tsx` — add `amber` variant + press scale
- `app/src/components/ui/dialog.tsx` — switch to Motion `softBounce`, add `shadow-cozy`
- `app/src/components/ui/badge.tsx` — `amber` variant
- `app/src/components/ui/checkbox.tsx` — stroke draw on check
- `app/src/components/ui/toast.tsx` — alternating tilt + cozy shadow
- `app/src/features/chat/MessageBubble.tsx` — surface-warm bubble, hoverLift, streaming caret, agent color
- `app/src/features/chat/Composer.tsx` — focus glow, loader2 icon while sending, dynamic ModelPicker (refactor list source)
- `app/src/features/chat/EmptyChat.tsx` — persona greeting rotation
- `app/src/features/tasks/TaskCard.tsx` — amber border when due-soon, animated check
- `app/src/features/tasks/TodoPanel.tsx` — scroll shadows
- `app/src/features/onboarding/Onboarding.tsx` — persona card icons, layoutId on dots
- `app/src/features/settings/SettingsModal.tsx` — layoutId tab pill
- `app/src/components/layout/TopBar.tsx` — voice pulse → motion variant; avatar Popover menu
- `app/src/components/layout/NavPane.tsx` — collapsed Hint tooltips, fade text on collapse
- `app/src/components/layout/Inspector.tsx` — slide-in spring
- `app/src/components/layout/TabStrip.tsx` — layoutId active underline
- `app/src/features/voice/VoiceModal.tsx` — backdrop frostier; aria-live conditional
- `app/src/features/voice/Orb.tsx` — already wired by E6; verify
- All other inventory items per Plan A §10

**Verification**: visual diff vs V1. Reduced-motion path: open with `chrome --force-prefers-reduced-motion` and confirm no drift/parallax.

**Dependencies on**: E0 (theme token usage in components), E2-E9 (don't conflict with structural changes those waves make).

---

## Wave ordering (dependency graph)

```
E0 ── E1 ── E2 ── E3 ── E6 ── E7 ── E10
       ├── E4 ────────────┘
       ├── E5 ────────────┘
       └── E8 ── E9 ──────┘
```

**Sequence**:
1. **E0** alone (foundation).
2. **E1** alone (Tauri/installer/security).
3. **E2, E3, E4, E5, E8 in parallel** (each touches separate features after E0/E1).
4. **E6** after E2-E5 (voice intents reference all).
5. **E7** after E2-E6 (ambient feed reads from all).
6. **E9** after E2-E8 (settings refers to everything).
7. **E10** last (polish doesn't fight structural changes).

---

## File-overlap policy

These files are touched by multiple waves; explicit ownership:

| File | Owner | Other waves contribute via |
|---|---|---|
| `app/src/App.tsx` | E10 (final mount) | E4, E7 add mounts via PR after E10 wires structure |
| `app/src/components/layout/AppShell.tsx` | E10 | E5 mounts TerminalGrid as a route; E10 takes the diff at end |
| `app/src/lib/db/schema.ts` | E0 | All other waves only USE, never edit |
| `app/src-tauri/src/lib.rs` | E1 | E4 adds oembed/PiP cmds, E5 adds pty cmds, E8 adds oauth cmds — all via separate `mod` files E1 doesn't touch |
| `app/src-tauri/tauri.conf.json` | E1 | No other wave edits |
| `app/src-tauri/capabilities/default.json` | E1 | E4, E5 own SEPARATE capability files |
| `app/package.json` | shared | each wave appends its deps; merge conflicts resolved at integration |
| `app/src/styles/globals.css` | E10 | No other wave |
| `app/src/lib/hotkeys.ts` | E10 (final reconcile) | E3, E4, E5, E7 add their entries; E10 verifies no conflicts |

---

## Cross-wave coordination

### Hotkey resolution (final list, E10 enforces)
| Action | Hotkey | Wave |
|---|---|---|
| Toggle nav | `Mod+B` | already wired |
| Toggle inspector | `Mod+I` | already |
| Open palette | `Mod+K` | already |
| Push to talk | `Mod+Space` | already |
| Open settings | `Mod+,` | already |
| New chat | `Mod+N` | E10 |
| Send | `Mod+Enter` | already |
| Quick task | `Mod+Shift+T` | already used; not reassigned |
| Toggle todo | `Mod+Shift+L` | E10 (was Mod+Shift+T pre-V2; reassigned per Plan C clash) |
| Terminal grid focus | `` Ctrl+` `` | E5 |
| Focus pane N | `Ctrl+1..8` | E5 |
| Quick event | `Mod+Shift+E` | E3 |
| PiP media | `Mod+Shift+P` | E4 |
| Quick link 1..9 | `Mod+Shift+1..9` | E4 |
| Ambient toggle | `Mod+Shift+.` | E7 |
| Mute SFX | `Mod+Shift+M` | E10 |

No conflicts after reassigning todo to `Mod+Shift+L`.

### CSP (final, E1 owns)
```
default-src 'self';
script-src 'self' https://www.youtube.com;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
img-src 'self' data: https:;
connect-src 'self' ipc: https://ipc.localhost
  https://api.anthropic.com https://api.openai.com
  https://generativelanguage.googleapis.com
  https://api.x.ai https://openrouter.ai https://api.together.xyz
  https://api.groq.com https://api.fireworks.ai https://api.perplexity.ai
  https://*.supabase.co https://*.supabase.in
  https://github.com https://api.github.com
  https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com
  https://www.youtube.com https://i.ytimg.com
  http://localhost:11434 http://127.0.0.1:* http://localhost:*;
frame-src https://www.youtube-nocookie.com https://www.youtube.com;
media-src 'self' blob: data: https:;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
```

**Note** the `http://localhost:*` and `http://127.0.0.1:*` are required for Ollama, OpenCode-local, and OAuth loopback. Documented as a tradeoff (any localhost service is reachable from the webview); user accepts via Settings.

### Stronghold key naming (final, E1 enforces)
| Key | Owner | Used by |
|---|---|---|
| `provider.{kind}` | E1 (helper) | E2 (read), E9 (settings UI) |
| `provider.custom.{id}` | E1 | E2, E9 |
| `github.token` | E1 | E8 |
| `google.access_token` | E1 | E8 |
| `google.refresh_token` | E1 | E8 |
| `google.token_expires_at` | E1 | E8 |
| `supabase.url`, `supabase.anon_key` | E1 | E8 |

---

## Risks & open decisions

1. **OpenCode HTTP API verified during E2 spike**. Plan B2 §1.2.3 flag.
2. **OAuth `client_id`s** placeholder in V2; user adds in settings or fork.
3. **Process death of PTYs on app close** — V2 detaches but processes die; V3 adds tmux opt-in.
4. **Auto-skip-ad** is best-effort heuristic, not adblocker. Settings UI sets expectations.
5. **Code signing** skipped V2 — SmartScreen + Gatekeeper warnings on first run; documented in README install instructions.
6. **Tests**: V1 had basic vitest. Each wave adds tests for its module. E10 ensures `npm run test` green before merge.

---

## Completion criteria for V2 ship

- [ ] All E0-E10 waves applied
- [ ] `npm run typecheck` clean
- [ ] `cargo build` clean
- [ ] `npm run tauri:build` produces installer (Win minimum; Mac if available)
- [ ] App launches from installer, all features render
- [ ] Voice "play [link]" → media plays
- [ ] Spawn 4 terminals → all visible + interactive
- [ ] Connect Supabase manually → cloud sync resumes
- [ ] Idle for 5 min → ambient takes over → wake restores
- [ ] DEVLOG.md updated with V2 entry
- [ ] Commit: `feat(v2): cozy theme, terminals, media, schedule, ambient, integrations, installer`
