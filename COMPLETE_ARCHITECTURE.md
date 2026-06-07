# Jarvis — Complete Codebase Architecture & Documentation

> Generated from source files at `C:\Users\viper\projects\Jarvis`
> Version: 0.1.14 | Platform: Windows x64 (Tauri 2 + React 18 + Vite + Rust)

---

## 1. Project Overview

Jarvis is a **local-first, offline-capable AI workspace** built as a Tauri 2 desktop application. It combines:

- **Multi-provider AI chat** — Anthropic, OpenAI, Google Gemini, Groq, Ollama, and 14+ more providers
- **Multi-agent council mode** — Parallel agent panels with synthesis
- **Real PTY terminals** — Tile-grid layout, project-scoped, drag-and-drop
- **Voice calling** — In-app WebRTC via LiveKit, plus PSTN via Twilio with a Python cloud backend
- **Context maps** — AI-generated project skill trees for grounded chat context
- **Voice dictation** — Groq Whisper (whisper-large-v3-turbo), Web Speech API fallback
- **Local-first persistence** — IndexedDB via Dexie, optional Supabase cloud sync
- **Action approval system** — AI proposes actions, user approves/cancels before execution
- **Custom tools** — User-created tools stored as action definitions, import/export supported
- **Task/scheduler** — Smart reminders, energy-level-aware scheduling, done notifications
- **Wellness break** — 20-20-20 eye break overlay with countdown
- **Ambient mode** — Procedural Web Audio soundscapes during idle (Warm Hearth, Deep Ocean, Starlight, Forest Rain)
- **Keyboard-first shell** — Global hotkeys, Cmd+K command palette, Mod+Shift+L quick launcher
- **Deterministic NL assistant** — Local command parser (Mod+J) for app control, no remote AI needed

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **Desktop Shell** | Tauri 2 (Rust) |
| **Frontend Framework** | React 18, TypeScript 5 |
| **Build Tool** | Vite 5 |
| **Styling** | Tailwind CSS 3 (custom "Voltage" design system) |
| **Animation** | Motion (Framer Motion successor) |
| **Icons** | Lucide React |
| **State (transient)** | Zustand with persist middleware |
| **State (persistent)** | Dexie (IndexedDB wrapper) |
| **UI Primitives** | Radix UI |
| **Command Palette** | cmdk |
| **Terminal Emulator** | xterm.js + portable-pty (Rust) |
| **Voice/WebRTC** | LiveKit Client + Web Speech API |
| **AI Providers** | Anthropic SDK, OpenAI SDK, Google GenAI SDK, Groq SDK, Ollama HTTP, Custom SSE parser |
| **Cloud Backend** | Python/FastAPI, Pipecat, Twilio, Supabase |
| **PTY** | portable-pty crate (ConPTY on Windows, forkpty on Unix) |
| **Tests** | Vitest (106 tests, 11 files), Rust cargo check |

---

## 3. Directory Structure (Key Paths)

```
C:\Users\viper\projects\Jarvis\
├── app/                           # Main application (React + Tauri)
│   ├── src/                       # Frontend TypeScript/React source
│   │   ├── App.tsx                # Root component, boot wiring
│   │   ├── main.tsx               # React DOM mount
│   │   ├── components/layout/     # AppShell, NavPane, Inspector, TopBar, PageRouter
│   │   ├── components/ui/         # 16 design system primitives (Button, Tabs, Popover, etc.)
│   │   ├── features/              # 30 feature modules (chat, terminals, voice, settings, etc.)
│   │   ├── lib/                   # Core libraries (AI, DB, actions, bridge, MCP, billing)
│   │   ├── stores/                # 3 Zustand stores (ui.ts, auth.ts, agents.ts)
│   │   ├── styles/globals.css     # Voltage design system CSS variables
│   │   ├── types/                 # 10 type definition files
│   │   └── test/setup.ts          # Vitest test setup
│   └── src-tauri/src/             # Rust backend (4 source files)
│       ├── main.rs                # Entry point, windows_subsystem
│       ├── lib.rs                 # Plugin registry + 13 Tauri commands
│       ├── fsread.rs              # File system commands (read, write, list, create)
│       └── terminal.rs            # PTY terminal backend (7 commands)
├── phone-jarvis/cloud/            # Python/FastAPI + Pipecat cloud backend
├── docs/                          # 9 architecture & product design docs
├── implementation-plan/           # Phase plans & verification manifests
├── research/                      # 5 competitive analysis documents
├── supabase/                      # Database migrations (9) + Edge Functions
├── scripts/                       # Release automation (PowerShell + JS)
├── releases/                      # Staged MSI/NSIS installer artifacts
├── install/                       # Install scripts (PowerShell + Bash)
└── .github/workflows/             # CI/CD pipelines
```

---

## 4. Frontend Architecture

### 4.1 App Root — How Jarvis Boots

The React tree in `app/src/App.tsx`:

```
<ErrorBoundary>                    — Catches render crashes, shows recoverable card
  <AuthGate>                       — Generates local user ID, seeds IndexedDB, gates onboarding
    <WorkspaceRoot>
      <GlobalHotkeysHost />         — Wires Cmd+K, Cmd+B, Cmd+\, Cmd+Space, etc.
      <AppShell>                    — 3-pane chrome (Nav | Canvas | Inspector)
        <ActiveCanvas />            — Dispatches ChatView, CouncilView, or PageRouter
      </AppShell>
      <CommandPalette />            — Cmd+K global search
      <SettingsModal />             — Cmd+, settings with 12 section tabs
      <VoiceModal />                — Cmd+Space push-to-talk
      <WakeWordHost />              — Wake word detection (V2)
      <CallModal />                 — In-app phone call (Path C)
      <LauncherDialog />            — Mod+Shift+L quick launcher
      <AssistantBar />              — Mod+J NL command bar
      <WhatsNewHost />              — Auto-open changelog on version bump
      <UpdateWarningHost />         — Auto-update status banner
      <GlowBorder />                — Screen-edge glow during voice
      <CelebrationHost />           — Confetti on milestones
      <ApiKeySaveBurst />           — Visual key-save feedback
      <AmbientHome />               — Idle takeover (breathing orb + clock)
      <AmbientAudioHost />          — Procedural soundscapes
      <WellnessBreak />             — 20-20-20 eye break overlay
      <ActionsPalette />            — Mod+Shift+A tool runner
      <JarvisContextMenu />         — Right-click context menu
      <Toaster />                   — Toast notifications
    </WorkspaceRoot>
  </AuthGate>
  <DevConsoleHost />                — F12/Mod+Shift+D debug panel
</ErrorBoundary>
```

**Boot sequence (`useBoot()` in App.tsx):**
1. Opens IndexedDB via Dexie — seeds default workspace, 7 default agents
2. Registers agents into `useAgentStore` in-memory store
3. Starts AI runtime listener on `window` events (`jarvis:send` / `jarvis:cancel`)
4. Starts reminder notification loop (checks for due tasks/reminders)
5. Initializes terminal scheduler (re-arms persisted scheduled terminal commands)
6. Reconciles terminal sessions (kills orphaned PTYs not in any localStorage layout)

### 4.2 Layout — The 3-Pane Shell

**`AppShell.tsx`**: Responsive shell layout:
- **Left**: `NavPane` (350px, collapsible via `Mod+B`)
- **Center**: Canvas (flex-1, renders `ActiveCanvas`)
- **Right**: `Inspector` (320px, slides via `Mod+\`)
- **Top**: `TopBar` (28px compact toolbar)
- **Bottom**: `TabStrip` for route tabs

**`NavPane.tsx`**: Vertical collapsible sections:
- Workspace/project info with color dot
- Projects — create/switch projects
- Chats — recent chat list, new-chat button
- Agents — agent list for detail view
- Context — context maps with drag-to-chat
- Files — project file tree with drag-to-chat
- 350px drag-resizable handle

**`Inspector.tsx`**: Route-aware right slide-over:
- **Jarvis tab**: Compact ChatThread + Composer
- **Today tab**: Schedule + tasks + quick links
- **Context tab**: Active context map info
- **Tools tab**: Tool-call history
- **Trace tab**: Workflow timeline
- **Refs tab**: Message source references
- Route-context strip: shows terminal sessions on /terminal, kanban updates on /kanban, etc.

**`PageRouter.tsx`**: Routes `useUIStore.route` to the active page:
- `chat` → ChatView (default, also inspector/assistant chats)
- `terminal` → TerminalsPage
- `kanban` → KanbanPage
- `context` → ContextPage
- `schedule` → SchedulePage
- `agents` → AgentManager, `agent-detail` → AgentDetail
- `benchmarks` → BenchmarksPage
- `history` → HistoryPage, `tools` → ToolsPage
- `files` → FilesPage, `skills` → SkillsPage
- `account` → AccountPage, `project-detail` → ProjectDetail

### 4.3 Feature Modules (All 30)

#### `chat/` — Core Chat System (12 files)
- **ChatView.tsx** — Main chat surface with drop zone overlay for file/terminal/context drag
- **ChatThread.tsx** — Scrollable message list, auto-scroll-to-bottom on new tokens
- **Composer.tsx** — Full input system with:
  - Auto-growing textarea (1-8 lines, 20px line height)
  - `@agent` mention typeahead (cmdk-based, filtered by slug + name)
  - `/command` slash command typeahead (21 commands, fuzzy match)
  - `/contextmap <name>` — attach context maps by name
  - `/file <path>` — attach files by absolute path
  - Groq Whisper speech-to-text + Web Speech API fallback
  - Terminal schedule parsing ("send this terminal hello in 5 hours")
  - File/terminal/context attachment chips (max 8 per type)
  - Model provider picker popover
  - Free-tier Gemini key nudge
- **MessageBubble.tsx** — User/assistant message display with streaming text
- **MessagePart.tsx** — Renders individual message parts (text, action proposals, tool calls, images, file refs)
- **ActionApprovalCard.tsx** — Approve/Cancel UI for AI-proposed actions
- **ToolCallCard.tsx** — Tool call result display
- **MentionTypeahead.tsx** — Agent @mention popover (cmdk Command component)
- **SlashCommandTypeahead.tsx** — /command typeahead with icons, descriptions, fuzzy search
- **EmptyChat.tsx** — "No messages yet" placeholder
- **MicWaveform.tsx** — Animated waveform indicator for voice
- **hooks.ts** — `useChatMessages()` live query hook

#### `terminals/` — PTY Terminal System (16 files)
- **TerminalsPage.tsx** — Full terminal workspace with toolbar, reset button (2s hold for full reset)
- **TerminalView.tsx** — xterm.js wrapper with:
  - Tauri IPC: `terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`
  - Font-locking fix: awaits `document.fonts.ready`, reassigns fontFamily
  - Drag-and-drop for files (`application/x-jarvis-file`), context (`application/x-jarvis-context`), terminals
  - Copper "power-up" effect on context drop
  - Right-click context menu
  - Manual pane resize handles
  - Transcript caching to Zustand store
- **TileGrid.tsx** — Multi-pane layout manager with split/leaf nodes, resize handles, drag reorder
- **PaneToolbar.tsx** — Per-pane chrome (name, agent role picker, connected files, close button)
- **PaneTree.ts** — Pane tree state management (split direction, sizes, session IDs)
- **AgentRolePicker.tsx** — Assign agent roles (Builder, Reviewer, Scout) to terminal panes
- **ConnectedFilesButton.tsx** — File pinning UI to terminal panes
- **terminalCommandQueue.ts** — Queue for terminal spawn commands (supports bulk operations)
- **terminalLiveCache.ts** — In-memory output cache for AI context (Zustand)
- **terminalProjectMove.ts** — Cross-project terminal drag-and-drop
- **terminalRefs.ts** — Stable terminal reference payloads (pane id, session id, command, project, agent)
- **terminalScheduler.ts** — Persisted scheduled terminal messages (survives restart)
- **transcriptStore.ts** — Zustand transcript store per session
- **agentContext.ts** — Builds agent-scoped terminal output for AI system prompt
- **4 test files**: transcriptStore, agentContext, terminalScheduler, terminalLiveCache

#### `council/` — Multi-Agent Parallel Chat (8 files)
- **CouncilView.tsx** — Multi-agent parallel chat with 2×2 grid
- **CouncilGrid.tsx** — N-up agent panel grid (default 2×2, up to 4 panels)
- **AgentPanel.tsx** — Individual agent response panel with streaming
- **AnimatedBeam.tsx** — Animated SVG beam between panels
- **BeamLayer.tsx** — Multi-beam canvas layer
- **SynthesizeButton.tsx** — Combines council outputs into single synthesis
- **CouncilToggle.tsx** — Switches between single-agent and council mode

#### `assistant/` — Natural Language Command Bar (5 files)
- **AssistantBar.tsx** — Mod+J NL command bar UI
- **intents.ts** — 19 discriminated union intent types
- **parse.ts** — Regex-based NL parser with:
  - Filler phrase stripping ("please", "can you", "I want to")
  - Multi-step support (split on "then" / "and then")
  - Fuzzy suggestion fallback (40 known patterns, scores by keyword overlap)
- **execute.ts** — Dispatches intents to repos/stores. Supports: create/switch project, create chat, open terminals (with count/command/project), run in all terminals, create/run custom commands, ask provider, give terminals context, create/recenter context map, create task, create event, schedule call, send SMS, ambient toggle, fullscreen, navigate (13 routes), open settings/palette/launcher/schedule, multi-step plans
- **commands.ts** — 64-entry static command catalog

#### `context/` — Context Maps (4 files)
- **ContextPage.tsx** — Interactive circular-node map with zoom/pan/center
- **SidebarContextTree.tsx** — Draggable tree in nav pane
- **tree.ts** — Core logic:
  - `ProjectContextMapCollection` — max 5 active maps per project
  - `makeContextTree()` — Gemini scans project files, generates structured tree
  - `ContextAttachment` — drag-and-drop payload for chat/terminals
  - `loadStoredContextMaps()`, `selectStoredContextMap()`, `deleteStoredContextMap()`
  - `persistContextMapCollection()` — localStorage-based persistence

#### `voice/` — Speech-to-Text & Voice System (11 files)
- **VoiceService.ts** — Singleton Web Speech API wrapper:
  - Feature-detects `SpeechRecognition`/`webkitSpeechRecognition`
  - Continuous + interim results
  - 30-second inactivity timer auto-aborts
  - Typed events: `voice:start`, `voice:partial`, `voice:final`, `voice:error`, `voice:timeout`
  - Auto-restart on Chromium's ~60s session cap
- **VoiceModal.tsx** — Cmd+Space push-to-talk modal
- **VoiceTrigger.tsx** — Wall-mounted voice trigger button
- **GlowBorder.tsx** — Screen-edge conic gradient during listening
- **Orb.tsx** — CSS-only ambient orb with Apple-Intelligence-style glow
- **VoiceCaption.tsx** — Live transcription overlay
- **WakeWordHost.tsx** — Wake word detection
- **WakeWord.ts** — Wake word audio processor
- **Personas.ts** — Voice persona definitions (Jarvis, Athena, Edge, Watson, HAL, Sage)
- **Store.ts** — Voice-specific Zustand state
- **IntentClassifier.ts** — Voice intent classification

#### `settings/` — Full Settings System (13 files)
- **SettingsModal.tsx** — Full-screen settings modal with tab navigation
- **12 section components**:
  - **Providers.tsx** — BYOK key input for all 19 providers
  - **LocalModels.tsx** — Ollama model scanning (GET /api/tags), offline mode toggle
  - **Appearance.tsx** — Theme (dark/light/system), density (compact/cozy), terminal font size
  - **Hotkeys.tsx** — Keyboard shortcut display
  - **Ambient.tsx** — Track selection, volume, idle threshold, always-play toggle
  - **Notifications.tsx** — Master switch, per-category toggles (Jarvis, terminal, tasks, context, skills)
  - **PhoneVoice.tsx** — PIN, caller allowlist, outbound trigger categories
  - **Plans.tsx** — Subscription tiers (Spark/Orbit/Nova/Singularity) with cosmic backgrounds
  - **Voice.tsx** — Voice persona selector
  - **Accessibility.tsx** — STT toggle, font scaling
  - **About.tsx** — Version info, current-update summary
  - **Account.tsx** — Profile display
- **ApiKeySaveBurst.tsx** — Visual feedback animation on API key save

#### `command-palette/` — Cmd+K Global Search (5 files)
- **CommandPalette.tsx** — cmdk-based global command center
- **pages.tsx** — Nested command pages
- **actions.ts** — Command action bindings
- **store.ts** — Command palette Zustand store
- **useGlobalHotkeys.tsx** — Global hotkey wiring hook

#### `call/` — In-App Phone Calls (6 files)
- **CallModal.tsx** — In-app phone call UI (Path C)
- **CallService.ts** — LiveKit room connection, mic publishing, audio subscription
- **CallButton.tsx** — Green call button in the UI
- **config.ts** — LiveKit/Supabase configuration
- **store.ts** — Call state Zustand store
- **outbound.ts** — Outbound call trigger system (manual + error categories)

#### `ambient/` — Idle Soundscapes (6 files)
- **AmbientHome.tsx** — Full-screen idle takeover with breathing orb + analog clock
- **AmbientAudioHost.tsx** — Web Audio procedural soundscape player
- **ambientAudio.ts** — Audio context management, track generation (4 tracks)
- **quotes.ts** — Ambient mode inspirational quotes
- **useIdleDetection.ts** — Idle tracking hook (default 5min threshold, min 15s)

#### `tasks/` — Task & Reminder System (9 files)
- **TaskCard.tsx** — Task display with priority dot, due date, actions
- **TaskComposer.tsx** — Quick task creation input
- **DraftTaskList.tsx** — AI-extracted draft tasks for approval
- **Scheduler.ts** — Smart scheduler (effort points, energy levels, context tags)
- **NotificationEngine.ts** — Reminder notification dispatcher (desktop + in-app)
- **TaskService.ts** — CRUD operations with Dexie
- **store.ts** — Tasks Zustand store
- **hooks.ts** — `useTodayTasks()` live query hook
- **SnoozePopover.tsx** — Reminder snooze UI
- **parseTaskInput.ts** — Natural language task parsing

#### `schedule/` — Calendar & Events (4 files)
- **SchedulePage.tsx** — Calendar/schedule view
- **hooks.ts** — `useTodayEvents()` recurrence-aware query hook
- **parseEventInput.ts** — NL date/time parser ("friday at 1pm", "tomorrow at 3")
- **recurrence.ts** — Recurrence rule engine (RRULE-compatible)

#### `kanban/` — Project Board (5 files)
- **KanbanPage.tsx** — Drag-and-drop kanban board
- **KanbanColumn.tsx** — Column (Open/In Progress/Done)
- **KanbanCard.tsx** — Individual task card
- **hooks.ts** — Kanban query hooks

#### Remaining Features (12 modules):
- **ActionsPalette** — Mod+Shift+A tool runner
- **Benchmarks** — LMArena snapshot/fallback benchmark display
- **Billing** — Stripe-hosted subscription plan pages
- **Celebrate** — Confetti + serif gradient toast on milestones
- **DevConsole** — F12 debug panel (console, fetch, invoke, dispatch, window-error patchers)
- **Files** — Full file browser with text/code editor, sidebar file tree (max 120 children per dir)
- **History** — Replayable session history
- **Launcher** — Quick launcher dialog with pinned links, groups, global hotkeys
- **Projects** — Project detail and context pages
- **Skills** — Markdown/system-prompt skill system with frontmatter parser, marketplace-ready
- **Tools** — Custom tool creation, import/export, run-in-place
- **Updates** — Auto-update warning banner
- **Wellness** — 20-20-20 eye break overlay with countdown
- **WhatsNew** — Version-aware auto-open changelog modal

### 4.4 State Management

**Three Zustand stores:**

**`stores/ui.ts` — `useUIStore`**
- ~40 state fields, 30+ actions
- Persisted to localStorage (key: `jarvis-ui`): nav/inspector state, theme, density, all ambient prefs, notification settings, terminal font size, composer STT toggle
- Transient (not persisted): modal states, route, wellness state, voice listening, actions palette
- Version 1 migration strips unknown persisted keys

**`stores/auth.ts` — `useAuthStore`**
- Persisted to localStorage (key: `jarvis-auth`): API keys (19 providers), default provider, workspace/project IDs, persona preset, plan tier, offline mode, local model, telemetry opt-in
- 13 actions: `setApiKey()`, `clearApiKey()`, `setDefaultProvider()`, `setProjectId()`, `setOfflineMode()`, `setPlan()`, etc.

**`stores/agents.ts` — `useAgentStore`**
- Transient (in-memory, not persisted): agent definitions, run states, verbs, token counters
- 8 actions: `registerAgent()`, `registerMany()`, `setRunState()`, `addTokens()`, etc.

**`lib/db/` — IndexedDB (Dexie)**
- Schema v2 — 14 tables:
  - `workspaces`, `projects`, `chats`, `messages`, `agents` — core entities
  - `tasks`, `task_reminders` — task system
  - `events`, `memory_items` — schedule + memory
  - `settings`, `sync_queue` — configuration + offline sync
  - `terminal_sessions`, `terminal_scrollback`, `terminal_layouts` — V2 terminal persistence

### 4.5 UI Design System (`components/ui/`)

16 Radix-based primitives with Tailwind:
- **button.tsx** — 4 variants: ghost, accent, destructive, icon-sm
- **tabs.tsx** — TabsList/TabsTrigger/TabsContent
- **popover.tsx** — PopoverAnchor/PopoverContent/PopoverTrigger
- **tooltip.tsx** — Tooltip with delayDuration
- **dialog.tsx** — Modal dialog with overlay
- **toast.tsx** — 4 levels: info, success, warning, error
- **badge.tsx**, **avatar.tsx**, **card.tsx**, **switch.tsx**, **input.tsx**, **textarea.tsx**, **checkbox.tsx**, **label.tsx**, **separator.tsx**, **skeleton.tsx**

**Theme**: CSS variables in `globals.css`:
- Dark theme (default): `--background: 0 0% 5%`, `--foreground: 0 0% 93%`
- V2 Cozy palette: copper, amber, rose, terracotta, honey, sage, lavender
- Fonts: Plus Jakarta Sans (body), Fraunces (display), JetBrains Mono (mono)
- Custom animations: breathe, glow-rotate, beam-flow, aurora, shimmer, fade-in, slide-up, scale-in

### 4.6 TypeScript Types (`types/`)

Branded ID system for compile-time safety:
```
AgentId, ChatId, MessageId, TaskId, WorkspaceId, ProjectId
EventId, QuickLinkId, TerminalSessionId
```

**10 type files:**
- `common.ts` — 19 ProviderIds, Result<T,E> envelope, Theme, PersonaPreset, ContextRef
- `agent.ts` — Agent, AgentCapability (9), ModelSpec, AgentRunState (9), AgentEffort (6), AgentPersona (6)
- `chat.ts` — Chat, Message, Part (7 variants: text, reasoning, tool_call, tool_result, action_proposal, image, file_ref)
- `task.ts` — Task, Reminder, DraftTask, TaskPriority (4), TaskStatus (5), NotificationChannel (8)
- `event.ts` — EventRow, EventAttendee, EventReminder, EventSourceRef
- `memory.ts` — MemoryItem (RAG-indexed)
- `terminal.ts` — TerminalPreset, TerminalSession, TerminalLayout, TerminalScrollbackChunk
- `quick-link.ts` — QuickLink, QuickLinkGroup, LinkKind (7), LinkBehavior (4)
- `integration.ts` — Integration, IntegrationKind (5), IntegrationStatus (4)
- `index.ts` — Barrel re-exports

---

## 5. Backend Architecture (Rust/Tauri 2)

### 5.1 Entry Point — `main.rs`
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { jarvis_lib::run(); }
```

### 5.2 Plugin & Command Registry — `lib.rs`
**7 Tauri plugins registered:**
- `tauri-plugin-os` — platform/arch detection
- `tauri-plugin-shell` — `shell.open` for URLs
- `tauri-plugin-dialog` — open/save/message dialogs
- `tauri-plugin-notification` — OS native banners
- `tauri-plugin-http` — native HTTP (bypasses CORS for localhost:11434)
- `tauri-plugin-process` — relaunch after update
- `tauri-plugin-updater` — signed auto-update channel

**13 Tauri commands:**
- `greet(name)` — sanity check
- `app_version()` — returns Cargo.toml version
- File commands: `fs_read_text`, `fs_list_dir`, `fs_write_text`, `fs_create_text_file`
- Terminal commands: `terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_move`, `terminal_list`, `terminal_reconcile`

### 5.3 File System — `fsread.rs`
Scoped commands (NOT `tauri-plugin-fs`):
- Max 1 MiB per file read
- Absolute paths only (rejects relative)
- UTF-8 validation
- Max 500 directory entries
- Stable string error codes: `not_absolute`, `not_found`, `not_a_file`, `too_large`, `not_utf8`, `parent_not_found`, `already_exists`, `io: <msg>`

### 5.4 PTY Terminals — `terminal.rs`
**State management:** `TerminalState` — `Arc<AsyncMutex<HashMap<String, PtyHandle>>>`

**Per-session structure:**
- Writer, master, killer — each behind `Arc<AsyncMutex<Box<dyn ...>>>` for concurrent access
- Reader task — `spawn_blocking` loop on 4KiB buffer, lossy UTF-8, emits `terminal://output` events
- Two atomic flags: `active`, `deleted`

**Shell selection:**
- Windows: `powershell.exe` (ConPTY via portable-pty)
- Unix: `$SHELL` → `/bin/zsh` → `/bin/bash`

**Session lifecycle:**
1. `terminal_spawn` — opens PTY, spawns shell, drops slave handle, starts reader, returns session_id
2. `terminal_write` — sends UTF-8 bytes to PTY stdin
3. `terminal_resize` — sends SIGWINCH/ConPTY resize via `PtySize { rows, cols }`
4. `terminal_kill` — kills child, aborts reader, removes from map
5. `terminal_move` — reassigns PTY to a new project
6. `terminal_list` — snapshots active sessions (excludes dead/deleted)
7. `terminal_reconcile` — kills orphaned sessions not in `active_session_ids` array

**Limits:** 10 active sessions per project. Auto-evicts oldest when exceeded.

---

## 6. Feature Descriptions (Detailed)

### 6.1 AI Chat Flow

```
User types → Composer.handleSend()
  → messageRepo.create() [user message persisted]
  → window.dispatchEvent('jarvis:send')
    → startRuntimeListener() in runtime.ts catches event
    → Resolve agent: explicit > @mention > chat default
    → Apply persona preset + action catalogue overlay
    → Build context blocks:
        - project context (system_prompt_context)
        - context tree (Context Map)
        - explicit context nodes (dragged into chat)
        - connected files (pinned to terminal/agent)
        - explicit file paths (dragged into chat)
        - terminal references (dragged into chat)
        - terminal transcripts (agent-scoped)
        - AI completion cue ("notify me when done")
    → messageRepo.create() [empty assistant placeholder]
    → runAgent(agent, llmMessages, signal, onChunk)
      → router.ts: selects provider adapter by agent.model.provider
      → provider sends request to LLM
      → chunks streamed via onChunk callback
      → throttled DB writes every 50ms (flushNow / scheduleFlush)
    → Final DB write with canonical text + usage tokens
    → derivePaneTitle() — first sentence, strip markdown, max 48 chars
    → notifyDone() for notification system
```

### 6.2 Terminal Spawn Flow

```
TerminalsPage / Command Queue
  → enqueueTerminalCommand({ command, label })
  → TerminalView mounts
    → await document.fonts.ready
    → invoke('terminal_spawn', { command, cwd, rows, cols, project_id, project_name })
      → Rust: check session count ≤ 10, evict oldest if needed
      → portable-pty::native_pty_system().openpty()
      → spawn shell process via CommandBuilder
      → drop slave handle
      → start spawn_blocking reader task
      → return { sessionId: "tty_<nanoid12>" }
  → listen for 'terminal://output' → write to xterm.js Terminal
  → listen for 'terminal://exit' → cleanup UI, update transcript store
```

### 6.3 Action Proposal Flow

```
1. AI response contains ```action { "id": "...", "params": {...}, "rationale": "..." } ```
2. parseActionBlocks() in actions/parse.ts extracts all fenced blocks
3. textToParts() creates action_proposal parts with status: 'pending'
4. ActionApprovalCard.tsx renders Approve/Cancel buttons with rationale
5. User clicks Approve → callback executes runAction(action_id, params)
6. runner.ts dispatches to the handler function registered in registry.ts
7. On success: part.status = 'success', result stored
8. On failure: part.status = 'error', error message stored
9. Multiple actions in same reply get single "Approve all" button
```

### 6.4 Voice Dictation (Two Paths)

**Groq Whisper (when Groq API key is configured):**
1. User clicks mic in composer
2. `startGroqStt(apiKey)` in Composer.tsx
3. `getUserMedia()` captures microphone
4. `ScriptProcessorNode` (2048 buffer) collects Float32Array chunks
5. 30-second inactivity timer tracks RMS silence
6. On stop: chunks encoded to WAV via `encodeWav()`
7. WAV uploaded to `https://api.groq.com/openai/v1/audio/transcriptions`
8. Model: `whisper-large-v3-turbo`
9. Response text appended to composer

**Web Speech API (fallback when no Groq key):**
1. `VoiceService.ts` wraps `SpeechRecognition`/`webkitSpeechRecognition`
2. Continuous + interimResults for live preview
3. Typed events drive UI state
4. Chromium ~60s session cap handled via transparent restart
5. 30-second inactivity timeout

### 6.5 Context Map Generation

1. User presses "Make Context Map" on ContextPage (or `create_context_map` intent)
2. `makeContextTree(projectId)` scans project files via Tauri `fs_list_dir`
3. Groups files by directory into 'area' nodes
4. Calls Gemini to generate summaries for each area + file
5. Constructs `ProjectContextTree` with nodes: root → area → file/symbol → note
6. `saveContextTree(tree)` persists to localStorage under `jarvis-context-maps-v1:{projectId}`
7. Every AI request prepends context tree block to system prompt via `getProjectContextTreeBlock()`
8. Max 5 active maps per project
9. Nodes are draggable: drop into chat as ContextAttachment, drop into terminal as power-up

### 6.6 Slash Command System

21 registered commands in `Composer.tsx`:

**Attach commands:**
- `/contextmap [name]` — list maps or attach by name
- `/file <path>` — attach file by absolute path
- `/attach <path>` — alias for file attach

**Provider commands:**
- `/model <provider>` — switch provider (19 options)
- `/usage` — show current provider usage summary

**Navigation commands (13 routes):**
- `/files`, `/terminals`, `/kanban`, `/context`, `/skills`, `/history`, `/tools`, `/agents`, `/schedule`, `/chat`

**Utility commands:**
- `/clearfiles` — clear all file/terminal/context attachments
- `/commands` — display 64-command catalog
- `/help` — show available commands

**Autocomplete:** Fuzzy-match typeahead on `/` with icons, keyboard navigation (Arrows/Enter/Tab/Escape). Slash context takes priority over mention (@) context.

### 6.7 Natural Language Assistant Commands

19 intent types parsed from Mod+J bar:

| Intent | Examples |
|---|---|
| `create_project` | "create project tiger" |
| `switch_project` | "switch to tiger project" |
| `create_chat` | "create chat called planning" |
| `open_terminals` | "open 4 terminals with opencode in tiger" |
| `run_in_terminals` | "run npm test in all terminals" |
| `create_custom_command` | "create command dev server to run npm run dev" |
| `run_custom_command` | "run command dev server" |
| `ask_provider` | "ask claude to fix the tests" |
| `give_terminals_context` | "give all terminals all context" |
| `create_context_map` | "create context map" |
| `recenter_context_map` | "recenter context map" |
| `create_task` | "make a todo: ship tomorrow" |
| `create_event` | "schedule standup friday at 1pm" |
| `schedule_call` | "call me at 3pm" |
| `send_phone_message` | "message me: build is done" |
| `set_ambient` | "ambient mode on" |
| `set_fullscreen` | "fullscreen" / "exit fullscreen" |
| `navigate` | "open terminals" / "show benchmarks" |
| `multi_step` | "create project tiger then open 4 terminals" |

Multi-step commands split on "then" / "and then". Unknown inputs trigger fuzzy suggestion fallback (40 known patterns, keyword scoring, top 3 suggestions returned).

### 6.8 Resource Limits & Safety

| Resource | Limit |
|---|---|
| Terminal sessions per project | 10 (auto-evicts oldest) |
| Attached files per message | 8 |
| Attached terminals per message | 8 |
| Attached context nodes per message | 8 |
| Active context maps per project | 5 |
| Directory entries per `fs_list_dir` | 500 |
| File read size cap | 1 MiB |
| File write size cap | 1 MiB |
| Bullet terminal spawn count | 10 (cap per command) |
| Sidebar file tree children rendered | 120 |
| Textarea lines | 1-8 (auto-expands) |
| Chat title length | 48 characters |


## 7. Data Flow Diagrams

### 7.1 Message Send
```
User types text + drags file/terminal/context
         │
         ▼
  Composer.handleSend()
         │
         ├──► messageRepo.create(user msg) ──► IndexedDB
         │
         ├──► window.dispatchEvent('jarvis:send')
         │         │
         │         ▼
         │   startRuntimeListener()
         │         │
         │         ├── resolve agent
         │         ├── applyPersona()
         │         ├── applyAvailableActions()
         │         ├── buildContext (project → context tree → files → terminals → AI cue)
         │         ├── messageRepo.create(assistant placeholder)
         │         ├── runAgent(agent, messages, signal, onChunk)
         │         │         │
         │         │         ▼
         │         │   router.ts → provider adapter
         │         │         │
         │         │         ├── anthropic.ts
         │         │         ├── openai.ts
         │         │         ├── google.ts
         │         │         ├── groq.ts
         │         │         ├── ollama.ts
         │         │         └── mock.ts
         │         │
         │         ├── onChunk(delta) → throttled DB write (50ms)
         │         ├── final write: textToParts(response) + usage
         │         ├── derivePaneTitle(first sentence, ≤48 chars)
         │         └── notifyDone()
         │
         └──► toast.success/error
```

### 7.2 Terminal Spawn
```
User clicks "+" or command queue processes
         │
         ▼
  TerminalView mounts
         │
         ├── await document.fonts.ready
         ├── invoke('terminal_spawn', {command, cwd, rows, cols})
         │         │
         │         ▼
         │   Rust: portable-pty
         │         │
         │         ├── openpty(PtySize{rows, cols})
         │         ├── spawn shell (PowerShell / $SHELL)
         │         ├── drop slave handle
         │         ├── start spawn_blocking reader
         │         │         │
         │         │         ▼
         │         │   4KiB read loop
         │         │         │
         │         │         └── emit('terminal://output', {sessionId, data})
         │         │                  │
         │         │                  ▼
         │         │           xterm.js Terminal.write()
         │         │
         │         └── return {sessionId}
         │
         └── start listening for terminal://output, terminal://exit
```

---

## 8. Phone-Jarvis (Calling Cloud Backend)

Located in `phone-jarvis/cloud/`. Python/FastAPI + Pipecat backend.

### Architecture
- **main.py** — FastAPI app with Twilio webhook + LiveKit room endpoints
- **twilio_handler.py** — PSTN call handler via Twilio Media Streams WebSocket
- **livekit_handler.py** — In-app WebRTC calls via LiveKit
- **pipeline.py** — Pipecat voice pipeline: STT → LLM → TTS with interruption support
- **auth.py** — Supabase JWT verification, PIN validation, caller allowlist
- **bridge.py** — WebSocket bridge to local laptop for tool execution
- **bridge_endpoint.py** — HTTP endpoints for bridge operations
- **outbound.py** — Automated outbound call triggers (build failures, deadlines)
- **audit.py** — 30-day retention audit logging
- **config.py** — Environment config (API keys, Twilio credentials)
- **supabase_client.py** — Supabase client for user settings/billing

### Call Paths
| Path | Entry | Transport | STT | TTS | Latency |
|---|---|---|---|---|---|
| A inbound | Twilio phone number | PSTN μ-law audio | Deepgram Nova-3 | Cartesia Sonic 2 | ~800ms |
| A outbound | Twilio API call | PSTN μ-law audio | Deepgram Nova-3 | ElevenLabs Flash | ~1050ms |
| C in-app | LiveKit room | Opus WebRTC | Groq Whisper | Cartesia Sonic 2 | ~800ms |

### Privacy & Security
- Read-only tools by default through bridge
- File reads go through local laptop, not cloud
- Write/edit/delete actions require PIN confirmation
- Caller allowlist with optional PIN
- 30-day audit log retention
- Audit log contains caller ID, timestamp, duration, action list

---

## 9. Build, Test & Release Pipeline

### Development Commands
```bash
npm run dev              # Web-only dev (Vite, no Tauri, runs in browser)
npm run tauri:dev        # Desktop dev with hot-reload
npm run typecheck        # tsc --noEmit
npm run test             # Vitest (106 tests, 11 files)
cd app/src-tauri
cargo check              # Rust compilation check
```

### Release Build
```bash
npm run release:windows  # Full Windows release pipeline
```

The `release-windows.ps1` script:
1. Runs `npm run build` (tsc + vite production build)
2. Runs `npm run tauri:build` (Rust release compile + MSI/NSIS packaging)
3. Stages artifacts to `releases/` directory
4. Generates `latest.json` updater manifest
5. Computes SHA-256 checksums to `SHA256SUMS.txt`

### Rust Build Profile (Cargo.toml release)
- `lto = "thin"` — bulk of LTO benefits at 1/3 memory cost
- `codegen-units = 4` — parallelizes without overflow
- `opt-level = "s"` — optimize for size
- `strip = true` — strip debug symbols
- `panic = "abort"` — smaller binary, no panic unwinding

### Vite Build Features
- Manual chunk splitting (13 vendor chunks + ai-providers)
- chunkSizeWarningLimit: 700kB
- Sourcemaps enabled
- Chrome 105 / Safari 13 target

### Release Artifacts
| File | Size |
|---|---|
| `Jarvis One_0.1.14_x64_en-US.msi` | ~5.94 MB |
| `Jarvis One_0.1.14_x64-setup.exe` | ~4.87 MB |
| `.sig` (updater signature for each) | |
| `latest.json` | Updater manifest |
| `SHA256SUMS.txt` | Checksums |

---

## 10. Complete File Inventory (296 Source Files)

### Root (14 files)
| File | Purpose |
|---|---|
| `package.json` | npm workspace root |
| `CHANGELOG.md` | Version changelog |
| `DEVLOG.md` | Development action log |
| `DOWNLOAD.md` | Install & checksum guide |
| `README.md` | Project README with feature inventory |
| `SETUP.md` | Prerequisites & setup guide |
| `PROGRESS_model-access-and-ui.md` | Model access gate progress |
| `PROGRESS_v0.1.3.md` | v0.1.3 milestone progress |
| `Setup_Guide_0.1.3.html` | In-app setup guide |
| `LICENSE` | Apache 2.0 |
| `.editorconfig` | Editor settings |
| `.env.example` | Env template |
| `.gitignore` | Git ignore |
| `.prettierrc` | Prettier config |

### App Config (9 files)
| File | Purpose |
|---|---|
| `app/package.json` | @jarvis/app@0.1.14 |
| `app/vite.config.ts` | Vite build, manual chunks, dev server |
| `app/tailwind.config.ts` | Voltage design system theme |
| `app/tsconfig.json` | TypeScript config |
| `app/tsconfig.node.json` | Node TS config |
| `app/vitest.config.ts` | Vitest test runner |
| `app/index.html` | HTML entry point |
| `app/postcss.config.js` | PostCSS config |
| `app/.env.local` | Local env vars |

### Rust Backend (10 files)
| File | Purpose |
|---|---|
| `src-tauri/Cargo.toml` | Rust dependencies |
| `src-tauri/Cargo.lock` | Dependency lock |
| `src-tauri/build.rs` | Tauri build script |
| `src-tauri/tauri.conf.json` | Tauri config (window, updater, bundle) |
| `src-tauri/tauri.windows-signing.generated.json` | Windows signing config |
| `src-tauri/capabilities/default.json` | Tauri 2 capability permissions |
| `src-tauri/src/main.rs` | Entry point |
| `src-tauri/src/lib.rs` | Plugin + command registry |
| `src-tauri/src/fsread.rs` | File system commands |
| `src-tauri/src/terminal.rs` | PTY terminal backend |

### Frontend Core (5 files)
| File | Purpose |
|---|---|
| `app/src/main.tsx` | React DOM mount |
| `app/src/App.tsx` | Root app, boot wiring, lazy modals |
| `app/src/vite-env.d.ts` | Vite type declarations |
| `app/src/styles/globals.css` | Design system CSS variables |
| `app/src/test/setup.ts` | Test setup |

### Layout Components (9 files)
| File | Purpose |
|---|---|
| `components/layout/AppShell.tsx` | 3-pane responsive shell |
| `components/layout/NavPane.tsx` | Left sidebar navigation |
| `components/layout/Inspector.tsx` | Right slide-over panel |
| `components/layout/TopBar.tsx` | 28px compact toolbar |
| `components/layout/PageRouter.tsx` | Route → page dispatcher |
| `components/layout/TabStrip.tsx` | Navigation tabs |
| `components/layout/ActivityStrip.tsx` | Agent activity strip |
| `components/layout/JarvisContextMenu.tsx` | Right-click menu |
| `components/layout/index.ts` | Barrel export |

### UI Components (16 files)
| File | Purpose |
|---|---|
| `components/ui/button.tsx` | Button variants |
| `components/ui/tabs.tsx` | Tab system |
| `components/ui/popover.tsx` | Popover overlay |
| `components/ui/tooltip.tsx` | Tooltip hints |
| `components/ui/dialog.tsx` | Modal dialogs |
| `components/ui/toast.tsx` | Toast notifications |
| `components/ui/badge.tsx` | Badges |
| `components/ui/avatar.tsx` | Agent avatars |
| `components/ui/card.tsx` | Cards |
| `components/ui/switch.tsx` | Toggles |
| `components/ui/input.tsx` | Text input |
| `components/ui/textarea.tsx` | Textarea |
| `components/ui/checkbox.tsx` | Checkbox |
| `components/ui/label.tsx` | Form labels |
| `components/ui/separator.tsx` | Separators |
| `components/ui/skeleton.tsx` | Loading skeletons |

### Feature Modules — Chat (12 files)
| File | Purpose |
|---|---|
| `features/chat/ChatView.tsx` | Chat surface with drop zone |
| `features/chat/ChatThread.tsx` | Message list, auto-scroll |
| `features/chat/Composer.tsx` | Input, slash/mention typeahead, STT, attachments |
| `features/chat/MessageBubble.tsx` | Message display |
| `features/chat/MessagePart.tsx` | Part renderer (7 types) |
| `features/chat/ActionApprovalCard.tsx` | Approve/Cancel UI |
| `features/chat/ToolCallCard.tsx` | Tool result display |
| `features/chat/MentionTypeahead.tsx` | @agent typeahead |
| `features/chat/SlashCommandTypeahead.tsx` | /command typeahead |
| `features/chat/EmptyChat.tsx` | Empty state |
| `features/chat/MicWaveform.tsx` | Waveform animation |
| `features/chat/hooks.ts` | Chat query hooks |

### Feature Modules — Terminals (16 files)
| File | Purpose |
|---|---|
| `features/terminals/TerminalsPage.tsx` | Terminal workspace |
| `features/terminals/TerminalView.tsx` | xterm.js wrapper |
| `features/terminals/TileGrid.tsx` | Pane layout manager |
| `features/terminals/PaneToolbar.tsx` | Per-pane chrome |
| `features/terminals/PaneTree.ts` | Pane tree state |
| `features/terminals/AgentRolePicker.tsx` | Role selector |
| `features/terminals/ConnectedFilesButton.tsx` | File pinning |
| `features/terminals/TerminalContextMenu.tsx` | Right-click menu |
| `features/terminals/terminalCommandQueue.ts` | Spawn queue |
| `features/terminals/terminalLiveCache.ts` | Output cache |
| `features/terminals/terminalProjectMove.ts` | Cross-project drag |
| `features/terminals/terminalRefs.ts` | Terminal references |
| `features/terminals/terminalScheduler.ts` | Scheduled commands |
| `features/terminals/transcriptStore.ts` | Transcript store |
| `features/terminals/agentContext.ts` | AI context builder |
| `features/terminals/index.ts` | Barrel export |

### Feature Modules — Remaining (45+ files)
| Feature | Files | Purpose |
|---|---|---|
| `council/` | 8 | Multi-agent parallel chat |
| `settings/` | 13 | Settings with 12 tabs |
| `voice/` | 11 | STT, voice modal, wake word |
| `ambient/` | 6 | Soundscapes, idle detection |
| `assistant/` | 5 | NL command bar |
| `auth/` | 4 | Auth/access gates |
| `onboarding/` | 8 | 6-step onboarding |
| `context/` | 4 | Context maps |
| `files/` | 4 | File browser |
| `agents/` | 7 | Agent management |
| `tasks/` | 9 | Task system |
| `schedule/` | 4 | Calendar/events |
| `call/` | 6 | Phone calls |
| `kanban/` | 5 | Project board |
| `command-palette/` | 5 | Cmd+K palette |
| `launcher/` | 5 | Quick launcher |
| `tools/` | 3 | Custom tools |
| `skills/` | 6 | Skill system |
| `history/` | 4 | Chat history |
| `actions/` | 1 | Actions palette |
| `benchmarks/` | 4 | LMArena display |
| `billing/` | 2 | Subscription pages |
| `celebrate/` | 3 | Confetti |
| `dev-console/` | 4 | Debug panel |
| `projects/` | 2 | Project pages |
| `wellness/` | 2 | Eye break |
| `whats-new/` | 5 | Changelog |
| `updates/` | 1 | Update warnings |
| `account/` | 2 | Account page |

### Core Libraries (35+ files)
| Directory | Files | Purpose |
|---|---|---|
| `lib/db/` | 4 | Schema, repositories, seed, index |
| `lib/ai/` | 10 | Runtime, router, context, types, 7 providers |
| `lib/actions/` | 8 | Registry, parser, runner, addendum, types, tests |
| `lib/` (root lib) | 13 | tauri, fs, hotkeys, utils, notifications, bridge, etc. |
| `lib/bridge/` | 3 | WebSocket bridge client |
| `lib/mcp/` | 4 | MCP server registry |
| `lib/billing/` | 2 | Stripe integration |
| `lib/persistence/` | 1 | Safe localStorage |
| `lib/supabase/` | 3 | Supabase client |
| `lib/usage/` | 1 | Usage summary |

### Store + Types (13 files)
| File | Purpose |
|---|---|
| `stores/ui.ts` | UI state (40 fields) |
| `stores/auth.ts` | Auth state |
| `stores/agents.ts` | Agent runtime |
| `types/common.ts` | Base types |
| `types/agent.ts` | Agent types |
| `types/chat.ts` | Chat/message types |
| `types/task.ts` | Task types |
| `types/event.ts` | Event types |
| `types/memory.ts` | Memory types |
| `types/terminal.ts` | Terminal types |
| `types/quick-link.ts` | Link types |
| `types/integration.ts` | Integration types |
| `types/index.ts` | Barrel export |

---

*Generated from codebase analysis. Version: 0.1.14 | Date: 2026-06-04 | Total source files: ~296*

*Sources analyzed: All .ts, .tsx, .rs, .json, .toml, .md, .sql, .py files at C:\Users\viper\projects\Jarvis*
