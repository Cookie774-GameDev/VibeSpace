# Jarvis

> **The AI workspace where every model, every agent, every voice, and every task lives under one persistent memory and one always-available assistant.**

A category-defining clone of (and improvement on) **BridgeMind** - extended into a full multi-modal workspace with a Jarvis-style overarching voice assistant, a live to-do list with smart scheduling and notifications, persistent unified memory across chats / voice / meetings / files, and a multi-agent council mode.

This repository contains **planning, research, and design only**. No application code yet - this is the spec for what we're going to build.

Working title is "Jarvis." Final product name TBD before public launch.

---

## Quick links

### Product docs (read in order)
1. [`docs/01-product-vision.md`](docs/01-product-vision.md) - thesis, north-star user story, audience, pillars, comparison vs BridgeMind/Cursor/Lindy/Granola/ChatHub
2. [`docs/02-system-architecture.md`](docs/02-system-architecture.md) - top-level technical blueprint, components, processes, storage, security
3. [`docs/03-multi-agent-orchestration.md`](docs/03-multi-agent-orchestration.md) - the agent runtime: supervisor + workers, inter-agent messaging, memory access, tool calling, observability
4. [`docs/04-voice-jarvis-layer.md`](docs/04-voice-jarvis-layer.md) - the voice subsystem: wake word, dual-path cascade + S2S, latency budget, persona, intents, failure modes
5. [`docs/05-ui-ux-design.md`](docs/05-ui-ux-design.md) - design blueprint: "Voltage" aesthetic, three-pane shell, council mode, voice modal, to-do panel, keyboard alphabet
6. [`docs/06-todo-scheduler-notifications.md`](docs/06-todo-scheduler-notifications.md) - **the live to-do system**: data model, smart scheduler, action extractor, multi-channel notifications, voice intents, daily briefing
7. [`docs/07-differentiation-strategy.md`](docs/07-differentiation-strategy.md) - the 13 capabilities Jarvis ships that no competitor combines, the moat, the risks
8. [`docs/08-tech-stack-decisions.md`](docs/08-tech-stack-decisions.md) - decision log for every major technology choice with alternatives considered

### Implementation
- [`implementation-plan/00-phased-plan.md`](implementation-plan/00-phased-plan.md) - 6-phase build plan, ~10-11 months end-to-end to public launch

### Research (raw subagent reports)
- [`research/01-bridgemind-analysis.md`](research/01-bridgemind-analysis.md) - exhaustive BridgeMind product breakdown
- [`research/02-multi-agent-orchestration.md`](research/02-multi-agent-orchestration.md) - 2026 multi-agent frameworks and patterns
- [`research/03-voice-assistant-tech.md`](research/03-voice-assistant-tech.md) - 2026 voice stack: STT, TTS, S2S, wake word, latency
- [`research/04-competitive-landscape.md`](research/04-competitive-landscape.md) - every multi-AI / multi-agent app on the market
- [`research/05-ui-ux-trends.md`](research/05-ui-ux-trends.md) - 2026 AI-app design trends and reference apps

---

## What is Jarvis (one-paragraph)

Jarvis is a desktop-first AI workspace (Win/Mac/Linux, Tauri-based) that unifies what today is fragmented across seven apps. You talk to **Jarvis** - an always-available voice assistant with sub-450ms latency. Jarvis routes your requests to a council of specialized AI agents (Claude, GPT, Gemini, plus local Llama/Qwen) running in parallel with shared memory and structured inter-agent messaging. A live to-do list managed by Jarvis captures everything you commit to (extracted automatically from chats and meetings, or created via voice) and reminds you intelligently across desktop banners, mobile push, watch, voice, and email. Persistent memory threads through chats, voice, meetings, browsing, files, and tasks - searchable, source-referenced, exportable, local-first by default with optional encrypted cloud sync. MCP-native tooling means every existing MCP server works on day one. Open-source core (Apache 2.0) with optional managed cloud.

## What makes it different from BridgeMind

BridgeMind nails the multi-pane terminal grid for coding agents. Jarvis takes that idea, generalizes it past coding, and adds:
- Voice-first overarching assistant (not just dictation - full conversational with intent routing).
- Live to-do list + smart scheduling + multi-channel notifications.
- Persistent memory across all modalities (chats, voice, meetings, browsing, files).
- Parallel multi-model council with ensemble synthesis (not just one agent at a time).
- Mobile companion + browser extension + watch.
- True local-first option with encrypted cloud sync bridge.
- Open-source core.

Detailed comparison in [`docs/07-differentiation-strategy.md`](docs/07-differentiation-strategy.md).

## Folder layout

```
projects/Jarvis/
+- README.md                          this file
|
+- docs/                              product, architecture, design
|   +- 01-product-vision.md
|   +- 02-system-architecture.md
|   +- 03-multi-agent-orchestration.md
|   +- 04-voice-jarvis-layer.md
|   +- 05-ui-ux-design.md
|   +- 06-todo-scheduler-notifications.md
|   +- 07-differentiation-strategy.md
|   +- 08-tech-stack-decisions.md
|
+- research/                          raw research reports
|   +- 01-bridgemind-analysis.md
|   +- 02-multi-agent-orchestration.md
|   +- 03-voice-assistant-tech.md
|   +- 04-competitive-landscape.md
|   +- 05-ui-ux-trends.md
|
+- implementation-plan/               build plan
|   +- 00-phased-plan.md
|
+- design/                            (empty - reserved for figma exports, mockups)
```

## Stack at a glance

```
DESKTOP        Tauri 2 (Rust) + Next.js 15 + React 19 + TypeScript 5.6
                Tailwind v4, shadcn/ui, Magic UI, Aceternity UI, Tremor
                Motion v12, cmdk, Lucide + Phosphor, Spline (voice orb)

RUNTIME        Mastra orchestrator + Vercel AI SDK 6 streaming
(Node sidecar) LiteLLM gateway, MCP client manager
                better-sqlite3 + Drizzle, LanceDB embedded
                Zustand + TanStack Query + TRPC, mem0 memory

VOICE          Pipecat + Silero VAD + openWakeWord + LiveKit turn-detector
(Python)       Deepgram Flux / Cartesia Ink / Moonshine STT
                Cartesia Sonic 3.5 / ElevenLabs Flash TTS
                OpenAI gpt-realtime / Gemini Live alt path

CLOUD          Clerk auth, Fly.io services, Neon Postgres, Qdrant Cloud
(optional)     LiveKit Cloud, APNs / FCM / Web Push, Resend, Twilio

MOBILE         React Native + Expo (Phase 5)
(Phase 5)      Native push, voice via LiveKit Cloud
```

Detailed reasoning for every choice in [`docs/08-tech-stack-decisions.md`](docs/08-tech-stack-decisions.md).

## Five core pillars

1. **Council of agents** - multiple AI models in parallel, mention-routable, synthesizable.
2. **Persistent unified memory** - one local-first memory across every modality.
3. **Jarvis voice layer** - always-available, sub-450ms, can do anything in the app.
4. **Live to-do list + smart scheduler + notifications** - native task system Jarvis owns.
5. **MCP-native tool ecosystem** - curated marketplace, sandboxed by default.

## Phased build plan (summary)

| Phase | Duration | Outcome |
|---|---|---|
| 0 - Foundations | 3 weeks | Repo, CI, Tauri shell on all OSes |
| 1 - MVP single-agent chat | 6 weeks | One agent, memory, basic to-do |
| 2 - Multi-agent council | 6 weeks | Mastra orchestrator, council UI, tools |
| 3 - Voice (Jarvis) layer | 8 weeks | Sub-450ms voice, wake word, intents |
| 4 - Smart scheduler + notifications | 4 weeks | Auto-extract, smart reminders, OS notifs |
| 5 - Mobile + polish + closed beta | 6 weeks | iOS, polish, 500-user beta |
| 6 - Public launch + cloud + marketplace | 8 weeks | Stripe, sync, marketplace, watch |

Total: ~10-11 months focused build to public launch. Detail in [`implementation-plan/00-phased-plan.md`](implementation-plan/00-phased-plan.md).

## What this isn't (yet)

- **No code.** Pure planning docs. Implementation starts after these are reviewed.
- **No name.** "Jarvis" is the working title. Trademark search and naming exercise required before public launch.
- **No team.** Plan assumes 4-6 person team; if smaller, phases stretch.
- **No designs.** Figma mockups will live in `design/` once they exist.

## Source material

This planning effort was produced via 5 parallel research subagents that scraped the public web for:
1. BridgeMind product and ecosystem (the inspiration).
2. Multi-agent orchestration frameworks and patterns (2026).
3. Voice assistant tech stack (STT, TTS, S2S, wake word).
4. Competitive landscape (every shipping multi-AI app).
5. UI/UX trends (2026 AI-app design language).

Raw reports are preserved in [`research/`](research/) for traceability. The `docs/` folder distills them into actionable design and architecture decisions.

---

*Generated: May 28, 2026.*
