# Jarvis - Phased Implementation Plan

*Build plan from zero to public launch. Six phases, ~12-15 months end-to-end. Aggressive but achievable for a focused team of 4-6.*

---

## Team assumptions

- **Founder / product** (you).
- **2-3 full-stack TypeScript engineers** (Tauri, Next, Mastra).
- **1 voice / Python engineer** (Pipecat, Silero, all the audio stuff).
- **1 designer** (figma, motion, brand).
- **0.5 DevOps + infra** (part-time or contracted; Fly, Neon, Qdrant, CI).

If team is smaller, phases stretch. The dependencies below are real; nothing is optional in the order described.

## Phase summary

| Phase | Duration | Outcome | Key risk |
|---|---|---|---|
| 0 - Foundations | 3 weeks | Repo, CI, Tauri shell with empty UI runs on all 3 OSes | Bundling Tauri + Python sidecar |
| 1 - MVP single-agent chat | 6 weeks | One agent, one model, persistent memory, basic to-do | Memory retrieval quality |
| 2 - Multi-agent council | 6 weeks | Mastra orchestrator, parallel agents, council UI | Inter-agent state coherence |
| 3 - Voice (Jarvis) layer | 8 weeks | Sub-450ms cascade voice, wake word, voice-driven to-do | Latency budget on Windows |
| 4 - Smart scheduler + notifications | 4 weeks | Auto-extract action items, smart reminders, OS notifications | Reminder quality (false positives) |
| 5 - Mobile + polish + closed beta | 6 weeks | iOS app, polish pass, 500-user closed beta | App Store review |
| 6 - Public launch + cloud + marketplace | 8 weeks | Public release, sync, MCP marketplace, billing | Scaling cloud infra |

**Total: ~10-11 months of focused build to public launch.**

---

## Phase 0 - Foundations (3 weeks)

### Goals
- Monorepo structure works.
- Tauri 2 shell builds and runs on Mac, Windows, Linux.
- Empty Next.js + shadcn UI ships.
- Python voice sidecar boots and shakes hands over IPC.
- CI pipeline produces signed builds.

### Deliverables
- Repo at `github.com/jarvis/jarvis`. Apache 2.0 license.
- `apps/desktop/` (Tauri + Next), `apps/runtime/` (Node sidecar), `apps/voice/` (Python sidecar), `packages/ui/`, `packages/core/`, `packages/types/`, `packages/db/`.
- GitHub Actions: lint + test + build for all 3 OSes on every PR.
- Tauri code-signing: Apple Developer ID + Windows EV cert procured.
- `~/.jarvis/` filesystem laid out, `runtime.session` token logic implemented.
- Tauri main <-> Node sidecar JSON-RPC working.
- Tauri main <-> Python sidecar Unix socket / named pipe working.
- Empty UI with three-pane shell, dark theme, Lucide icons.

### Cuts
- No agents yet. No voice yet. No tasks yet. Pure plumbing.

### Exit criteria
- New engineer can clone, run, and contribute in <30 minutes.
- Signed install ships from CI to GitHub Releases.

---

## Phase 1 - MVP single-agent chat (6 weeks)

### Goals
- One agent (Claude Sonnet) responds in a chat thread with streaming.
- Persistent memory: chats survive app restart, items embedded into LanceDB, retrieved on next turn.
- Basic to-do list: create, list, complete (no smart scheduling yet, no notifications yet).
- One MCP server connected (filesystem, read-only).
- Settings page: API keys, theme.

### Deliverables
- Mastra agent definition: `Jarvis-base` with Sonnet, basic system prompt, memory tool.
- Vercel AI SDK streaming wired through to UI message stream protocol.
- Drizzle schema for `Workspace`, `Project`, `Chat`, `Message`, `Part`, `MemoryItem`, `Task`, `Reminder`.
- LanceDB embedded in Tauri main, accessible from Node sidecar.
- mem0 wrapper service for read/write.
- Auto-extract Memory Keeper agent (background; runs after every turn).
- MCP filesystem server runs as stdio child process, surfaced as a tool.
- Basic to-do panel UI with manual create / check-off.
- Cmd+K palette with: switch chat, new chat, settings.
- BYOK setting for OpenAI/Anthropic/Google.

### Cuts
- No multi-agent yet (single Sonnet only).
- No voice yet.
- No notifications.
- No smart scheduling.
- No mobile.

### Risks
- **Memory retrieval quality.** Bad retrievals at this stage will haunt every later feature. Spend 1.5 weeks tuning embedding chunking, recency boosting, and metadata filtering. Build a 50-prompt regression suite *now*.
- **MCP server lifecycle bugs.** Stdio child processes leaking, zombie processes on restart. Spend 3 days on robust process management.

### Exit criteria
- Internal team uses Jarvis daily for 2 weeks. Memory recall feels useful, not annoying. Crashes < 1/day per user.

---

## Phase 2 - Multi-agent council (6 weeks)

### Goals
- Council orchestrator (Mastra workflows) with supervisor + workers.
- Council mode UI: 2x2 panel grid, mention routing, animated beams.
- Synthesize button (Critic agent merges multiple answers).
- Tool registry with approval gates.
- Three default agents: Researcher, Coder, Writer.
- LiteLLM gateway integrated for model routing across providers.
- Trace viewer (inspector tab).

### Deliverables
- `Council` Mastra workflow type. State schema.
- Worker registry JSON + UI to install/clone/edit agents.
- Council mode UI components: AgentPanel, AnimatedBeam, ActivityStrip.
- @mention typeahead (cmdk-based) in the input.
- Synthesize button -> Critic agent -> single answer with disagreement flags.
- Inspector tabs: Context, Tools, Trace, Refs.
- Tool approval gates (per-call, per-session, always-allow).
- LiteLLM proxy integrated; cost meter live in UI.
- 5 more MCP servers wired: shell, git, web search, Playwright, Notion.
- 20-task eval suite running in CI.

### Cuts
- No voice yet.
- No real Smart Scheduler yet (still manual reminders).
- No mobile.
- No marketplace.

### Risks
- **State coherence across multiple streaming agents.** Race conditions in shared state. Solve with Mastra's typed state primitives + tests.
- **Tool approval UX is annoying.** Iterate on per-tool defaults; ship sensible policies.

### Exit criteria
- Council mode delivers visibly better answers than chat mode on a 50-prompt benchmark.
- Multi-provider routing falls over gracefully when a provider is rate-limited.

---

## Phase 3 - Voice (Jarvis) layer (8 weeks)

### Goals
- Wake word ("Hey Jarvis") works on all three OSes.
- Push-to-talk hotkey works globally.
- Cascade voice path delivers <500ms median latency.
- S2S path (gpt-realtime) delivers <450ms median.
- Voice intents: chat, task_create, task_modify, task_complete, agent_route, app_command.
- Apple-Intelligence-style glow border + Spline orb.
- Persona selection (Jarvis, Athena, Edge, Watson, HAL).

### Deliverables
- Pipecat sidecar with full pipeline: openWakeWord -> Silero VAD -> Krisp/RNNoise -> Deepgram Flux -> LiteLLM -> Cartesia Sonic -> audio out.
- Alternative path: gpt-realtime with LiveKit turn-detector overriding built-in.
- Intent classifier (Haiku) wired to first 150ms of streaming partial.
- Voice intent handlers for each intent type.
- Glow border CSS animation.
- Spline orb scene + audio-amplitude reactivity.
- Voice modal UI with transcript captions.
- Tray icon with mic state.
- Persona prompts authored and tested.
- Speaker enrollment flow (Picovoice Eagle).

### Cuts
- Vision-in-the-loop (Gemini Live) deferred.
- Multi-language voice deferred.
- Voice cloning deferred.

### Risks
- **Windows latency.** Wake word + WASAPI loopback + real-time audio path is harder on Windows than Mac. Budget 2 weeks for OS-specific tuning.
- **OpenAI Realtime API regional/availability variance.** Have Gemini Live ready as drop-in alt path.
- **Intent classifier accuracy.** Bad classification -> wrong intent -> user trust crashes. Spend a full week on the classifier prompt + few-shot examples + fallback to "Unsure - say again?".

### Exit criteria
- Internal team uses voice as primary input for a full week.
- Median round-trip <500ms on broadband (cascade), <450ms (S2S).
- 95%+ correct intent classification on 200-prompt test suite.

---

## Phase 4 - Smart scheduler + notifications (4 weeks)

### Goals
- Smart scheduler picks reminder times using calendar, energy patterns, deadline pressure.
- Action Extractor agent (chats only at MVP - meetings come later).
- OS native notifications across desktop + mobile-coming.
- Daily plan briefing.
- Apple Reminders + Google Tasks two-way sync.

### Deliverables
- Scheduler engine (TS) with deadline pressure curve, candidate slot scoring, smart_reason generation.
- Quiet hours, DND/Focus integration on Mac + Windows.
- Tauri notification plugin wired with rich actions (Done, Snooze, Open).
- Snooze popover (15m / 1h / tonight / tomorrow / custom / "after my next meeting").
- Action Extractor agent runs after every chat turn; surfaces drafts in to-do panel.
- Daily plan briefing card (in-app at MVP; voice version in Phase 5).
- EventKit (Apple Reminders) integration on Mac.
- Google Tasks OAuth + sync.
- Smart silencing (rate-limit after 3 dismissals).

### Cuts
- Mobile push (Phase 5).
- Watch (Phase 6).
- Email/SMS digests (Phase 6).
- Linear / Notion / Todoist sync (Phase 6).
- Auto-complete detection (Phase 6).
- Meeting extraction (depends on meeting capture pipeline - Phase 6+).

### Risks
- **False-positive reminders.** Bad smart scheduling -> users disable notifications -> feature dies. Heavy testing required.
- **Calendar permission UX.** Apple's calendar permission dialog is intimidating. Onboarding copy matters.

### Exit criteria
- 60%+ of fired reminders result in completion within 4 hours.
- < 5% of reminders dismissed as "wrong time."
- Action Extractor surfaces useful drafts on >= 30% of chats with action-shaped content.

---

## Phase 5 - Mobile + polish + closed beta (6 weeks)

### Goals
- iOS app (read-only chat + task viewer + voice + push notifications).
- Polish pass: animations, empty states, onboarding flow.
- Skill bundles: definition, packaging, local install.
- Bug burn-down to <2 P0 bugs.
- Closed beta with 500 users.

### Deliverables
- React Native + Expo iOS app.
- TRPC end-to-end types shared with desktop.
- APNs registration + push for reminders.
- Voice on mobile via LiveKit Cloud.
- Skill JSON schema, local install flow, sample skills shipped.
- 5-step onboarding flow with Spline hero.
- Empty-state illustrations (commissioned set of 8-10).
- Help center / docs site (Mintlify or similar).
- Closed beta program: 500 users, Discord community, weekly office hours.

### Cuts
- Android app (Phase 6).
- Marketplace (Phase 6).
- Cloud sync (Phase 6).
- Browser extension (Phase 7).

### Risks
- **App Store review.** First submission usually rejected for vague reasons. Plan 2 review cycles.
- **Beta feedback overwhelms team.** Establish triage process before launching beta.

### Exit criteria
- 500 weekly active beta users.
- D7 retention >= 40%.
- NPS >= 30 (good for an early product).
- 4+ chat threads per user per week.

---

## Phase 6 - Public launch + cloud + marketplace (8 weeks)

### Goals
- Public launch on Product Hunt + Hacker News.
- Cloud sync with E2EE.
- Auto-complete detection for tasks.
- Meeting capture (Granola-style system audio).
- Skills marketplace with creator revenue share.
- Stripe billing for managed plans.
- Watch + Wear OS support.

### Deliverables
- Cloud services on Fly.io: sync API, push relay, voice infra.
- Postgres on Neon, Qdrant Cloud for vector sync.
- E2EE with user-derived key; passphrase-based recovery.
- Auto-complete detection (git PR merge, calendar event passage, voice "I just did X").
- System audio capture pipeline (ScreenCaptureKit on Mac, WASAPI loopback on Win).
- Meeting transcript flow into memory + Action Extractor.
- Skills marketplace UI + Stripe Connect for creator payouts.
- Skill submission + review queue + automated security checks.
- Apple Watch companion + Wear OS app (read tasks + complete + push).
- Stripe billing: Local tier free, Managed $20/$50/mo, Pro+ $80/mo.
- Public launch site, demo videos, Product Hunt prep, HN post drafted.
- Press kit + first-tier reviewer outreach.

### Risks
- **Cloud scaling on launch day.** Pre-warm Fly machines, capacity-test the sync API for 10x expected load.
- **Marketplace bad actors.** Manual review queue + auto-flag for filesystem/network breadth.
- **App Store reviewers blocking system-audio capture.** Have macOS sandbox-mode build as fallback.

### Exit criteria
- 25,000 MAU by 90 days post-launch.
- 5,000 paying subscribers.
- $1M ARR run-rate.
- D30 retention >= 45%.

---

## Post-launch roadmap (Phase 7+, sketch only)

- **Phase 7:** Browser extension (Chrome/Firefox/Safari). Linear/Notion/Todoist/GitHub deeper sync. SMS/email digests.
- **Phase 8:** Shared canvases (multi-user real-time collaboration). Slack/Teams app. Team plans.
- **Phase 9:** Vision-in-the-loop (Gemini Live - Jarvis sees your screen). Multi-language voice. Voice cloning (paid tier).
- **Phase 10:** Enterprise tier - SOC 2 Type II, SSO, audit logs, dedicated tenant. AirPods Pro / Pixel Buds Pro as primary audio surface. Custom hotword commercial training.

## Cross-cutting workstreams (running through every phase)

- **Eval suite expansion.** Goal: 200 tasks by Phase 6, 500 by year 2. Run on every PR.
- **Performance budget.** Bundle <30 MB, cold start <2s, voice latency <500ms. CI gates on regressions.
- **Security audit.** External pentest before public launch. Annual after that.
- **Documentation.** Treat docs as a P1. Ship docs with every feature in the same PR.
- **Community.** Discord from week 1. Weekly office hours from Phase 5. Monthly changelog post.

## What we're not building (year 1)

- A code editor (we integrate with Cursor/VS Code via MCP).
- A team chat product.
- A CRM.
- A meeting bot for Zoom/Teams (we capture system audio Granola-style).
- An enterprise sales motion.

---

## Critical-path dependencies

```
Phase 0
  v
Phase 1 (MVP single-agent + memory + basic todo)
  v
Phase 2 (multi-agent council) <----+
  v                                |
Phase 3 (voice)                    |
  v                                |
Phase 4 (smart scheduler + notifs) |
  v                                |
Phase 5 (mobile + polish + beta) --+
  v
Phase 6 (public launch + cloud + marketplace)
```

**The single biggest schedule risk:** Phase 3 (voice). Latency tuning on Windows + S2S API variance + intent classifier quality each have a 30% chance of slipping a week. Plan a 2-week buffer.

**The single biggest quality risk:** Phase 1 memory quality. Everything downstream depends on it. Don't ship Phase 1 with mediocre memory. Add a week if needed.
