# phone-jarvis - System Architecture

*Top-level technical blueprint. The component map and data flow.*

---

## 1. The two-process picture

phone-jarvis is **two long-running processes** plus Twilio in between. That is the whole topology.

```
+---------------+         +-------------------+         +-------------------+
|               |  PSTN   |                   |   WSS   |                   |
|   iPhone /    |<------->|   Twilio Voice    |<------->|   Cloud Service   |
|   any phone   |  voice  |   (Media Streams) |  audio  |   (Pipecat + LLM) |
|               |         |                   |  frames |                   |
+---------------+         +-------------------+         +---------+---------+
                                                                  |
                                                                  | WSS
                                                                  | (tool calls)
                                                                  |
                                                        +---------v---------+
                                                        |                   |
                                                        |   Laptop Daemon   |
                                                        |  (tool executor)  |
                                                        |                   |
                                                        |   ~/projects/     |
                                                        |   ~/.Empire/      |
                                                        |   any allowed     |
                                                        |   workspace root  |
                                                        +-------------------+
```

Two persistent processes:
1. **Cloud service** - always on, owns the Twilio number, runs Pipecat per call.
2. **Laptop daemon** - runs in user-space on your machine, dials out to the cloud service, executes tools.

Twilio is the seam. Audio flows through it. Nothing else does.

## 2. Components

### 2.1 Twilio

- One Programmable Voice phone number.
- Webhook on incoming call hits `POST /twiml` on the cloud service.
- Response is TwiML containing a `<Connect><Stream url="wss://..." />` directive.
- Twilio opens a WebSocket back to the cloud service and starts streaming μ-law 8 kHz audio frames in both directions.

This is the boring part. Twilio's piece is mature and well-documented. Pricing in `05-providers-and-cost.md`.

Alternates considered: Telnyx (cheaper but worse documentation), Plivo (similar to Twilio, smaller community), Bandwidth (US-only enterprise focus, not for us). Twilio wins on ecosystem.

### 2.2 Cloud service

A single Python 3.11 process. Components inside it:

- **FastAPI** for HTTP endpoints (`/twiml`, `/health`, `/admin/*`).
- **Pipecat** orchestrating the voice pipeline.
- **One worker per active call.** Pipecat manages this; each call gets its own pipeline instance.
- **Laptop bridge gateway** - a separate WSS endpoint (`/bridge/<token>`) where the laptop daemon connects.
- **Session store** in memory (Redis-shaped if we ever scale, but in-memory is fine for one user).
- **Audit logger** writing per-call JSONL files locally + optional S3 sync.

Deployment target: **Fly.io** (free tier sufficient for personal use; one always-on machine in your nearest region) OR **Railway** ($5/mo plan). Either way, one container, one Dockerfile. Scaling is irrelevant since we are one user.

### 2.3 Pipecat pipeline (per call)

Pipecat is a graph of frame processors. The default cascade pipeline:

```
Twilio WS  ->  Audio decoder (μ-law -> PCM)
             |
             v
           Silero VAD (utterance start/end detection)
             |
             v
           Deepgram STT (streaming)
             |
             v
           Transcript -> LLM context
             |
             v
           LLM (Claude / GPT / Gemini) with tool calling
             |
             +---- if tool call: dispatch via Bridge
             |     wait for result, fold back into context
             |
             v
           ElevenLabs Flash TTS (streaming)
             |
             v
           Audio encoder (PCM -> μ-law)
             |
             v
           Twilio WS  ->  back to caller
```

Each box is a Pipecat `FrameProcessor`. Plugins for Deepgram, OpenAI, Anthropic, ElevenLabs, and Cartesia are first-party in Pipecat. Adding our laptop-bridge tool dispatcher is one custom processor.

Optional speech-to-speech path (phase 5+):

```
Twilio WS  ->  OpenAI Realtime API  ->  Twilio WS
                  (one round trip, no transcripts)
```

S2S is faster but opaque. We keep cascade as default so we can log transcripts and feed them to the laptop tools. S2S is selectable per-call via a spoken intent ("just chat" mode).

### 2.4 Laptop daemon

A single binary on your machine. Two reasonable language choices:

| Choice | Pros | Cons |
|---|---|---|
| **Node.js 20** | aligns with Jarvis desktop runtime, good MCP libs, easy WSS, good FS APIs | one more runtime to install if you do not already have it |
| **Python 3.11** | aligns with cloud service, ripgrep wrappers exist, simple subprocess | harder to ship a single-file binary on Windows |

**Default recommendation: Node.js.** Single-file binary via `pkg` or `bun build --compile`. Cross-platform. The Jarvis desktop project already targets Node sidecars so the muscle memory is shared.

What the daemon does:
1. Reads `~/.phone-jarvis/config.json` (workspace root, allowed tools, ACL, cloud URL, session token).
2. Opens a WSS connection to `wss://<cloud-url>/bridge/<session-token>`.
3. Sends a `register` frame with the tool catalog.
4. Listens for `tool_call` frames, dispatches them to handlers, returns `tool_result`.
5. Heartbeats every 15 seconds. Reconnects with exponential backoff if dropped.
6. Logs every tool call to `~/.phone-jarvis/audit/<date>.jsonl`.

The daemon is small. Maybe 600-1000 lines including the tool implementations.

### 2.5 Tool registry

Each tool is a JSON-schema-shaped function call. MCP-compatible by design so we can swap in any MCP server later. Default v1 tools:

| Tool | Operation | Args | Default ACL |
|---|---|---|---|
| `fs.list` | list files in a directory | `path` | read |
| `fs.read` | read a file's contents | `path`, `start_line?`, `end_line?` | read |
| `fs.search` | ripgrep across workspace | `pattern`, `path?`, `case_sensitive?` | read |
| `fs.glob` | find files by glob pattern | `pattern`, `path?` | read |
| `fs.summarize` | read + LLM-summarize a file | `path` | read |
| `notes.append` | append a line to `~/notes.md` | `text` | append |
| `notes.read` | read recent notes | `n_lines?` | read |
| `system.time` | current local time | none | read |
| `system.battery` | laptop battery state | none | read |

Phase 5+ unlocks:

| Tool | Operation | Default ACL |
|---|---|---|
| `fs.write` | overwrite a file | confirm |
| `fs.edit` | edit a file (oldStr -> newStr) | confirm |
| `fs.delete` | delete a file | confirm |
| `shell.exec` | run a whitelisted command | confirm |

Confirm-tier tools require an explicit verbal yes/no during the call before they run. The daemon also enforces:
- All paths are resolved relative to the workspace root.
- `..` segments that escape the workspace root are rejected.
- Symlinks pointing outside the root are rejected.

Detail in [`04-laptop-bridge.md`](04-laptop-bridge.md).

## 3. Data flow on a normal turn

User says "what's in `~/notes.md`":

```
1.  iPhone mic -> PSTN -> Twilio.
2.  Twilio frames audio over WSS to cloud service (μ-law 8 kHz).
3.  Pipecat decodes to PCM, VAD detects utterance, STT streams transcript.
4.  STT emits final transcript: "what's in tilde slash notes dot md".
5.  LLM gets the transcript + system prompt + tool catalog.
6.  LLM decides to call fs.read(path="~/notes.md").
7.  Cloud service forwards tool_call to laptop daemon over the bridge WS.
8.  Laptop daemon resolves path, reads file, returns first 200 lines as tool_result.
9.  LLM gets result, generates voice response: "you have three notes ...".
10. TTS streams audio frames back through Pipecat -> Twilio WS -> PSTN -> iPhone speaker.
```

Latency budget: target 800 ms median from end of user speech to first audio byte back. See `03-call-flow.md` for the per-leg breakdown.

## 4. Auth and session model

Three auth boundaries:

1. **Caller -> Twilio number.** Caller-ID allowlist. Unallowed numbers get a polite "this number is not accepting calls" message.
2. **Inside the call.** Spoken PIN at start. 4-6 digit code, set in config. Three wrong attempts -> hangup. Optional voice-biometric check on top in phase 5+.
3. **Cloud service -> laptop daemon.** A long-lived session token (256-bit, generated at first daemon startup, stored in `~/.phone-jarvis/session.key` mode 0600). The laptop dials in with this token; cloud service validates against its config. The token is rotated by running `phone-jarvis rotate` on the laptop, which prints a new token and prompts you to update the cloud config.

There is no third-party auth provider. No Clerk. No OAuth. One user, two ends, a shared secret. The smaller the trust graph, the smaller the attack surface.

Detail in [`06-security.md`](06-security.md).

## 5. Failure modes and graceful degradation

| Failure | Behavior |
|---|---|
| Laptop daemon offline | Cloud service refuses tool calls; LLM gets error, tells user "the laptop bridge is offline." Conversation continues without filesystem access. |
| LLM provider down | Pipecat falls over to secondary provider (configured in `providers.json`). If none, agent says "my brain is having a moment, try again in a minute." Hangs up. |
| Twilio Media Stream drops | Pipecat detects WS close, ends the call cleanly. Audit log marks call as `dropped`. |
| Network split between laptop and cloud | Daemon reconnects with backoff. Active tool call gets a `bridge_disconnected` error after 8 seconds; LLM apologizes. |
| Cloud service restart mid-call | Call ends. User redials. We do not yet support session resume across restarts (could land in phase 5 if needed). |
| Provider rate limit | Pipecat returns 429 to LLM, LLM apologizes once and retries; second 429 hangs up. |
| Audio quality degrades | No automatic fix; we log the dropout count. User hangs up and redials. |

## 6. Observability

Three streams:

1. **Per-call audit log** at `~/.phone-jarvis/audit/<YYYY-MM-DD>.jsonl` on the laptop. One JSON object per turn: timestamp, transcript, tool calls, tool results, latencies. Rotated daily, kept 30 days.
2. **Cloud-side metrics.** Per-call latency histograms (STT, LLM, TTS, total turn). Total minutes. Cost estimate per session. Surfaced via a tiny `/admin/metrics` endpoint (auth-gated).
3. **Daemon health log** at `~/.phone-jarvis/log/daemon.log`. Reconnects, tool errors, sandbox violations.

No third-party telemetry. No call recording uploaded anywhere we do not control.

## 7. Deployment

### Cloud side

```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

Deploy to Fly.io with `fly launch` then `fly deploy`. One always-on machine, one region (closest to you for latency). Set secrets via `fly secrets set ANTHROPIC_API_KEY=... DEEPGRAM_API_KEY=... ELEVENLABS_API_KEY=... PHONE_JARVIS_BRIDGE_TOKEN=...`.

The Twilio webhook URL (set in the Twilio console) points to `https://<your-app>.fly.dev/twiml`. Twilio handles all the TLS and PSTN piece on its side.

### Laptop side

`npm install -g phone-jarvis-daemon` (after we publish), then:

```
phone-jarvis init
# prompts for cloud URL, generates session key, prints the cloud-side token to install
phone-jarvis start
# runs in foreground; `phone-jarvis service install` on Win/Mac/Linux for autostart
```

Workspace root and ACL configured in `~/.phone-jarvis/config.json`.

## 8. Why this shape and not the alternatives

**Why not put the laptop daemon directly on Twilio's webhook side?** Because the laptop is not internet-exposed and should not be. We do not want to open ports.

**Why not use ngrok / Cloudflare Tunnel to expose the laptop?** Same reason. Plus it is one more service to manage. Outbound WSS is simpler and works through every NAT and firewall.

**Why not run everything on the laptop and have Twilio call into it directly?** Two reasons. One: latency to the laptop from Twilio is variable depending on your home connection. Two: requires a public IP or a tunnel. Cleaner to have the cloud node be the always-on Twilio terminator.

**Why not skip the cloud node and use Twilio's `<VoiceResponse>` with a managed voice agent (Vapi, ConversationRelay)?** Then we lose the ability to dispatch tool calls to the laptop on our terms, lose multi-provider, lose open source. Some of those services do allow webhooks for tool calls, but the round-trip is slow and the cost is higher.

**Why not Pipecat's hosted version (Daily Bots)?** Costs more. Less control. Same Pipecat code can run on Fly for $0-5/mo.

**Why not skip Pipecat and write the orchestration ourselves?** Doable, ~2000 lines of careful audio handling. Pipecat is ~300 lines of integration code instead. The maintenance asymmetry is huge: Pipecat's authors handle every Twilio frame format change.

## 9. What this architecture explicitly is not optimized for

- High concurrency. We assume one active call at a time. Pipecat scales fine; the laptop daemon does not.
- Multi-region failover. One Fly machine in one region. If it is down, calls do not work.
- Stateful long-lived memory across calls. We log transcripts but the agent does not have persistent memory yet. That is the desktop Jarvis project's job; we will integrate later.
- Cost optimization at scale. Per-minute is fine for one user. If someone tried to run a fleet, the architecture would need a session pool, a real database, and a lot more discipline.

These are deliberate v1 simplifications. They will become limits if we ever go multi-user, but we are not doing that.
