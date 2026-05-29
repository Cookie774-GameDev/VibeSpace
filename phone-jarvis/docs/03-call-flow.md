# phone-jarvis - Call Flow

*Second-by-second walkthrough of one inbound call. Latency budget. Barge-in. Hangup. Reconnect.*

---

## 1. The hello path (call start to first agent word)

A call from cold start to the first audible AI word, broken down by step:

```
T=0ms     User taps "Jarvis" contact on iPhone, dial begins.
T+~2s     iPhone routes through Apple/carrier infra to Twilio.
T+~3s     Twilio answers, hits POST /twiml on cloud service.
T+~3s     Cloud returns TwiML:
            <Response>
              <Connect>
                <Stream url="wss://app.fly.dev/twilio/<call_sid>" />
              </Connect>
            </Response>
T+~3.1s   Twilio opens WSS to the stream URL. Starts streaming μ-law audio.
T+~3.1s   Cloud service spins up a Pipecat pipeline for this call_sid.
T+~3.2s   Pipecat is ready. Sends a TTS pre-roll: "hey, what's up?"
T+~3.4s   First TTS audio frame reaches iPhone. User hears greeting.
T+~3.7s   Greeting finishes. VAD now active, listening.
```

Total cold start: about 700 ms from Twilio answer to first agent word. The iPhone-to-Twilio leg is mostly out of our control (PSTN, ~2 s typical). The 700 ms is what we can tune.

After greeting, we want **PIN-first auth** before listening to any other intent (see `06-security.md`):

```
"Hey, what's up? Just need your code first."
[user says four digits, optionally types DTMF]
[verified -> "got it, what's going on?"]
[failed three times -> "no luck, hanging up"]
```

Phase 5+ optimization: persist a per-caller "trusted device" cookie via a soft session token that survives 24h, so repeat calls from the same Caller-ID skip PIN. Off by default.

## 2. One conversational turn (no tool call)

User says "what's the weather in Austin." Latency walk:

| Leg | Median | Notes |
|---|---|---|
| User stops talking | T=0 | VAD detects end-of-utterance (Silero, ~50 ms after silence) |
| Silero VAD fires `utterance_end` | T+50ms | Pipecat tells STT to finalize |
| Deepgram STT final transcript | T+150ms | streaming, partial finals along the way; final is ~100 ms after end-of-speech |
| LLM first token | T+450ms | Anthropic Claude Haiku ~250 ms TTFT; could be 600 ms with Sonnet |
| TTS first audio byte | T+520ms | ElevenLabs Flash v2.5 ~70 ms first byte after first LLM token |
| Audio frame reaches Twilio WS | T+540ms | local WAN hop, low |
| Twilio frame reaches iPhone | T+720ms | PSTN one-way, ~180 ms typical |
| User hears first syllable | T+800ms | total |

**Target: 800 ms median, 1200 ms p95.** That is the band where conversation feels normal. Above 1500 ms, interlocutors start talking over each other. Below 500 ms, you hit Anthropic / Deepgram / ElevenLabs jitter.

Speech-to-speech path (OpenAI Realtime API, optional): cuts STT and TTS into one round trip. Median drops to about 500 ms. We pay for that in: no transcripts, OpenAI-only, more expensive per minute.

## 3. One conversational turn (with tool call)

User says "what's in `~/notes.md`":

```
T=0       User stops talking
T+50ms    VAD fires
T+150ms   STT final: "what's in tilde slash notes dot md"
T+450ms   LLM first token: a tool_use block, not text
T+550ms   LLM tool_use complete: fs.read(path="~/notes.md")
T+560ms   Cloud service sends tool_call frame to laptop daemon
T+575ms   Laptop daemon receives, resolves path, reads file
T+600ms   Laptop daemon sends tool_result back
T+615ms   Cloud service folds result into LLM context, asks for continuation
T+800ms   LLM first text token: "you have three notes ..."
T+870ms   TTS first audio byte
T+1050ms  User hears first syllable
```

Total ~1.05 s. The tool call adds about 250 ms (network + filesystem + a second LLM round). Acceptable for a "let me check" feel.

Tools that take longer (e.g. `fs.search` across a large repo) can buy us time with a verbal hint:

```
LLM stream: "let me check..." [tool_call running] "okay so I found..."
```

Pipecat supports this pattern via interleaved TTS during tool execution. We will use it for any tool call expected to take >500 ms.

## 4. Barge-in (interruption)

User starts talking while AI is speaking. We want the AI to stop within 200 ms.

Pipecat's interruption handler:
1. VAD detects new utterance during outbound TTS.
2. Pipecat sends a `cancel` to the TTS provider.
3. Pipecat clears the audio output buffer to Twilio.
4. STT picks up the new utterance as if the prior turn ended.

Edge case: user says "uh," "yeah," "mm-hmm" while AI is talking. We do **not** want to interrupt on backchannels. Mitigation: the LiveKit turn-detector model (or its Picovoice equivalent) discriminates between intent-to-speak and backchannel. Pipecat ships with this; we just enable it.

Edge case: TTS provider has already streamed 500 ms of audio into the Twilio buffer. After cancel, the iPhone may still play that buffer. There is no way to "unsend" PSTN audio. Best we can do is stop generating new audio. User hears the AI talk for ~300 ms after they started, then silence, then their input is processed. Acceptable.

## 5. Hangup

Two flavors:

**User hangs up.** iPhone call ends. Twilio fires the WSS close. Pipecat detects close, runs the call's `on_end` hook:
- Flush the final audit log entry.
- Tear down the LLM session.
- Send a hangup notification to the laptop daemon (so it can flush its log too).
- Free the Pipecat pipeline.

Total cleanup: <1 s.

**AI hangs up.** AI calls `system.hangup()` (a tool that says "okay see ya" and triggers a Twilio `<Hangup/>` redirect). Same cleanup path.

**Idle hangup.** If the user goes silent for >120 s and the AI has nothing to say, the AI says "you still there?" once, waits another 30 s, and hangs up. Configurable.

**Cost cap hangup.** If a single call exceeds the configured cost cap (default $5), the AI says "we're at the cost cap, let's pick this up later," then hangs up. Hard guard against runaway sessions.

## 6. Reconnect (the laptop bridge dropped mid-call)

Laptop daemon WS dies during a call. Two scenarios:

**Brief drop (<5 s).** The laptop's reconnect handler kicks in immediately with exp-backoff (start 250 ms, max 5 s). If a tool call was in-flight, it errors back to the LLM with `bridge_temporary_unavailable`. LLM apologizes ("hmm, hold on") and retries the tool call. Usually transparent.

**Long drop (>5 s).** LLM gets a `bridge_offline` error and switches mode: it can still chat, but cannot answer filesystem questions. It tells the user: "I lost the laptop bridge. Want to keep talking, or call back when it reconnects?"

The cloud service does not try to keep the call open indefinitely if the bridge is needed for the user's intent.

## 7. The audit envelope

Every turn produces one JSONL record on the laptop and one in the cloud. The shape:

```json
{
  "ts": "2026-05-29T15:02:31.412Z",
  "call_sid": "CA1234...",
  "turn_id": 7,
  "user_transcript": "what's in tilde slash notes dot md",
  "stt_latency_ms": 145,
  "llm_first_token_ms": 312,
  "tool_calls": [
    {
      "name": "fs.read",
      "args": {"path": "~/notes.md"},
      "result_bytes": 1834,
      "latency_ms": 38,
      "result_truncated": false,
      "result_summary": "1834 bytes, 47 lines, plain text"
    }
  ],
  "agent_text": "you have three notes from this week...",
  "tts_first_byte_ms": 70,
  "total_turn_ms": 1042
}
```

Tool results are summarized in the audit log, not stored verbatim, to keep log size sane and to avoid mirroring file contents to the audit. The cloud-side log gets the same record minus the full transcript (kept on the laptop only).

## 8. Voice persona

Default persona is "Sage" (the same persona from `taste.md` in the opencode CLI). Direct, concise, plainspoken, no emojis, no breathless enthusiasm. The phone version adds:

- Slightly more conversational than the CLI version. "Yeah, that file has..." instead of bullet lists.
- Acknowledges a long task before doing it. "Let me check, gimme a sec."
- Does not narrate every step. If you ask "what's in notes.md," do not preface with "I'm going to read your notes file now."
- Knows when to shut up. After answering, do not append "let me know if you have other questions." Wait.
- Casual register match. If you call and say "yo what's up," the agent answers in kind.

The persona is set via the LLM system prompt at session start. Full prompt template lives in `cloud/prompts/persona.md` once we start coding.

## 9. Edge cases worth naming

- **Music in the background.** VAD will sometimes mistake bass for speech. Mitigation: Krisp VIVA / RNNoise denoiser before VAD.
- **DTMF tones.** User pressing keys on the iPhone. We pick these up as control signals: `*` ends the call, `#` triggers a "summary so far" recap, `1-9` are reserved for future shortcuts.
- **Silence at start.** Some carriers have ~500 ms of dead air before connect. We delay the greeting by 200 ms after Twilio's `start` event to be safe.
- **User on speakerphone in a noisy room.** Bad for STT. We can detect via Deepgram's confidence scores; if average confidence drops below 0.7 for several consecutive turns, we offer "you sound far away, want to switch to wired?"
- **International caller.** Latency hits a wall around 250-300 ms one-way. An EU caller to a US Fly region adds ~200 ms total turn time. Deploy regional Fly machines if this is a use case.
- **iOS Focus mode silencing the call.** Out of scope, we cannot fix.
- **Call drops mid-tool-call.** Tool runs to completion server-side, result goes to audit log, ignored. No side effects unless it was a write tool.

## 10. What we measure to know it works

A v1 release ships only when, on a representative sample of 20 calls:

- Median total turn latency (no tool) under 800 ms.
- Median total turn latency (with one tool) under 1200 ms.
- Barge-in cancels TTS within 200 ms in 90% of cases.
- Zero stuck calls (every call's audit log has a clean end-of-call entry).
- Zero unauthorized tool executions (no tool ran without a corresponding LLM tool_use).
- Less than 2 cents/minute provider cost on average.

If those hold, the call flow is shippable.
