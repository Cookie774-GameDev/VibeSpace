# phone-jarvis - Product Vision

*Companion to `02-architecture.md`. This is the why; that one is the how.*

---

## 1. Thesis

You should be able to talk to your AI from a phone.

Not via a chat app. Not via a webhook bot. You should be able to **dial a number, hear it pick up, and have a conversation**, the same way you would call a friend. And while you are talking, the AI should be able to reach into your laptop, read your files, search your projects, summarize a doc, look up a piece of code, and tell you about it in voice.

The piece nobody packages cleanly today is the **phone leg + laptop reach** combination. Voice agents exist (Vapi, Bland, Retell). Phone-callable LLMs exist (the OpenAI Realtime API has telephony bindings now). Filesystem agents exist (every IDE-embedded AI). Nobody glues all three together for one user.

This project is that glue.

## 2. North-star call

It is 9pm. You are walking the dog. You have a Unity refactor stuck in your head. You pick up your iPhone, hit the favorite contact "Jarvis," and call.

> *"Hey Sage, what is in `MasterRefine_3.md`? Just the headlines."*

The AI on the other end already knows you (your config), already has read access to your `~\.Empire\` folder via the laptop daemon, already routed the request to the right tool. Two seconds later it starts talking:

> *"Three sections. One: refactor `Building.cs` from a god class with twenty boolean type flags into typed subclasses. Two: pull resource gathering off the main thread onto UniTask. Three: replace the legacy event bus with Pulse. Want me to dig into any of them?"*

You say "the building one." It reads you the relevant outline. You think out loud. It captures the next steps you say into a follow-up note in your `~\projects\` notes file. You hang up.

Total call: 90 seconds. No keyboard. No screen. The dog gets a walk. The work moves forward.

## 3. Who it is for

Three personas:

1. **The solo builder, off-screen.** Walking, driving, cooking, in the gym. They have a project in their head and want to interact with it without a laptop in front of them.
2. **The terminal native who hates phones.** Lives in a CLI. Wants the same `grep` and `rg` they use at the terminal, available by voice when they cannot get to a terminal.
3. **The accessibility case.** Hands-busy or hands-injured user. Voice is the primary input. The desktop assistant is great when seated; the phone is the remote control for everywhere else.

This is **not** for:
- Customer-facing voice agents (use Vapi).
- Multi-user phone trees (use Twilio Studio + Vapi).
- People who want zero setup. You will need to wire your own keys and host the cloud node yourself.

## 4. Scope

### In scope (v1)

- Inbound calls only. Twilio number rings, AI picks up.
- One user. The number's owner. Optional allowlist of additional callers.
- Cascade voice loop (STT to LLM to TTS) with full transcripts.
- Read-only filesystem access on the laptop, scoped to a configurable workspace root.
- Search, list, read, summarize tools.
- Spoken PIN auth at start of call.
- Audit log per call: transcript + tool calls + start/end + caller ID.
- Cost: pay-as-you-go provider fees only, no recurring SaaS subscription.

### Out of scope (v1)

- Outbound calls (the AI calling you). Trivial to add later; not in the MVP.
- Multi-tenant / multi-user separation. Not the use case.
- Mobile push integration (deferred to the Jarvis desktop project).
- Voice cloning of you. Persona uses an off-the-shelf voice.
- Full speech-to-speech mode. Cascade is the default; S2S can land in phase 5.
- Write access to files. Off by default; lands behind an explicit unlock in phase 5+.
- Web UI for managing the service. CLI config files only in v1.

### Long-term (vNext)

- Outbound calls. "Sage, call me when the build finishes" or scheduled check-ins.
- SMS as a fallback channel. Same agent, text mode.
- Calendar integration. The agent knows your day.
- Browser tab access (read what is on your screen).
- Multi-modal images. "Describe the screenshot I just airdropped."
- Wake-word call dial-in from a paired Apple Watch.

## 5. Comparison

| Capability | phone-jarvis | Vapi / Bland / Retell | OpenAI Realtime API direct | Generic chatbot |
|---|---|---|---|---|
| Inbound phone number | yes | yes | yes (with telco glue) | no |
| Personal use, BYO keys | yes | no, $0.05-0.20/min markup | yes | varies |
| Filesystem access on your machine | yes | no | no | no |
| Open source | yes | no | no | varies |
| Multi-provider (Anthropic / OpenAI / etc.) | yes | yes | OpenAI only | varies |
| Local LLM option | yes (Ollama) | no | no | rarely |
| Conversational style (not scripted flows) | yes | scripted | yes | yes |
| Cost per hour of call | ~$1.50-2.00 | $5-12 | ~$5 | n/a |
| Setup time | ~6 hours | ~30 min | ~2 hours | ~5 min |

The differentiator is the column nobody else fills: **filesystem access + open source + BYO keys**. Vapi gives you the platform but never touches your machine. Direct OpenAI Realtime gives you the model but no telephony plumbing and no laptop bridge. We sit in between.

## 6. Why now

Three things lined up in 2025-2026:

1. **Streaming voice models got fast and cheap.** Deepgram Nova-3 / Flux delivers ~150 ms STT first-token. ElevenLabs Flash v2.5 delivers ~75 ms TTS first-byte. Cartesia Sonic 2 is similar. The total cascade round-trip is under 700 ms now, which is the bar where conversations stop feeling like walkie-talkie.
2. **Pipecat matured.** A year ago you had to write the orchestration yourself. Now there is a stable open-source library that handles VAD, turn detection, barge-in, and provider plug-ins. The voice-loop part of this project is a few hundred lines, not thousands.
3. **MCP is a real protocol.** A standardized way to expose tools means the laptop daemon's tool registry has a shape we can reuse, and any future MCP server (filesystem, browser, IDE) becomes pluggable into the call.

## 7. Risks

- **Telco cost surprise.** Twilio's per-minute pricing is fine until somebody (maybe you) runs a 10-hour call. Mitigation: hard cap on session length and cost per session; billing alarms.
- **Filesystem disaster.** A misunderstood spoken request to a write tool could trash data. Mitigation: read-only default, strict workspace root, per-action confirmation for any write, full audit log.
- **Voice spoofing.** Caller ID is forgeable. PIN is a string somebody could overhear. Mitigation: PIN is fine for v1 personal use; voice biometric check optional in v3.
- **Latency drift.** Provider regressions, network spikes, model upgrades that change response shape. Mitigation: latency telemetry per leg of the loop, fall back to a faster provider if the primary degrades.
- **Provider lock-in.** Twilio could change pricing. ElevenLabs could rate-limit. Mitigation: every leg is swappable; we document the alternates in `05-providers-and-cost.md`.

## 8. Success criteria

A v1 is successful when:

- You can call your number from your iPhone and have a 5-minute conversation with no awkward pauses.
- The AI can answer "what is in `<filename>`?" within 3 seconds of you finishing the question.
- Latency on a normal turn (no tool call) is under 800 ms median.
- A 1-hour conversation costs under $3 in provider fees.
- Audit log captures every tool call with arguments and result.
- You can hang up at any time and the cloud session cleans up within 5 seconds.
- One full week of personal use with no security incidents (no surprise writes, no cost runaways, no leaked transcripts).

If those hold, we ship phase 5 (write tools, outbound calls, SMS) and start packaging it for other people.
