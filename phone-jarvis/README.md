# phone-jarvis

> **A phone number you can call (or an in-app button you can tap). An AI picks up. It can also reach into your laptop and read your files. Free for in-app use, ~$0.50/mo for personal phone number, ~$5/mo for the easiest turnkey path.**

Two ways to talk to it:
- **In-app**: tap "Call Sage" inside the Jarvis app on your phone or laptop. WebRTC. Costs zero. Scales to many users for free.
- **PSTN**: dial a real phone number from any phone. Either ~$5/mo turnkey (Twilio + paid providers, easiest) or ~$1/mo NetworkChuck-style (Oracle Cloud free + LiveKit SIP + cheap DID).

Either way: you bring your own API keys (Groq is free, no card; Anthropic / OpenAI / Cartesia all have free tiers). The AI can chat with you, dictate notes, search your laptop, summarize your files, find code, or explain something in your project. Tools are scoped to a workspace folder you choose, default read-only, gated by auth.

This repo contains **planning, architecture, and design docs only**. No application code yet. Implementation starts after these docs are reviewed.

Working title is "phone-jarvis." Sister project to the desktop [`Jarvis`](../Jarvis/) workspace; designed to be embedded into Jarvis as the "voice on a phone" layer for users who want it. Can also ship independently.

---

## Quick links

### Product docs (read in order)
1. [`docs/01-product-vision.md`](docs/01-product-vision.md) - thesis, who it is for, the north-star call, scope and non-scope, comparison vs Vapi / Bland / Retell
2. [`docs/02-architecture.md`](docs/02-architecture.md) - top-level system blueprint, components, deployment, data flow
3. [`docs/03-call-flow.md`](docs/03-call-flow.md) - second-by-second walkthrough of one inbound call, latency budget, barge-in, hangup, reconnect
4. [`docs/04-laptop-bridge.md`](docs/04-laptop-bridge.md) - how the laptop daemon connects to the cloud service, tool registry, sandbox, MCP shape
5. [`docs/05-providers-and-cost.md`](docs/05-providers-and-cost.md) - BYO API matrix, free-tier paths, cost-per-call estimates, model recommendations
6. [`docs/06-security.md`](docs/06-security.md) - threat model, mitigations, what NOT to allow, audit log, abuse handling
7. [`docs/07-free-vs-paid-comparison.md`](docs/07-free-vs-paid-comparison.md) - **the three paths**: Twilio + paid (easy), NetworkChuck-style 3CX/Oracle free, and in-app WebRTC for free multi-user. Side-by-side latency, quality, cost, scale.
8. [`docs/08-multi-user-and-jarvis-integration.md`](docs/08-multi-user-and-jarvis-integration.md) - **how to ship this inside Jarvis to other people**: per-user laptop daemons, shared cloud node, BYO keys, auth, trust model, privacy disclosure, phased rollout.

### Implementation
- [`implementation-plan/00-phased-plan.md`](implementation-plan/00-phased-plan.md) - 6-phase build plan, ~6-8 weeks of focused work to a working personal version

---

## What this is (one paragraph)

phone-jarvis is two pieces glued together by a WebSocket. **Piece one** is a small Python service in the cloud (Fly.io / Railway / a $5 VPS) that owns a Twilio phone number, runs Pipecat to orchestrate the voice loop (Deepgram STT to LLM to ElevenLabs/Cartesia TTS), and keeps a per-call session. **Piece two** is a tiny daemon on your laptop that opens an outbound WebSocket to that cloud service, registers a set of file-and-shell tools, and executes them when the LLM asks. The cloud service never reaches into your laptop; the laptop reaches out and stays on a leash. Tools default to read-only, scoped to a workspace root you configure, gated by a spoken PIN at the start of every call.

## What it is not

- Not a SaaS. You run it. You own the keys. You pay only telco + provider costs.
- Not a 24/7 receptionist for customers. It is a personal assistant for one phone number that you (and people you allowlist) can call.
- Not a replacement for the desktop `Jarvis`. This is the **phone leg** of the same idea: voice in, agent in the middle, your data on the other side. The desktop project handles the on-screen workspace; this one handles the case where you do not have a screen.
- Not safe to expose without the security guardrails in `docs/06-security.md`. A phone number that can read your filesystem is a footgun if you skip the auth layer.

## How it differs from Vapi / Bland / Retell

Those are commercial AI-voice-agent platforms aimed at business call flows (customer support, lead qualification, appointment booking). They are great at what they do, but:

- They charge per minute on top of telco. phone-jarvis is open code, BYO keys.
- They are built around scripted flows and CRM tool calls. phone-jarvis is built around **one user, one assistant, deep filesystem access, casual conversation**.
- They do not include a laptop bridge. phone-jarvis is the bridge.
- They route audio through their cloud. phone-jarvis routes audio through your cloud node, and tools route through your laptop.

If you want a hosted commercial phone agent, use Vapi. If you want a personal AI you can call from anywhere that knows your projects, use this.

## Stack at a glance

```
TELEPHONY     Twilio (Programmable Voice + Media Streams)
              alternatives considered: Telnyx, Plivo, Bandwidth

VOICE LOOP    Pipecat (Python, MIT licensed)
              orchestrates VAD + STT + LLM + TTS + barge-in

STT           Deepgram Nova-3 / Flux (streaming, ~150 ms)
              alternatives: AssemblyAI Universal-Streaming,
                            local Whisper.cpp / Moonshine

LLM           Anthropic Claude (default), OpenAI, Gemini
              chosen per-config; tool calling required
              alternative: local Ollama (Llama 3.x, Qwen)

TTS           ElevenLabs Flash v2.5 (default, ~75 ms first byte)
              alternatives: Cartesia Sonic 2, OpenAI TTS,
                            local Piper

CLOUD SVC     Fly.io free tier or Railway $5 plan
              Python 3.11+, FastAPI, Pipecat
              terminates Twilio Media Streams,
              hosts the laptop-bridge WS endpoint

LAPTOP DAEMON Node.js 20 OR Python 3.11
              one binary, runs as user-mode service
              outbound WSS to cloud svc
              MCP-shaped tool registry
              workspace-root sandbox, read-only default

AUTH          phone number allowlist + spoken PIN
              per-call session token, time-bound
              audit log per call, retained 30 days local

OPTIONAL      speech-to-speech path via OpenAI Realtime API
              for casual chat, lower latency, no transcripts
              cascade path stays default for filesystem tasks
```

Detail and reasoning in [`docs/02-architecture.md`](docs/02-architecture.md) and [`docs/05-providers-and-cost.md`](docs/05-providers-and-cost.md).

## Folder layout

```
projects/phone-jarvis/
+- README.md                          this file
|
+- docs/                              product, architecture, design
|   +- 01-product-vision.md
|   +- 02-architecture.md
|   +- 03-call-flow.md
|   +- 04-laptop-bridge.md
|   +- 05-providers-and-cost.md
|   +- 06-security.md
|
+- implementation-plan/
    +- 00-phased-plan.md
```

Once we start coding the layout will gain `cloud/` (the Twilio + Pipecat service) and `laptop/` (the bridge daemon).

## Five core decisions

1. **Twilio over alternatives.** Cheapest free trial, biggest ecosystem of tutorials, Media Streams works without surprises. Telnyx is cheaper at scale but worse onboarding.
2. **Pipecat over rolling our own.** The voice orchestration (VAD, turn detection, barge-in, interruption handling) is fiddly and Pipecat already solves it. Open source, swappable providers, Twilio transport built in.
3. **Cascade voice loop as default, S2S as optional.** Cascade (STT + LLM + TTS) gives us text transcripts to log, search, and feed to the laptop tools. Speech-to-speech (OpenAI Realtime) is faster but opaque; reserve it for "just chat" mode.
4. **Outbound WebSocket from laptop, not inbound.** The laptop never opens a port. It dials out to the cloud service and stays connected. No firewall holes, no public IP, no tunneling tools required.
5. **Read-only by default.** A phone number that can rm your home directory is a disaster waiting for a misunderstanding. Read, list, search, summarize work without confirmation. Anything that writes, deletes, or runs a command requires an explicit unlock per call.

## Phased build plan (summary)

| Phase | Duration | Outcome |
|---|---|---|
| 0 - Twilio hello world | 2-3 days | Number rings, robot voice answers, you can call yourself |
| 1 - Voice loop MVP | 1 week | Real conversation: STT to LLM to TTS over Twilio Media Streams via Pipecat |
| 2 - Laptop bridge | 1 week | Daemon connects out, tool registry, read-only file tools work over the call |
| 3 - Security hardening | 3-5 days | Phone allowlist, spoken PIN, ACLs, audit log, kill switch |
| 4 - Polish | 1 week | Persona prompt, barge-in tuned, hangup, reconnect, summary email after call |
| 5 - Write tools (optional) | 1 week | File edit + shell with per-action confirmation, scoped to workspace |

Total: roughly 6-8 weeks of focused work to a daily-driveable personal version. Detail in [`implementation-plan/00-phased-plan.md`](implementation-plan/00-phased-plan.md).

## What you need before phase 0

- Twilio account (free trial, gets you ~$15 credit and a verified number)
- API keys for: Anthropic OR OpenAI OR Google (pick one), Deepgram, ElevenLabs OR Cartesia
- A cheap cloud host (Fly.io free tier is enough for personal use; Railway $5 plan is fine)
- Python 3.11+ on the cloud host, Node.js 20 OR Python 3.11 on the laptop
- 4-6 hours for phase 0 + 1 if you have not done Twilio before, otherwise ~2 hours

## Source material and prior art

- The general AI-phone-agent pattern is documented in dozens of public tutorials. Twilio's own blog is the cleanest reference for Programmable Voice + Media Streams + OpenAI Realtime: https://www.twilio.com/en-us/blog/outbound-calls-python-openai-realtime-api-voice
- Pipecat docs: https://docs.pipecat.ai
- Vapi (a useful negative reference for "what we do not want to build"): https://vapi.ai
- The desktop sister project: [`projects/Jarvis/docs/04-voice-jarvis-layer.md`](../Jarvis/docs/04-voice-jarvis-layer.md) describes the same voice-loop choices for the on-screen case. We are reusing many of those decisions.

---

*Generated: 2026-05-29.*
