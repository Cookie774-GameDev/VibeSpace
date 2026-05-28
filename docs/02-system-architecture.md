# Jarvis - System Architecture

*Companion to `01-product-vision.md`. This document is the high-level technical blueprint.*

---

## 1. One-page diagram (textual)

```
+--------------------------------------------------------------------------------+
|                              JARVIS DESKTOP APP                                |
|                          (Tauri 2 shell + Next.js UI)                          |
|                                                                                |
|  +---------+  +---------+  +-----------+  +----------+  +-------------------+  |
|  |  Nav    |  |  Main   |  |  Inspector|  |  Tray    |  | Floating Voice    |  |
|  |  pane   |  |  canvas |  |  + tools  |  |  micro   |  | orb + glow border |  |
|  |         |  |  (chat/ |  |  history  |  |  app     |  |                   |  |
|  | projects|  | council)|  |           |  |          |  |                   |  |
|  +---------+  +---------+  +-----------+  +----------+  +-------------------+  |
|                                                                                |
|  +-----------------------------------------------------------------------+    |
|  |                         CORE RUNTIME (TypeScript)                     |    |
|  |  - Mastra orchestrator       - Vercel AI SDK streaming                |    |
|  |  - MCP client manager        - Tool registry / sandbox manager        |    |
|  |  - Memory router             - Scheduler + Notification engine        |    |
|  |  - Cost meter                - Eval harness                           |    |
|  +-----------------------------------------------------------------------+    |
|                                                                                |
|  +-----------------------------------------------------------------------+    |
|  |                       VOICE LAYER (Pipecat sidecar, Python)           |    |
|  |   wake-word -> VAD -> turn-detector -> STT -> LLM router -> TTS       |    |
|  |   alt path: OpenAI gpt-realtime / Gemini Live (S2S)                   |    |
|  +-----------------------------------------------------------------------+    |
|                                                                                |
|  +-------------------+   +------------------+   +--------------------------+   |
|  |  Local SQLite     |   |  LanceDB vector  |   |  ~/.jarvis/             |   |
|  |  (sessions, tasks,|   |  store (embedded |   |    config / mcp / skills |   |
|  |   memory metadata)|   |   memory index)  |   |    runtime.session       |   |
|  +-------------------+   +------------------+   +--------------------------+   |
+--------------------------------------------------------------------------------+
                  |                              |
        encrypted sync (opt-in)         MCP servers (local + remote)
                  |                              |
                  v                              v
+--------------------------------+   +---------------------------------------+
|     JARVIS CLOUD (optional)    |   |   MCP ECOSYSTEM                       |
|                                |   |                                       |
|   - Auth (WorkOS / Clerk)      |   |   Local stdio:                        |
|   - Cross-device sync (Postgres|   |   - filesystem, shell, git, Playwright|
|     + Qdrant managed)          |   |                                       |
|   - LiteLLM gateway            |   |   Remote HTTP:                        |
|   - Voice infra (LiveKit Cloud)|   |   - GitHub, Notion, Slack, Linear,    |
|   - Push notifications (FCM/   |   |     Google (Drive/Cal/Mail)           |
|     APNs)                      |   |                                       |
|   - Skills marketplace + S3    |   |   Sandboxed MCP:                      |
+--------------------------------+   |   - WebContainers, E2B, Daytona       |
                                     +---------------------------------------+
```

## 2. Top-level component map

### 2.1 Shell layer
- **Tauri 2 + Rust core.** Window management, native notifications, global hotkeys, OS integration (mic permissions, system audio capture, tray icon, deep links).
- **Next.js 15 (App Router) + React 19.** All UI, server components disabled inside Tauri (we're a SPA inside a Tauri webview).
- **Mobile (Phase 2):** React Native + Expo, sharing the data layer through TRPC and a native bridge for notifications.

### 2.2 Core runtime (TypeScript)
- **Orchestrator: Mastra.** Agent definitions, workflows, tool calls, state. Stateful supervisor + workers pattern.
- **Streaming: Vercel AI SDK 6.** UI Message Stream protocol, multiplexed channels per agent.
- **Model router: LiteLLM proxy** (cloud) and a thin local proxy for BYOK + local models. Tier routing (supervisor=Opus/GPT-5, workers=Sonnet/Flash, fallback=Ollama).
- **MCP client manager.** Manages stdio + HTTP MCP server lifecycles, handles auth, exposes tools to the orchestrator.
- **Memory router.** Decides which memory store to read/write per query. Wraps LanceDB (embedded), optional Qdrant (cloud), and the SQLite metadata store.
- **Tool registry & sandbox manager.** Maps tools to sandboxes (none, WebContainers, E2B, Daytona, Docker). Enforces approval gates.
- **Cost meter.** Tracks tokens per agent per task, surfaces live $$ in the UI.
- **Eval harness.** 20-task seed suite + LLM-as-judge runner; CI integration.
- **Scheduler + Notification engine.** Detailed in `06-todo-scheduler-notifications.md`. Owns the to-do list, smart scheduling, and OS-level notification delivery.

### 2.3 Voice layer (Python sidecar)
Reasoning: the best voice ecosystem (Pipecat, Silero, openWakeWord, faster-whisper) is Python-first, and the latency budget rewards a tightly-tuned Python pipeline over JS. Tauri spawns a Python sidecar binary (PyInstaller-frozen) on launch and talks to it over a local Unix socket / Windows named pipe.

- **Wake word:** openWakeWord ("hey jarvis" prebuilt for free tier; user-trained for commercial).
- **VAD:** Silero v6.
- **Turn detector:** LiveKit's Qwen2.5-0.5B fine-tune.
- **Noise suppression:** RNNoise (free) / Krisp VIVA SDK (paid).
- **STT:** Deepgram Flux primary, Cartesia Ink 2 fallback, Moonshine Medium offline.
- **TTS:** Cartesia Sonic 3.5 primary, ElevenLabs Flash v2.5 fallback, ElevenLabs v3 expressive.
- **S2S alt path:** OpenAI gpt-realtime (primary), Gemini Live 2.5 (with vision).
- **Speaker ID:** Picovoice Eagle (live), pyannote community-1 (post-hoc).

Full design and latency budgeting in `04-voice-jarvis-layer.md`.

### 2.4 Storage
- **SQLite (better-sqlite3).** Sessions, messages, tasks, reminders, settings, MCP server configs, eval runs.
- **LanceDB (embedded).** Vector index of memory items - chats, transcripts, file chunks, browsing history, tasks. Local-first.
- **`~/.jarvis/` filesystem layout:**
  ```
  ~/.jarvis/
    config.toml              # global settings
    runtime.session          # mode 0600 token for local IPC auth
    db/jarvis.db             # SQLite
    db/jarvis.db-wal
    vectors/                 # LanceDB
    mcp/                     # MCP server configs (per-server folder)
    skills/                  # user-installed skills (each is a folder with skill.json + assets)
    cache/                   # ephemeral
    logs/                    # rolling logs
    voice/models/            # ONNX models for wake word + VAD + Moonshine
  ```
- **Optional cloud sync.** Postgres (per-user schema) + Qdrant (per-user collection) on the Jarvis Cloud side. End-to-end encrypted with a user-held key (we hold ciphertext only).

### 2.5 Cloud services (optional, opt-in)
- **Auth:** WorkOS (enterprise) or Clerk (consumer). Email + Google + Apple SSO.
- **Sync API:** TRPC over HTTPS, websocket for live multi-device sync.
- **LiteLLM gateway:** managed model routing for users on the Jarvis-managed plan.
- **Voice infra:** LiveKit Cloud for browser/mobile WebRTC; Pipecat self-hosted for desktop direct.
- **Push:** FCM (Android), APNs (iOS), Web Push (browser ext).
- **Marketplace:** Postgres + S3 for skills/MCP server distribution. Stripe for revenue share.

## 3. Process and threading model

The desktop app runs **four processes**:

1. **Tauri main (Rust).** Window, OS APIs, IPC broker, tray, hotkeys, notifications.
2. **WebView (Chromium-via-WebView2/WebKit).** UI rendering. Talks to the runtime via Tauri commands.
3. **Core runtime (Node.js sidecar, embedded via `tauri-plugin-shell`).** All TypeScript orchestration. Single Node process; uses worker threads for heavy memory ops and embedding generation.
4. **Voice sidecar (Python, PyInstaller-bundled).** Wake word, VAD, STT, TTS, turn detection, S2S. Spawned on-demand and kept warm if voice is enabled.

IPC: Tauri commands for UI <-> Rust, stdio JSON-RPC for Rust <-> Node, Unix socket / named pipe for Node <-> Python voice.

**Why three sidecars instead of one fat process?** Crash isolation. If the Python voice loop dies, the rest of the app keeps working. If a model burns memory, only that sidecar is affected. Tauri makes this nearly free.

## 4. Data model (high-level)

Core entities:

- `Workspace` -> contains many projects.
- `Project` -> contains chats, tasks, files, settings.
- `Chat` -> contains messages and parts.
- `Message` -> belongs to chat, has role (user/assistant/agent/tool/system), `agent_id`, parent linking for branches.
- `Part` -> one of (text, reasoning, tool_call, tool_result, image, audio, file_ref).
- `Agent` -> persona + system prompt + model config + allowed tools + memory scope.
- `Tool` -> MCP-backed or native function; signature + sandbox config + approval policy.
- `MemoryItem` -> source (chat/voice/meeting/web/file/task), embedding ref, raw content, metadata.
- `Task` -> the to-do entity. Title, body, due, priority, status, reminders, links to messages/agents/memory.
- `Reminder` -> when, channel (banner, push, email, SMS), payload.
- `Skill` -> shareable workflow bundle: agents + tools + prompts + scripts.
- `EvalRun` -> agent test results.

Detailed schemas in `docs/07-data-model.md` (to be written during MVP).

## 5. Security & privacy posture

- **Local-first by default.** No telemetry on contents. Crash + opt-in usage analytics only.
- **End-to-end encrypted sync.** User key derived from passphrase + device key; we hold ciphertext.
- **MCP server sandboxing.** Stdio servers run as child processes with capability allowlists. HTTP servers go through a proxy that enforces domain allowlists. Anything that touches the filesystem or runs code asks for confirmation by default.
- **Approval gates.** Destructive operations (delete files, push to remote, send email, charge a card) always require human approval. User can grant per-tool, per-session, or always-allow.
- **Audit log.** Every tool call, model call, and notification logged in `~/.jarvis/logs/audit.jsonl` with timestamps and arg/result hashes.
- **Secrets.** OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux) for API keys, OAuth tokens, MCP server secrets.

## 6. Failure modes (what we plan for)

- Model provider outage -> automatic fallback through LiteLLM (Anthropic -> OpenAI -> Gemini -> local Ollama).
- MCP server crash -> isolated; UI shows tool-unavailable state; retry policy with exponential backoff.
- Voice sidecar OOM -> Tauri main respawns it; user gets a one-banner "voice restarted" toast.
- Network drop -> all writes go to local SQLite first; sync queue drains on reconnect.
- Embedded DB corruption -> nightly snapshot to `~/.jarvis/backups/` with 7-day rolling retention.

## 7. Why this stack vs alternatives

A few of the major decisions and why:

- **Tauri 2 vs Electron:** smaller bundle, native performance, Rust core for FS/audio, better OS integration. BridgeMind picked Tauri for the same reasons. Electron would only be justified if we needed Chrome DevTools Protocol features or Node-in-renderer.
- **Mastra vs LangGraph:** Mastra is TS-native and our runtime is TS. LangGraph would force a Python backend. We get most of LangGraph's value (state, durable execution, interrupts) from Mastra plus tighter UI integration.
- **LanceDB vs Chroma vs Qdrant (embedded):** LanceDB is the cleanest embedded option for Tauri, has a native Rust core (so it ships happily inside Tauri without a separate process), and supports millions of vectors locally. Qdrant for cloud sync only.
- **Pipecat (Python) vs LiveKit Agents (Node):** for the desktop sidecar, Python wins because the best voice models (Moonshine, Silero, openWakeWord) are Python-native. For the future browser surface, LiveKit Agents on Node is the right pick. We'll have both.
- **MCP-first instead of custom plugin API:** the MCP ecosystem is exploding (Cursor, Claude, Cline all support it) and we benefit immediately from every server already shipped. Building our own plugin API is a strategic dead-end.

## 8. Open architecture questions

1. **Memory deduplication strategy.** A single fact ("Alex's email is alex@acme.com") arrives via voice, chat, and a meeting transcript. How do we dedupe in the vector store without losing source provenance? Working answer: store all three, link to a canonical fact node, surface canonical in retrieval. Needs prototyping.
2. **Cross-device task sync conflict resolution.** Two devices snooze the same reminder while offline. CRDT or last-writer-wins? Working answer: LWW per field, with a human-readable conflict log. Adopt CRDT only if user complaints justify it.
3. **Local model performance on consumer GPUs.** Llama 3.1 8B Q4 runs at ~30 tok/s on an M2 Pro and ~12 tok/s on a 3060. Is that good enough for fallback workers, or do we need to gate local-only mode to higher-end machines? Will benchmark in Phase 1.
4. **Per-agent memory namespacing.** Should agents share one memory pool or have isolated views per agent? Working answer: shared pool, agents get filtered views via metadata tags. Re-evaluate if cross-agent contamination causes hallucination.

These are tracked as `arch-Q-*` issues in the dev backlog.

---

*See `04-voice-jarvis-layer.md` for the voice subsystem in detail, `05-multi-agent-orchestration.md` for orchestration internals, and `06-todo-scheduler-notifications.md` for the live to-do system.*
