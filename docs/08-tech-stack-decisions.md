# VibeSpace - Tech Stack Decisions

*Decision log for the major technology choices. Each section: what we picked, alternatives considered, and why.*

---

## Shell & desktop runtime

**Picked:** Tauri 2 + Rust core + Next.js 15 (App Router, SPA mode) + React 19 + TypeScript 5.6.

**Alternatives:** Electron, Wails, Neutralino, native (Swift/AppKit + WinUI), Flutter Desktop.

**Why Tauri:**
- Bundle size is 5-15 MB vs Electron's 100+ MB.
- Rust core gives us native filesystem, audio, hotkey, and OS-integration APIs without bridges.
- Memory footprint is half of Electron's.
- BridgeMind, Linear's desktop, Spacedrive, and a growing list of AI-native apps are on Tauri 2 - the ecosystem is maturing fast.
- Same web frontend works in the future Tauri-Mobile build (iOS/Android) for code reuse.

**Trade-offs:** WebView2 (Windows) and WebKit (macOS/Linux) have minor rendering differences vs Chromium-everywhere; we accept it for the bundle/memory wins.

---

## Frontend framework

**Picked:** Next.js 15 (App Router, SPA export inside Tauri) + React 19 + Tailwind CSS v4 + shadcn/ui.

**Alternatives:** Vite + React, SolidStart, SvelteKit, Astro.

**Why Next + React:**
- Largest hiring pool and ecosystem.
- Server Components and Actions don't apply inside Tauri but Next gives us the routing, layouts, and tooling we want.
- shadcn/ui is the component foundation everyone in this aesthetic uses; it's Tailwind-native and we own the source.

**Tailwind v4** because the new engine is dramatically faster, the CSS-first config matches our design system better, and shadcn moved to v4.

---

## Component library & visual stack

**Picked:**
- **shadcn/ui** - foundation (Radix primitives, copy-paste, full ownership).
- **Magic UI** - animated accents (Animated Beam, Border Beam, Shine Border, Particles, Bento Grid).
- **Aceternity UI** - selective hero pieces (Spotlight, Aurora Background, Glowing Effect, Floating Dock).
- **Tremor** - charts and analytics.
- **cmdk** - command palette engine.
- **Motion v12** (formerly Framer Motion) - all animation.
- **Lucide** + **Phosphor Duotone** - iconography.
- **Spline** - single 3D scene (voice orb).

**Alternatives:** Mantine, NextUI/HeroUI, Park UI, Chakra. All rejected because the shadcn ecosystem has ~10x the velocity and the entire AI-app design movement is built on it.

---

## Orchestration framework

**Picked:** Mastra (TypeScript) as the primary orchestrator, **Vercel AI SDK 6** for streaming UI primitives, **OpenAI Agents SDK** as a optional Python sidecar for advanced workflows.

**Alternatives:** LangGraph (TS or Py), CrewAI, Microsoft Agent Framework, Google ADK, Pydantic AI, raw Vercel AI SDK only.

**Why Mastra + Vercel AI SDK:**
- TS-native and our entire runtime is TS - no Python sidecar required for orchestration.
- Mastra ships agents, workflows, memory primitives, and a Studio UI we can crib from.
- Vercel AI SDK is best-in-class for streaming multiple agent outputs and rendering tool calls in the UI; it pairs cleanly with Mastra.
- Both are MIT/Apache and actively maintained.

**Why not LangGraph as primary:** TS version exists but the Python version has the larger ecosystem; choosing it forces a Python backend or a JS/Py split. We avoid that complexity. We may add a LangGraph-Py worker pool later for specific deep-research workflows.

---

## Multi-agent topology

**Picked:** Supervisor + specialist workers + parallel fan-out, with a memory agent and a VibeSpace voice supervisor.

Detailed in `docs/03-multi-agent-orchestration.md`.

**Why:** Anthropic's published evidence (90.2% improvement over single-agent on Research) plus our requirement for parallel multi-model chat plus the supervisor architecture being the most teachable pattern to users. Other patterns (sequential, hierarchical, swarm) are available as workflow templates but not the default.

---

## Model routing

**Picked:** **LiteLLM** as the routing gateway (self-hosted in VibeSpace Cloud for the managed plan; users can run their own for BYOK Pro+).

**Alternatives:** OpenRouter, Vercel AI Gateway, raw provider SDKs.

**Why LiteLLM:**
- Production-grade routing with weighted, latency, cost, and least-busy strategies.
- Cooldowns and retries handled at the gateway, not in agent code.
- Self-hostable, so privacy-sensitive users can run their own.
- 200+ providers supported including local Ollama.

**Default model tiers:**
| Role | Primary | Fallback | Local fallback |
|---|---|---|---|
| Supervisor / VibeSpace | Claude Opus 4.x | GPT-5.5 | Llama 3.3 70B (cloud) -> Llama 3.1 8B (local) |
| Worker (general) | Claude Sonnet 4.x | GPT-5-mini | Qwen 3 14B local |
| Worker (cheap/fast) | Gemini Flash 3.x | GPT-5-nano | Qwen 3 8B local |
| Coding worker | Claude Sonnet 4.x | GPT-5.5 | DeepSeek-Coder 6.7B local |
| Embedding | OpenAI text-embedding-3-large | Voyage-3 | bge-large-en-v1.5 local |

---

## Memory & vector storage

**Picked:** **LanceDB** (embedded, Rust core, Apache 2.0) for local, **Qdrant** (managed) for cloud sync. **mem0** as the memory framework on top.

**Alternatives:** Chroma, pgvector, Weaviate, raw FAISS, Pinecone.

**Why LanceDB + Qdrant + mem0:**
- LanceDB ships as a Rust crate, so it lives inside the Tauri main process with zero extra processes. Stores millions of vectors locally.
- Qdrant is the production-grade managed vector store; Apache 2.0 source-available.
- mem0 gives us the memory abstractions (extract, store, retrieve, decay) without rebuilding.
- We may swap mem0 for Letta if we need explicit memory blocks per persona.

---

## Tool ecosystem

**Picked:** **MCP (Model Context Protocol)** as the universal tool interface. Native in-process tools only when MCP overhead isn't justified.

**Why:** MCP is the de facto standard. Cursor, Claude, Cline, VS Code, Windsurf all speak it. Building our own plugin API would put us in a corner; speaking MCP makes every existing server work in VibeSpace on day one.

**MCP servers we ship by default:**
- Filesystem (read-only by default, opt-in write)
- Shell (gated, no destructive ops without approval)
- Git
- Playwright (browser automation)
- Web search (Brave + SerpAPI fallback)
- Memory (our own memory system, exposed as MCP)
- Calendar (Google Cal + Outlook via OAuth)
- Mail (Gmail + Outlook)
- Notion, Slack, Linear, GitHub (one-click OAuth installs)

---

## Sandboxing

**Picked:** **WebContainers** (in-app browser-based code execution) + **E2B** (cloud sandboxes for heavier workloads) + **Docker** (power users with daemon installed).

**Why:** WebContainers is zero-cost (runs in the WebView), works offline-ish, and covers Node-compatible workloads. E2B is the production reference for cloud agent sandboxes. Docker as opt-in for advanced users.

---

## Voice stack

Detailed decisions in `docs/04-voice-jarvis-layer.md`. Headline:

- Wake word: openWakeWord (free) / Picovoice Porcupine (paid).
- VAD: Silero v6.
- Turn detector: LiveKit Qwen2.5-0.5B.
- STT: Deepgram Flux primary, Cartesia Ink 2 fallback, Moonshine Medium offline.
- TTS: Cartesia Sonic 3.5 primary, ElevenLabs Flash v2.5 fallback.
- S2S: OpenAI gpt-realtime, Gemini Live alt.
- Orchestration: Pipecat (Python sidecar).

---

## Database

**Picked:** **SQLite** via **better-sqlite3** for local, **Postgres** (Neon or Supabase) for cloud sync.

**Why SQLite local:** zero ops, fast, atomic writes, ships with the app. better-sqlite3 is synchronous (faster than node-sqlite3 for embedded use) and perfect for a single-process runtime.

**Why Postgres cloud:** mature, JSONB for flexible schemas, pgvector if we want a single store for relational + vector, managed options (Neon serverless or Supabase) reduce ops to nothing.

**ORM:** **Drizzle** - lightweight, TS-native, supports both SQLite and Postgres with the same schema definitions.

---

## State management & data fetching

**Picked:** **Zustand** for UI state, **TanStack Query** for server/runtime state, **TRPC** for the runtime API surface.

**Why:** Zustand is the boring, fast pick for client state in modern React apps. TanStack Query handles cache, refetch, optimistic updates. TRPC gives us end-to-end type safety from the runtime to the UI without a schema layer.

---

## Authentication & identity

**Picked:** **Clerk** for consumer auth (email + Google + Apple SSO + passkeys), with the option to swap to **WorkOS** for enterprise tier later.

**Why Clerk:** ships passkeys, social login, email magic links, MFA, and pre-built React components. We don't want to build auth.

**Local mode** (no account): everything works offline; a local user is created with a key in the OS keychain.

---

## Notifications

**Picked:**
- **Tauri's `tauri-plugin-notification`** for OS-native banners on desktop.
- **APNs** (iOS) and **FCM** (Android) for mobile push.
- **Web Push** for browser extension.
- **Resend** for email digests; **Twilio** for SMS (optional).

Detailed in `docs/06-todo-scheduler-notifications.md`.

---

## Observability

**Picked:**
- **OpenTelemetry** as the trace + metric standard.
- **Logfire** (Pydantic team) or self-hosted **Grafana + Tempo + Loki + Prometheus** for visualization.
- **Sentry** for error tracking.
- **PostHog** for opt-in product analytics (privacy-respecting, self-hostable).

**Why:** open standards-first; users running self-hosted should be able to point at their own backend.

---

## Build & deploy

**Picked:**
- **Bun** as the runtime + package manager + bundler for the Node sidecar (faster than pnpm/Node).
- **Vite** under the hood for the Next.js dev server when running standalone.
- **Tauri's bundler** (cargo-tauri) for desktop builds. Code-signing on macOS (notarized) and Windows.
- **GitHub Actions** for CI; **Tauri Action** for cross-platform builds.
- **Cloudflare** for the marketing site, downloads, and API edge.
- **Fly.io** for the cloud runtime services (LiteLLM, sync API, push). Postgres on **Neon**. Vector on **Qdrant Cloud** (or self-hosted on Fly).

---

## Languages & versions

| Language | Version | Where |
|---|---|---|
| TypeScript | 5.6+ | UI, runtime, mobile |
| Rust | 1.78+ | Tauri main, native helpers |
| Python | 3.12+ | Voice sidecar |
| SQL | PostgreSQL 16 | Cloud DB |

---

## Licensing strategy (placeholder, decision pending)

Working assumption: **Apache 2.0** for the core desktop app and runtime, **commercial source-available** for the cloud services (sync, marketplace, voice infra). Users running fully self-hosted can clone the OSS core and run everything locally; users on the managed plan get the convenience of our hosted services.

This mirrors what Cline, Open WebUI, and Mastra do; it builds an ecosystem moat without giving away the business.

---

## Stack summary - one screen

```
DESKTOP
  Tauri 2 (Rust)
  Next.js 15 + React 19 + TypeScript 5.6
  Tailwind v4 + shadcn/ui + Magic UI + Aceternity UI + Tremor
  Motion v12, cmdk, Lucide + Phosphor, Spline (voice orb only)

RUNTIME (Node sidecar)
  Mastra orchestrator + Vercel AI SDK 6 streaming
  LiteLLM gateway, MCP client manager
  better-sqlite3 + Drizzle, LanceDB embedded
  Zustand + TanStack Query + TRPC
  mem0 memory framework

VOICE (Python sidecar)
  Pipecat + Silero VAD + openWakeWord + LiveKit turn-detector
  Deepgram Flux / Cartesia Ink / Moonshine Medium STT
  Cartesia Sonic 3.5 / ElevenLabs Flash TTS
  OpenAI gpt-realtime alt path

CLOUD (optional)
  Clerk auth, Fly.io services, Neon Postgres, Qdrant Cloud
  LiveKit Cloud (WebRTC voice for browser/mobile)
  APNs / FCM / Web Push, Resend email, Twilio SMS

MOBILE (Phase 2)
  React Native + Expo, sharing data + types via TRPC
  Native push, voice via LiveKit Cloud

OBSERVABILITY
  OpenTelemetry + Logfire/Grafana stack
  Sentry, PostHog (opt-in)
```
