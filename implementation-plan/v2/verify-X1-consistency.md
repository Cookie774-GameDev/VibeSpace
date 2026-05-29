# X1 — Cross-Plan Consistency Verification

Verifies plan-A, plan-B1, plan-B2, plan-C, plan-D, plan-E for cross-plan consistency before dispatching 11 executor subagents. Findings list issues that need resolution OR explicit acceptance before E1 begins.

---

## 1. Table-schema consistency findings

### 1.1 [BLOCKER] terminal_presets uniqueness scope drift
- **Where:** plan-C §5.1.3 vs plan-B2 §6.1, §7
- **Issue:** Plan C requires `&[workspace_id+slug]` (compound unique within workspace). Plan B2 Dexie has plain `&slug` (global unique) and Postgres has `unique (owner_id, slug)`. Two same-named presets across workspaces would collide on B2's schema.
- **Resolution:** Plan B2 should bend. Change Dexie to `&[workspace_id+slug]` and Postgres to `unique (owner_id, workspace_id, slug)`.

### 1.2 [BLOCKER] terminal_sessions missing columns in Postgres
- **Where:** plan-C §5.1.1 vs plan-B2 §7
- **Issue:** Plan C lists `preset_slug`, `shell_command`, `shell_args` columns (denormalized at spawn time, survive preset deletion). Plan B2's Postgres `terminal_sessions` table is missing all three. Plan B2 also omits them from the Dexie row interface (§6.1 line shows indices only).
- **Resolution:** Plan B2 adds `preset_slug text`, `shell_command text not null`, `shell_args jsonb not null default '[]'::jsonb` to §7 DDL and ensures Dexie row interface mirrors.

### 1.3 [WARN] terminal_layouts Dexie missing updated_at index
- **Where:** plan-C §5.1.4 vs plan-B2 §6.1
- **Issue:** Plan C wants `project_id, updated_at`. Plan B2 has only `project_id`.
- **Resolution:** Plan B2 amends Dexie store to `'project_id, updated_at'`.

### 1.4 [WARN] agent_skills table has no Postgres mirror
- **Where:** plan-B2 §6.1 vs plan-B2 §7
- **Issue:** Dexie STORES const includes `agent_skills: 'id'`. Plan B2's Postgres migration §7 doesn't create the table. Skill rows are seeded from in-code SKILLS map per §6.2.
- **Resolution:** Plan B2 chooses one path: drop `agent_skills` from Dexie (skills stay in-code only) OR add Postgres table to §7.

### 1.5 [WARN] Plan A "agent profile" Inspector references missing skills relation
- **Where:** plan-A §7 row "Inspector content"
- **Issue:** Plan A describes Inspector showing agent profile contents but never specifies how skills attach to user agents (skills jsonb column on agents per B2 §3.2 vs separate join table).
- **Resolution:** Plan B2 §3.2 already stores skills as a JSONB array on agents; Plan A Inspector reads from `agent.skills`. Document the lookup explicitly.

### 1.6 [INFO] terminal_scrollback Dexie index superset
- **Where:** plan-C §5.1.2 vs plan-B2 §6.1
- **Issue:** Plan B2 has `[session_id+chunk_seq], session_id, created_at`. Plan C only required compound key. Plan B2's extras enable cleanup queries.
- **Resolution:** None — superset is fine, but plan-B2 should comment why the extras exist.

---

## 2. Hotkey conflicts

### 2.1 [BLOCKER] Mod+Shift+L triple-claimed
- **Where:** plan-A §8.1 vs plan-D §4.4
- **Issue:** Plan A took plan-C §11.5's recommendation to move TOGGLE_TODO from Mod+Shift+T to Mod+Shift+L. Plan D §4.4 independently claims Mod+Shift+L for "open new-link dialog". Two features now bind the same combo.
- **Resolution:** Plan D should bend. Move new-link dialog to a free combo (e.g. Mod+Shift+K). Plan A Mod+Shift+L = TOGGLE_TODO is canonical.

### 2.2 [BLOCKER] Mod+Shift+G double-claimed
- **Where:** plan-C §7.1 (TERMINAL_TOGGLE_VIEW_MODE) vs plan-D §4.4 (open new-group dialog)
- **Issue:** Both want Mod+Shift+G as global hotkey.
- **Resolution:** Plan D should bend (its scope is the launcher panel). Move new-group dialog to Mod+Shift+J. Plan C's binding stays — but only fires when terminal canvas is the active root view (per §7.2).

### 2.3 [BLOCKER] Mod+Shift+T resolved without confirming user intent
- **Where:** plan-A §8.1 ("Quick add task — already used; E3 confirms") vs plan-C §7.1, §11.5 (TERMINAL_NEW)
- **Issue:** Plan C §11.5 explicitly flags this for "user call". Plan A made the call unilaterally for "Quick add task" (matches V1 TOGGLE_TODO?). The comment "already used" is ambiguous — V1 had Mod+Shift+T for TOGGLE_TODO, not task add. Plan A may have silently changed the meaning.
- **Resolution:** Pick definitively: (a) Plan A keeps Mod+Shift+T = QUICK_ADD_TASK and Plan C moves TERMINAL_NEW to Mod+Alt+T, OR (b) Plan C wins and task-add moves to Mod+Shift+A. Recommend (a). Document the V1→V2 hotkey delta in plan-A §8.1.

### 2.4 [BLOCKER] Mod vs Ctrl mismatch on terminal hotkeys
- **Where:** plan-A §8.1 vs plan-C §7.1
- **Issue:** Plan A lists `Ctrl+\`` and `Ctrl+1..8` for terminal grid focus and pane focus. Plan C lists `Mod+\`` and `Mod+1..8`. On macOS Mod=Cmd; on Windows/Linux Mod=Ctrl. Plan A's form locks to Ctrl on all platforms (wrong on Mac); Plan C's is portable.
- **Resolution:** Use `Mod+\`` and `Mod+1..8` (Plan C). Update Plan A §8.1 rows. Per §7.2, Mod+1..8 only consumed when terminal canvas is the active root view.

### 2.5 [WARN] Plan C internal: TERMINAL_CLOSE_PANE vs terminal-kill-focused
- **Where:** plan-C §7.1 (Mod+Shift+W) vs plan-C §6.4 (Mod+Alt+W for `terminal-kill-focused` palette action)
- **Issue:** Two combos for the same action within Plan C.
- **Resolution:** Pick Mod+Shift+W (matches the close-pane intent). Plan C internal cleanup.

### 2.6 [WARN] Mod+Shift+1..9 collides with browser-style tab-pinning hotkeys
- **Where:** plan-D §4.4
- **Issue:** macOS Cmd+Shift+1..9 is muscle memory for browser tab activation. Acceptable since these are app-scoped, but flag for users on first run.
- **Resolution:** Document in onboarding tour. Allow rebinding via Settings→Hotkeys.

### 2.7 [WARN] No central hotkey registry; merge conflict risk
- **Where:** plan-A §8.1 + plan-C §7.1 + plan-D §4.4 + plan-E §2.2 + plan-B2 §4.4
- **Issue:** Each plan augments `lib/hotkeys.ts` HOTKEYS const independently. After conflicts in §2.1–2.4 are resolved, the final merged map needs a single source of truth.
- **Resolution:** Plan A §8.1 becomes the canonical merged hotkey map post-resolution. All other plans reference Plan A.

### 2.8 [INFO] Mod+P scoped to terminal canvas — fine
- **Where:** plan-C §7.1
- **Issue:** Mod+P is muscle memory for "Quick Open" (VSCode-style). Plan C scopes to terminal canvas only.
- **Resolution:** None. Document in hotkey help so users understand the scope.

---

## 3. CSP and capability gaps

### 3.1 [BLOCKER] Google OAuth endpoints missing from CSP
- **Where:** plan-B1 §1.1 connect-src vs plan-B2 §5.3
- **Issue:** Plan B2's PKCE flow contacts `https://accounts.google.com` (auth) and `https://oauth2.googleapis.com` (token exchange). Plan B1 §1.1 connect-src does not include them. CSP violation will block auth.
- **Resolution:** Plan B1 adds `https://accounts.google.com https://oauth2.googleapis.com` to connect-src.

### 3.2 [BLOCKER] Provider endpoints missing from CSP
- **Where:** plan-B1 §1.1 vs plan-B2 §1.2
- **Issue:** New providers (xAI, OpenRouter, Together, Groq, Fireworks, Perplexity, Ollama, opencode-local) all need their hosts in connect-src. None are present.
- **Resolution:** Plan B1 amends connect-src: `https://api.x.ai https://openrouter.ai https://api.together.xyz https://api.groq.com https://api.fireworks.ai https://api.perplexity.ai http://localhost:11434 http://localhost:4096 http://127.0.0.1:11434 http://127.0.0.1:4096`. Custom user-added OpenAI-compatible endpoints will need user-driven CSP override (document deferral or runtime injection).

### 3.3 [BLOCKER] PiP window label mismatch will silently grant zero permissions
- **Where:** plan-B1 §4.4 (`pip-media.json`, windows: `["pip"]`) vs plan-D §9.1 (`PIP_LABEL = 'media-pip'`)
- **Issue:** Plan B1 §4.4 explicitly warns: "Mismatched labels silently get no permissions." Plan D creates window with label `media-pip`, capability targets label `pip`. The PiP window will load with no IPC at all.
- **Resolution:** Pick one label. Recommend `media-pip` (Plan D matches the route name). Plan B1 updates `pip-media.json` windows array to `["media-pip"]`.

### 3.4 [BLOCKER] cmd_youtube_oembed not registered in Plan B1
- **Where:** plan-D §10.4 vs plan-B1 §4.1, §4.2
- **Issue:** Plan D §4.2 + §10.4 specify a Rust `cmd_youtube_oembed` command using `reqwest`. Plan B1 §4.1 Cargo deps don't include reqwest/urlencoding. Plan B1 §4.2 lib.rs invoke_handler only registers `greet, app_version`.
- **Resolution:** Plan B1 §4.1 adds `reqwest = { version = "0.12", features = ["json", "rustls-tls"] }` and `urlencoding = "2"`. Plan B1 §4.2 invoke_handler list grows to include `cmd_youtube_oembed`.

### 3.5 [WARN] Loopback OAuth callback through WebView
- **Where:** plan-B2 §5.3 step 3-5
- **Issue:** Plan B2 spawns local HTTP server on `127.0.0.1:{port}` for Google OAuth redirect. The browser hits this directly (not WebView), so connect-src may not need it. But the WebView's status polling could call `127.0.0.1` if implemented client-side.
- **Resolution:** Confirm Plan B2 §5.3 keeps the loopback server entirely Rust-side (Tauri command polls/awaits). If yes, no CSP change. If WebView polls, add `http://127.0.0.1:*` to connect-src.

### 3.6 [WARN] Plan D img-src is stricter than Plan B1's, will be overridden
- **Where:** plan-B1 §1.1 (`img-src 'self' data: https:`) vs plan-D §10.1 (specific hosts)
- **Issue:** Plan D §10.1 redefines a stricter img-src than Plan B1. Plan B1 is canonical. Plan D's spec is misleading because it implies a tighter policy than will ship.
- **Resolution:** Plan D §10.1 should reference Plan B1 §1.1 for the merged CSP, not redefine. All YouTube image hosts are already covered by B1's `https:`.

### 3.7 [WARN] terminal capability placeholder unused
- **Where:** plan-B1 §4.5 vs plan-C §1.14
- **Issue:** Plan B1 ships empty `terminal.json` placeholder for a future terminal *window*. Plan C says "no change required" because terminals run inside the main window. The placeholder file is dead code.
- **Resolution:** Plan B1 removes `terminal.json` from §4.5 (terminals are panes inside main window, not separate windows). If V3 adds a detached terminal window, add then.

### 3.8 [WARN] Spotify in_app_player not gated by CSP
- **Where:** plan-B1 §1.1 vs plan-D §3
- **Issue:** Plan D matrix permits Spotify `in_app_player` (with caveat about Premium). Spotify embed needs `https://open.spotify.com` in script-src and frame-src. Plan B1 has neither.
- **Resolution:** Plan D §15 already commits to external-only for Spotify in V2. Plan D should gray out the in_app_player option in the LinkEditDialog matrix when kind=spotify until V3 OAuth ships.

### 3.9 [INFO] connect-src includes ipc/localhost variants
- **Where:** plan-B1 §1.1
- **Issue:** Tauri 2 auto-injects `ipc:` and `https://ipc.localhost`. Plan B1's CSP keeps both — fine but worth noting Vite dev origin may differ.
- **Resolution:** None. Document dev-mode caveat in Plan B1 §1.1.

---

## 4. Provider ID / kind cohesion

### 4.1 [WARN] "OpenCode" naming ambiguity in Settings UI
- **Where:** plan-A §9.2, §9.7 vs plan-B2 §1.1, §1.2.3 vs plan-C §4.2
- **Issue:** Plan A shows just "OpenCode" as a Settings provider name. Plan B2 calls it `opencode-local` (HTTP API). Plan C has terminal preset `opencode` (CLI binary). Two distinct integrations, same display string. Users will confuse them.
- **Resolution:** Plan A §9.2 labels provider as "OpenCode (local HTTP)"; Plan A §9.15 / Plan C labels preset as "OpenCode (terminal)". Document the distinction in onboarding.

### 4.2 [WARN] opencode-local API surface unverified — no graceful UI fallback
- **Where:** plan-B2 §1.2.3 (ASSUMPTION FLAGGED FOR E1) vs plan-A §9.7
- **Issue:** Plan B2 defers verification. Plan A §9.7 OpenCode row doesn't account for "endpoint unknown" state.
- **Resolution:** Plan A §9.7 OpenCode integration row shows "Unverified" pill until E1 spike confirms; Settings provides `Test connection` that pings `/v1/models` and shows the actual error.

### 4.3 [INFO] User-added openai-compatible cap of 5 not enforced in registry
- **Where:** plan-B2 §1.1 vs §8 open question 3
- **Issue:** Plan B2 §8 says cap at 5 user-added; ProviderRegistry has no count check.
- **Resolution:** Plan B2 §1.1 ProviderRegistry adds a `register` guard: `if (kind === 'openai-compatible' && userInstances >= 5) throw`.

---

## 5. Voice intent collisions

### 5.1 [BLOCKER] "skip" alone matches media:next; user may mean media:skip_ad
- **Where:** plan-D §4.5 RX_MEDIA
- **Issue:** `media:next` regex `/^(next|skip(?:\s+song|\s+track)?|fwd)\b/i` — the `(?:\s+song|\s+track)?` group is optional, so "skip" alone matches media:next. Without explicit ordering, the classifier can pick either. User expecting "skip ad" gets "next track".
- **Resolution:** Plan D §4.5 documents classifier order: `media:skip_ad` → `media:next`. Add inline comment in the regex table. Optionally tighten next regex to require the song/track suffix: `/^(next|skip\s+(?:song|track)|fwd)\b/i`.

### 5.2 [BLOCKER] "open X" ambiguous between launch_quick_link and terminal_spawn
- **Where:** plan-D §4.5 (`launch_quick_link`) vs plan-C §6.2 (`terminal_spawn`)
- **Issue:** Plan D regex `/^(open|launch|start)\s+(?:my\s+)?(.+?)/` and Plan C pattern `"open (a )? new (claude|opencode|...) terminal"` both match "open new claude terminal". Without priority, Plan D would route to fuzzy launcher search.
- **Resolution:** Document classifier priority: `terminal_spawn` (requires word "terminal") → `terminal_*` family → `launch_quick_link` (catch-all). Plan D file should add an early-exit when "terminal" appears as a noun.

### 5.3 [WARN] "stop" → media:stop vs terminal_kill ("stop terminal")
- **Where:** plan-D media:stop vs plan-C terminal_kill
- **Issue:** Plan D's media:stop regex matches "stop" alone. Plan C's terminal_kill matches "stop terminal". The distinguishing word is "terminal". Order: terminal_kill before media:stop.
- **Resolution:** Document classifier priority same as 5.2.

### 5.4 [WARN] "play X" overlap with launch_quick_link
- **Where:** plan-D §4.5
- **Issue:** Plan D's media:play `/^(play|resume|continue|unpause)\b/`. "play workout" should fall back to launch_quick_link if no media is active. Plan D §4.5 already mentions this fall-through but doesn't show the wiring in §8.1.
- **Resolution:** Plan D §8.1 `handleVoiceIntent('media:play')` should: if `useMediaStore.activeLink === null && intent.text.length > 5`, fall through to `launch_quick_link`. Add explicit code path.

### 5.5 [WARN] Wake-word "Jarvis" prefix stripping
- **Where:** plan-E §7.1
- **Issue:** "Jarvis pause" should activate then run media:pause. Plan E doesn't specify if "Jarvis " prefix is stripped before classifier sees the text.
- **Resolution:** Plan E §7.1 documents: wake-word activates listener; subsequent words (within 4s) are passed to IntentClassifier with wake-word stripped.

### 5.6 [INFO] add_to_repo and create_issue have no overlap with task_create
- **Where:** plan-B2 §4.6 vs existing task_create
- **Issue:** Plan B2's `add_to_repo` regex requires "add to repo:" or "create issue:" prefix. task_create matches different patterns. No collision.
- **Resolution:** None. Verify regex precedence in classifier.

---

## 6. Stale cross-references

### 6.1 [BLOCKER] speakReminder helper undefined
- **Where:** plan-B2 §4.5 (calls it) and plan-E §7.2 (mentions speechSynthesis without binding)
- **Issue:** Plan B2 §4.5 references `() => speakReminder(event)` in scheduleEventReminders but the helper is defined nowhere. Plan E §11 even asks "defined where exactly?".
- **Resolution:** Plan B2 §4.5 adds the definition: `function speakReminder(e: EventRow) { speechSynthesis.speak(new SpeechSynthesisUtterance(\`Reminder: \${e.title} in \${minutesUntil(e)} minutes\`)); }`. Cross-link from Plan E §7.2.

### 6.2 [BLOCKER] useRecentTerminalOutputs and useStaleQuickLinks hooks undefined
- **Where:** plan-E §11 references; plan-C §6 and plan-D §2.1 don't define
- **Issue:** Plan E expects `useRecentTerminalOutputs(sinceMs)` from Plan C and `useStaleQuickLinks(sinceMs)` from Plan D. Neither plan promises these specific hooks.
- **Resolution:** Plan C adds `features/terminals/hooks/useRecentTerminalOutputs.ts` (queries terminal_scrollback for last N min). Plan D adds `features/launcher/hooks/useStaleQuickLinks.ts` (queries quick_links where `last_used_at < now - sinceMs`).

### 6.3 [WARN] Plan A "wire E10 polish list" mixes structural mounts into polish wave
- **Where:** plan-A §10 final rows (lines 701-707)
- **Issue:** Plan A places App.tsx mounts of `<AmbientHome>`, `<MediaPlayerHost>`, `<CursorGlow>`, `<DriftOrb>` in E10 (polish). But mounting feature components is structural. Plan A §11 simultaneously refers to Plan E (E7?), Plan D (E4?), Plan C (E5?) ownership.
- **Resolution:** Plan A §10 last block is split — feature mounts move to their feature wave (ambient → E7, media → E4, terminals → E5). E10 retains style/animation polish only.

### 6.4 [WARN] Plan A §11 states "speakReminder helper" cross-ref but Plan E says "defined where exactly?"
- **Where:** plan-A §11 (no mention of speakReminder); plan-E §11 (asks the question)
- **Issue:** Plan A's coordination notes list other plans' obligations but never the speakReminder helper.
- **Resolution:** After 6.1 lands, Plan A §11 adds a row noting Plan B2 owns speakReminder; Plan E consumes.

### 6.5 [WARN] Plan A polish list E10 includes E2/E3/E5/E6 items
- **Where:** plan-A §7 inventory (rows tagged "E2"/"E3"/"E5"/"E6") and §10 polish list (mostly E10)
- **Issue:** §7 explicitly tags rows with non-E10 waves but §7 footnote says "Total: 41 entries... E10 owns all polish-only items; E2/E3/E5/E6 own the structural ones tagged in their wave." Multiple authoritative wave assignments per file.
- **Resolution:** Plan A clarifies that the wave tag in §7 is authoritative; §10 contains only E10 items. Cross-checking confirms most §10 rows are indeed E10-eligible.

### 6.6 [INFO] Plan E doesn't declare its own executor wave
- **Where:** plan-E (no header wave tag)
- **Issue:** Plans A, B1, B2, C, D all reference Plan E features but Plan E itself doesn't say which wave (E7? E8?).
- **Resolution:** Plan E top-of-file declares "Wave: E7 (Ambient)".

---

## 7. Settings UI structure

### 7.1 [BLOCKER] Media settings section missing from Plan A
- **Where:** plan-A §9 (16 sections enumerated, no Media) vs plan-D §7.4
- **Issue:** Plan D §7.4 specifies a Settings → Media panel (`autoSkipAds`, `cookielessYouTube`, `defaultBehaviorYouTube`, `pipAlwaysOnTop`, `rememberVolume`). Plan A's section list has no Media entry.
- **Resolution:** Plan A adds §9.17 Media (5 settings per plan-D §7.4). Section count grows to 17.

### 7.2 [WARN] Plan C wants "Advanced > Terminals" nested; Plan A puts it top-level
- **Where:** plan-C §11.4 vs plan-A §9.15
- **Issue:** Plan C asks for nested Advanced > Terminals; Plan A places it as top-level §9.15.
- **Resolution:** Top-level (Plan A) is canonical for V2. Plan C aligns. Optionally surface "Advanced" sub-section *within* §9.15 for power-user toggles (allowUnrestrictedCwd, commandAllowlistEnabled, useTmuxOnUnix).

### 7.3 [INFO] Privacy/Telemetry section UI-only
- **Where:** plan-A §9.12
- **Issue:** Section enumerates toggles but no plan implements the actual telemetry pipeline.
- **Resolution:** Document that V2 ships UI only with toggles wired to settingsRepo; actual telemetry pipeline deferred to V3. Plan A §9.12 adds a "shipping note" line.

---

## 8. Migration / seed gaps

### 8.1 [BLOCKER] terminal_presets seed strategy is contradictory
- **Where:** plan-B2 §6.2 vs plan-C §4.2
- **Issue:** Plan B2 §6.2 says "Seed terminal_presets (built-ins are also in-code; we mirror to DB so user can edit/disable, but reseed on each open if missing)." Plan C §4.2 says explicitly "Built-in presets are NOT stored in the DB; they live in code."
- **Resolution:** Plan C wins — built-ins live in `presets.ts` only. Plan B2 §6.2 removes the terminal_presets seed line. Only `user_defined: true` rows go into DB. Disable/override of built-ins handled via a `disabledBuiltins: string[]` setting.

### 8.2 [WARN] Plan B2 doesn't seed quick_link_groups defaults
- **Where:** plan-D §1 vs plan-B2 §6.2
- **Issue:** First-run user has empty quick_links + empty quick_link_groups tables. UI shows empty state.
- **Resolution:** Optional. If we want a friendly first-run, Plan B2 §6.2 seeds 3 example groups ("Workout", "Music", "Reading") with no links. INFO if we accept empty state; BLOCKER if Plan A's empty state UX assumes data.

### 8.3 [WARN] Migration ordering for foreign keys verified clean
- **Where:** plan-B2 §7
- **Issue:** Postgres `quick_links.group_id` FK to `quick_link_groups`. Plan B2 §7 creates groups before links ✓. terminal_scrollback → terminal_sessions ✓. Verified.
- **Resolution:** None.

---

## 9. Stronghold key drift

### 9.1 [WARN] Plan B1 doesn't enumerate Stronghold key namespace
- **Where:** plan-B1 §1, §4.1 vs plan-B2 §5.6
- **Issue:** Plan B1 introduces Stronghold but never lists the key namespace. Plan B2 §5.6 enumerates 8 keys (`provider.{kind}`, `provider.custom.{id}`, `github.token`, `google.access_token`, `google.refresh_token`, `google.token_expires_at`, `supabase.url`, `supabase.anon_key`). No drift today, but B2 is the de-facto registry.
- **Resolution:** Plan B1 §1 adds a "Stronghold key registry" subsection mirroring B2 §5.6. New plans add keys via Plan B1's registry, not ad-hoc.

### 9.2 [INFO] keyring vs Stronghold preference order phrasing
- **Where:** plan-B1 §4.1 ("write to keyring, fall back to Stronghold") vs plan-B2 §5.6 ("All secrets via Stronghold")
- **Issue:** Slight semantic drift — B1 says keyring first, B2 says Stronghold first.
- **Resolution:** Plan B2 §5.6 amends to "All secrets via OS keystore (keyring) with Stronghold fallback when unavailable" matching Plan B1.

---

## 10. Theme token usage

### 10.1 [BLOCKER] --terminal-* tokens missing from Plan A
- **Where:** plan-C §2.4, §11.2 vs plan-A §2.1, §2.2
- **Issue:** Plan C §2.4 reads 16 `--terminal-*` HSL tokens from globals.css to build the xterm theme. Plan C §11.2 explicitly asks Plan A to add. Plan A's token tables don't include them.
- **Resolution:** Plan A §2.1 and §2.2 add a "Terminal ANSI palette" subsection with 16 tokens (8 normal: black/red/green/yellow/blue/magenta/cyan/white + 8 bright variants), in both dark and light themes. Sample dark values can mirror Plan C's fallbacks.

### 10.2 [WARN] Cursor color: cyan vs accent
- **Where:** plan-A §11 (says "cursor `--accent-cyan`") vs plan-C §2.4 (uses `v('--accent')`)
- **Issue:** Plan C buildVoltageTheme uses `--accent` (which maps to `220 88% 60%` — blue, not cyan). Plan A says cursor should be `--accent-cyan` (`187 95% 50%`).
- **Resolution:** Plan C buildVoltageTheme replaces `cursor: v('--accent')` with `cursor: v('--accent-cyan')` to match Plan A's intent.

---

## 11. Dangling references

### 11.1 [BLOCKER] tauri-plugin-global-shortcut needs JS-side wiring docs
- **Where:** plan-D §4.4 vs plan-B1 §4.1, §4.2
- **Issue:** Plan B1 adds the plugin to Cargo, capability, and lib.rs builder ✓. But plan D needs `Mod+Shift+1..9` registered as OS-wide shortcuts. The actual register call lives in JS (`registerGlobalShortcut(combo, handler)`) per Tauri 2. Plan B1 doesn't mention this and Plan D §4.4 hand-waves "wire registerGlobalHotkey to plugin API".
- **Resolution:** Plan B1 adds a §4.6 subsection documenting the JS API surface (`@tauri-apps/plugin-global-shortcut`) and the canonical `lib/tauri.ts` wrapper. Plan D §4.4 references that.

### 11.2 [BLOCKER] tmux opt-in unspecified for non-default plans
- **Where:** plan-C §8.2 (opt-in tmux on Unix) vs plan-A §9.15
- **Issue:** Plan C §8.2 offers tmux session-resume as an opt-in toggle (`terminals.useTmuxOnUnix`). Plan A §9.15 lists "Tmux opt-in (Unix only, hidden by default)". Plan C §11.7 still flags as open question. No definitive answer.
- **Resolution:** Decide: ship tmux opt-in toggle hidden in Advanced (Plan A §9.15 wording wins) — or omit until V3. Recommend: ship hidden toggle so Unix power users can enable; Windows users see nothing.

### 11.3 [WARN] Plan E references "useEvents" without B2 signature
- **Where:** plan-E §11 (table) vs plan-B2 §4.2
- **Issue:** Plan B2 §4.2 file tree mentions `hooks.ts` with "useEvents, useEventsInRange" but no signatures.
- **Resolution:** Plan B2 §4.2 adds signatures: `useEvents(opts: { fromMs: number; toMs: number; workspace_id?: string }): EventRow[]` and `useEventsInRange(...)`.

### 11.4 [WARN] Plan B2 §1.2.3 opencode HTTP API only flagged once
- **Where:** plan-B2 §1.2.3 (ASSUMPTION FLAGGED FOR E1)
- **Issue:** Plan A §9.7 OpenCode integration row doesn't surface the unverified state. Settings will silently say "configured" with no test result.
- **Resolution:** Plan A §9.7 row shows status pill "Unverified — verify with E1" until the spike lands.

---

## 12. Executor wave overlap map (per file: which executor[s])

The plans use overlapping wave numbering: Plan B1 enumerates E1-E5; Plan A mentions E2/E3/E5/E6/E10; Plan D uses D1-D4 phases; Plan C and E declare no waves explicitly. Recommend a single wave glossary (E1-E11) prepended to a master plan.

### 12.1 [BLOCKER] app/src/lib/db/schema.ts — three plans modify
- **Plans:** B2 owns; C demands terminal_* tables; D demands quick_links/groups
- **Resolution:** B2 sole editor; C and D's table definitions land via B2 §6.1 STORES const. Single Dexie v(2) migration.

### 12.2 [BLOCKER] app/src-tauri/src/lib.rs — 3 plans add to invoke_handler
- **Plans:** B1 owns the rewrite; C adds 9 `pty_*` commands; D adds `cmd_youtube_oembed`
- **Resolution:** Plan B1 §4.2 amended to include all three plans' commands in invoke_handler skeleton; C and D fill in the implementations under their feature directories. Single canonical lib.rs lives in Plan B1.

### 12.3 [WARN] app/src/App.tsx — 5 plans mount components
- **Plans:** A polish (E10); E mounts AmbientHome (E7); D mounts MediaPlayer + registerLauncherActions (E4); C mounts TerminalEventBridge (E5); B1 toast/router additions (E1)
- **Resolution:** Sequential touches. Each wave appends mounts in order: E1 → E2 → E4 → E5 → E7 → E10. Document the line ranges each wave touches in its plan's §10 (or equivalent).

### 12.4 [WARN] app/src/components/layout/AppShell.tsx — 4 plans modify
- **Plans:** A polish E10 (CursorGlow, MotionConfig); D MediaPlayerHost; C TerminalGrid render slot; E AmbientHome overlay
- **Resolution:** Same as 12.3 — sequential. Document each plan's exact insertion point.

### 12.5 [WARN] app/src-tauri/tauri.conf.json — B1 + D
- **Plans:** B1 owns (CSP §1.1, bundle §2.1, updater §2.4, metadata §2.5); D adds connect-src/script-src/frame-src
- **Resolution:** Plan D's CSP additions fold into Plan B1 §1.1's final string per §3.1, §3.2. Plan B1 sole editor.

### 12.6 [WARN] app/src-tauri/capabilities/default.json — B1 + D
- **Plans:** B1 owns; D requests three permissions already present
- **Resolution:** All requested permissions present in B1 §4.3. No remaining conflict after PiP label fix (§3.3).

### 12.7 [WARN] app/package.json — 4 plans add deps
- **Plans:** B1 (@fontsource/*, font lookup); B2 (gray-matter@4.0.3); C (@xterm/* + react-resizable-panels); D (hls.js@1.5)
- **Resolution:** Each wave appends. Use exact-pinned versions per Plan B1 §1.1 hygiene rule. Single `npm ci` runs in CI.

### 12.8 [WARN] app/src-tauri/Cargo.toml — 3 plans add crates
- **Plans:** B1 owns base block; C adds portable-pty + tokio + tracing block; D needs reqwest + urlencoding
- **Resolution:** Plan B1 §4.1 absorbs reqwest + urlencoding (per §3.4 fix). Plan C's block stays separate. Order: B1 → C.

### 12.9 [WARN] app/src/lib/tauri.ts — 3 plans extend
- **Plans:** B1 ships canonical version; C adds `pty_*` wrappers; D wires `registerGlobalHotkey` to plugin
- **Resolution:** Append-only extensions to module exports. No conflict.

### 12.10 [WARN] app/src/features/voice/IntentClassifier.ts — 4 plans extend
- **Plans:** B2 (add_to_repo); C (6 terminal intents); D (12 launcher/media intents); E (wake-word strip)
- **Resolution:** Each wave appends to Intent union and regex tables. After §5.1 + §5.2 resolutions, document priority order at top of file. Append-only.

### 12.11 [WARN] app/src/lib/hotkeys.ts — 4 plans extend HOTKEYS const
- **Plans:** A (16+ entries); C (TERMINAL_*); D (launcher); E (ambient)
- **Resolution:** Append-only. Plan A becomes canonical merged map after §2 resolutions.

### 12.12 [WARN] app/src/styles/globals.css — A + C
- **Plans:** A patches theme tokens; C asks for `--terminal-*` palette additions
- **Resolution:** Plan A absorbs `--terminal-*` per §10.1. Plan A sole editor.

### 12.13 [INFO] app/supabase/migrations/0002_v2.sql — B2 owns
- **Plans:** B2 owns; C and D contribute table specs, all already in B2 §7
- **Resolution:** B2 sole editor. C and D verify their tables on review.

### 12.14 [INFO] app/src/features/settings/sections/*.tsx — multi-plan
- **Plans:** A enumerates 16+1 sections; B2 fills Providers/Models/Integrations; C fills Terminals; D needs Media
- **Resolution:** One file per section. Each wave owns its section component file. Plan A owns SettingsModal.tsx tab structure.

### 12.15 [INFO] app/src/components/layout/NavPane.tsx — A + D
- **Plans:** A polish (collapsed-state tooltips, scroll shadows) E10; D mounts LauncherPanel
- **Resolution:** D inserts LauncherPanel as a NavSection after Files. A polishes other rows. Sequential.

---

*End of verification.*
