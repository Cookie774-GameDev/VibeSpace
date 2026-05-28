# Jarvis - Voice Layer Design

*Companion to `02-system-architecture.md` and `03-multi-agent-orchestration.md`. This is the design of the always-available voice supervisor.*

---

## 1. Goals

1. **Sub-450 ms median round-trip** from end-of-user-utterance to first audible Jarvis syllable on broadband.
2. **Always available**: wake-word ("Hey Jarvis") OR global push-to-talk hotkey (Ctrl+Space) OR menu-bar tap.
3. **Privacy-first**: wake word and pre-roll buffer never leave the device.
4. **Modal-aware**: knows what's on screen, what chat is active, what tasks are pending, who said what in the last meeting.
5. **Interruptible**: barge-in supported. User can talk over Jarvis and Jarvis stops.
6. **Voice -> action**: not just chat. Jarvis can create tasks, set reminders, switch agents, summon files, dictate into other apps.

## 2. Architecture

The voice layer is a Python sidecar (PyInstaller-frozen) that ships inside the Tauri bundle. It owns audio capture, all voice models, and the dual-path inference (cascade + S2S). It talks to the Node runtime over a local Unix socket / Windows named pipe authenticated by `~/.jarvis/runtime.session` (mode 0600, constant-time comparison).

```
+-----------------------------------------------------------+
|              Always-on local layer (CPU only)             |
|  - openWakeWord ("hey jarvis") OR Picovoice Porcupine     |
|  - Silero VAD v6                                          |
|  - 1.5 s pre-roll ring buffer (RAM only, never to disk)   |
+-----------------------+-----------------------------------+
                        | wake fired OR push-to-talk
                        v
+-----------------------------------------------------------+
|         Krisp VIVA (paid) / RNNoise (free) NS             |
+-----------------------+-----------------------------------+
                        |
       +----------------+-----------------+
       |                                  |
       v                                  v
+--------------+                  +-----------------+
| Cascade path |                  | S2S path (alt)  |
| (default)    |                  |                 |
|              |                  | OpenAI          |
| Deepgram     |                  | gpt-realtime    |
| Flux + LiveKit                  | (or Gemini Live)|
| turn-detector|                  |                 |
|     |        |                  | LiveKit         |
|     v        |                  | turn-detector   |
| LLM router   |                  | overrides       |
| (any provider)                  | built-in        |
|     |        |                  |                 |
|     v        |                  |                 |
| Cartesia Sonic                  |                 |
| 3.5 / EL Flash                  |                 |
| streaming TTS|                  |                 |
+------+-------+                  +--------+--------+
       |                                   |
       +-----------------+-----------------+
                         v
                   Audio to user
                         |
                         v
                   Tauri main -> UI
                   (transcript, glow border, orb state)
```

## 3. Two paths, one runtime

Why both:

- **Cascade** preserves explicit transcripts (so we can index in memory, log audits, branch into chat). It's the default for tasks that benefit from text intermediaries (tool use, code, search).
- **Speech-to-speech (gpt-realtime / Gemini Live)** is faster (~380 ms vs ~450 ms median) and more expressive (the model can convey affect). Use for casual chat, "wake me up if something happens" ambient mode, vision-in-the-loop with Gemini.

Switch between them based on:
- User preference setting ("Speed" vs "Accuracy" vs "Auto").
- Task type detection (Jarvis classifies the intent in the first ~150 ms of speech).
- Privacy mode (cascade-only when local-models-only is active; S2S routes to cloud).

## 4. Component-by-component

### 4.1 Wake word
- **Default (free):** openWakeWord with the prebuilt "hey jarvis" model. CC-BY-NC-SA license is fine for personal use; we'll train our own model for commercial release.
- **Pro:** Picovoice Porcupine v3, custom hotword. User can set "Hey Athena", "Computer", whatever. Trained via the Picovoice Console.
- **Always local.** Wake word audio never leaves the device. This is non-negotiable.
- **Pre-roll buffer:** 1.5 s circular buffer in RAM so the user doesn't have to pause after the wake word.

### 4.2 VAD
- **Silero VAD v6** (MIT). <1 ms per 30 ms chunk on a single CPU thread. ~2 MB ONNX model.
- Used to detect speech start (after wake word) and speech segments during the conversation.

### 4.3 Turn detector
- **LiveKit Qwen2.5-0.5B turn-detector.** 396 MB, 50-160 ms per turn, 14 languages, ~99% TPR.
- Disambiguates "I'm pausing mid-thought" from "I'm done." Adds <160 ms but dramatically reduces interruption errors.
- Used even on the gpt-realtime path - LiveKit's docs explicitly recommend disabling the Realtime API's built-in turn detection in favor of theirs.

### 4.4 Noise suppression
- **Free:** RNNoise (Mozilla, lightweight, WASM-able).
- **Paid (Pro+):** Krisp VIVA SDK 2.0. Removes background noise AND secondary speakers, on CPU. Used by Discord, Twilio, Daily, Pipecat, LiveKit. ~1B+ minutes/month at scale.

### 4.5 STT
- **Primary cloud:** Deepgram Flux. 5.26% WER, ~150 ms streaming, native end-of-turn detection inside the model. Saves a pipeline stage vs alternatives.
- **Fallback cloud:** Cartesia Ink 2. Same architectural design. Lets us A/B without rewriting the pipeline.
- **Offline / privacy mode:** Moonshine Medium Streaming. 6.65% WER, 107 ms on M-series Macs, 269 ms on Linux x86. Streams natively. faster-whisper distil-large-v3 int8 as a secondary offline option.
- **Cloud bulk transcription** (long meetings, post-hoc): faster-whisper or Groq Whisper Large-v3-Turbo.

### 4.6 LLM (the brain)
- Uses the same LiteLLM router as the main orchestrator.
- Default model for Jarvis: **Claude Opus 4.x** (warmth, breadth) for cascade voice.
- For S2S: locked to OpenAI's `gpt-realtime` voices ("alloy", "marin", "cedar") or Gemini Live's voices.
- System prompt includes: persona, current project context, recent chat history (last 10 turns summarized), today's to-do list, currently active agents.

### 4.7 TTS
- **Primary:** Cartesia Sonic 3.5. 90 ms TTFB, 42 languages, native handling of confirmation codes, IDs, phone numbers.
- **Fallback:** ElevenLabs Flash v2.5. 75 ms TTFB, 32 languages.
- **Expressive mode** (canned responses, story mode, audio-tag-rich content): ElevenLabs v3.
- **Offline mode:** Coqui XTTS v2 (best open-weights voice cloning) or Piper / Kokoro for lighter loads.
- All streaming token-by-token; the LLM streams text into the TTS WebSocket as it generates.

### 4.8 Speaker ID
- **Live:** Picovoice Eagle (on-device, real-time). Jarvis only responds to enrolled voices by default.
- **Post-hoc:** pyannote community-1 for batch transcripts (meeting attribution).

### 4.9 Audio routing
- **Mac:** ScreenCaptureKit (system audio, no driver) + Core Audio (mic).
- **Windows:** WASAPI loopback (system audio) + WASAPI capture (mic).
- **Linux:** PipeWire (preferred) or PulseAudio monitor sources.
- User picks input device explicitly. Default to system default with auto-prefer for "headset" / "USB" device names in meeting context.

### 4.10 Orchestration
- **Pipecat (Apache 2.0)** for the desktop sidecar. Most popular open-source voice agent framework. Provides the FrameProcessor abstraction we need.
- **LiveKit Agents 1.5** for browser/mobile WebRTC paths (Phase 2).

## 5. Latency budget (target)

| Stage | Target | Notes |
|---|---|---|
| Mic capture + VAD | 50 ms | Silero @ 30 ms chunks, +20 ms tail |
| Network in | 30 ms | Reasonable broadband |
| STT first partial | 100-200 ms | Deepgram Flux streaming |
| Turn detection | 50-160 ms | LiveKit Qwen2.5-0.5B |
| LLM first token | 200-400 ms | GPT-5/Opus streaming |
| TTS first audio byte | 75-90 ms | Sonic 3.5 / Flash v2.5 |
| Network out + jitter | 50 ms | |
| **Total cascade** | **555-980 ms** | |
| Aggressive cascade | **~450 ms median** | with speculative TTS |
| **Total S2S (gpt-realtime)** | **330-480 ms** | Closer to human turn pause |

Tricks we use:
1. **Stream STT partials directly into LLM context.** Start the LLM on the first transcript token. Cancel in-flight if user keeps talking.
2. **Stream LLM output token-by-token to TTS** over a Cartesia/ElevenLabs WebSocket. Never buffer a full sentence.
3. **Speculative TTS warm-up.** If Jarvis frequently says "Sure," "Got it," "Let me check" - pre-synthesize a tiny ack and play it the moment the user stops. Buys 500 ms of LLM cover.
4. **Co-locate STT+TTS region** with the LLM provider to save 30-80 ms per hop.
5. **Disable double echo cancellation.** macOS does it natively; Windows mostly does. Software EC on top adds latency.

## 6. Always-listening UX

The patterns that work:

1. **Hotword -> record -> respond.** Wake word locally; pre-roll buffer included so user doesn't pause after "Hey Jarvis."
2. **Push-to-talk.** Default for power users. Global hotkey (Ctrl+Space). Faster and more reliable than wake word.
3. **Tap-to-talk plus visible mic indicator.** Menu-bar / tray icon shows mic state. macOS/Windows force a system-level mic indicator anyway.

Patterns we explicitly avoid:

- Continuous transcription with implicit triggering. Privacy disaster, battery hog, false-activates from background TV audio.
- Open-mic mode by default. Opt-in with a clear UI state only.
- Hot-wording on cloud audio. Wake word always runs locally.

**Battery cost:** openWakeWord/Porcupine run on a fraction of one CPU core. <1% CPU on M-series. On mobile (Phase 2), wake word is OFF by default and triggered on screen-on or hardware-button.

## 7. Voice intents (what Jarvis can do)

Jarvis classifies every utterance into one of these intents in the first 150 ms of speech (using a fast classifier on the streaming partial transcript):

| Intent | Examples | Routing |
|---|---|---|
| **chat** | "What's the weather?" / "Explain quantum tunneling." | Send to LLM, stream TTS back. |
| **task_create** | "Add 'review PR 1234' to my list, due Friday." | Call task service, confirm verbally. |
| **task_modify** | "Move the 4pm reminder to 5." / "Mark the Acme call as done." | Call task service. |
| **memory_recall** | "What did we decide about pricing last Tuesday?" | Memory query, summarize. |
| **agent_route** | "Ask the coder to refactor the auth module." | Hand off to council orchestrator with target agent. |
| **app_command** | "Open project Acme. Switch to council mode. Mute notifications." | Tauri command. |
| **dictation** | "Type this into the active app: ..." | BridgeVoice-style universal text injection. |
| **meeting_command** | "Start recording. Make this a 1:1 template." | Meeting capture service. |
| **summon_file** | "Pull up the design doc from yesterday's call." | Memory + file resolver. |
| **conversation** | "..."(non-actionable; small talk) | Direct LLM, no tool use. |

The classifier itself is a Haiku-class model invoked once per turn with a tiny prompt. ~30 ms in practice.

## 8. Visual feedback

Voice without visual feedback feels broken. Jarvis ships three persistent UI signals:

1. **Apple-Intelligence-style glow border.** A conic-gradient CSS animation around the entire screen edge while listening. Lights up on wake word / push-to-talk activation, dims when Jarvis is speaking.
2. **Spline 3D orb** in the voice modal (only when modal is open). Pulses with audio amplitude, color-shifts on intent classification.
3. **Menu-bar / tray icon state.** Idle dot, listening pulse, thinking spinner, speaking wave. Match macOS Voice Control conventions where possible.

Plus inline transcript: a translucent caption bar overlays the bottom of the screen during voice sessions so the user can see what Jarvis heard. Drops away when the session ends.

## 9. Persona & system prompt

Jarvis is a calm, friendly, lightly British (toggleable) personality. Concise by default, expansive only when asked. Treats the user as an equal, not a sycophant.

System prompt skeleton (production version is longer and more careful):

```
You are Jarvis, the user's personal AI workspace assistant.

Voice rules:
- Reply in 1-2 sentences unless the user asks for more.
- Confirm task creation/modification with the exact title and time.
- When uncertain, ask one specific clarifying question, never multiple.
- Don't start with "Sure", "Of course", or filler. Get to the answer.

Capabilities:
- You can create/modify/snooze tasks and reminders.
- You can summon any past chat, meeting, file, or memory.
- You can route requests to specialist agents.
- You can dictate into the active app.
- You can pause/resume meeting capture.
- You know the current project, today's tasks, and the user's calendar.

Privacy:
- All voice happens on the user's device unless they're on the managed plan.
- Never repeat secrets, API keys, or PII back to the user out loud unless they explicitly ask.
- Confirm before reading any private content out loud in a public-feeling environment.

Personality:
- Friendly, dry, calm. Light wit. Never sycophantic.
- Use the user's preferred name from their profile.
```

User can edit the persona in settings. We ship 5 presets: **Jarvis** (default), **Athena** (formal), **Edge** (snappy), **Watson** (warm), **HAL** (terse).

## 10. Failure modes

- **Wake word false positive.** Jarvis says nothing if no real speech follows within 1.5 s. No "Sorry, I didn't catch that" - silent abort.
- **Wake word missed.** Push-to-talk hotkey is always available as backup.
- **STT outage.** Fall back to next provider; if all cloud STT down, swap to Moonshine local automatically with a one-toast warning.
- **TTS outage.** Same pattern; fallback to local Piper if all cloud TTS down. Voice quality degrades but functionality continues.
- **LLM outage.** LiteLLM router fails over to next model in tier list.
- **Network drop.** Cascade falls fully local (Moonshine + Ollama + Piper) for the duration.
- **User shouts mid-response (barge-in).** Detect amplitude spike on input channel, stop TTS playback, re-enter listen state. <100 ms response.

## 11. Roadmap (post-MVP)

- **Vision-in-the-loop** via Gemini Live - Jarvis can see what's on screen and respond to "what's wrong with this UI?"
- **Persistent ambient mode** - opt-in, bounded ("listen for the next 30 minutes during my coding session, only interject if I ask for help") - never default-on.
- **Multi-language voice** - one persona, switching languages mid-conversation based on user.
- **Voice authentication** - "only respond to me" via Picovoice Eagle with 99%+ accuracy after 30s enrollment.
- **Watch / earbuds first** - Phase 3+. AirPods Pro or Pixel Buds Pro as the primary audio surface.
- **Custom voice clone** - user records 60s, we synthesize their preferred Jarvis voice with their consent (paid tier only).

---

*See `06-todo-scheduler-notifications.md` for how voice-driven task creation flows through the scheduler. See `03-multi-agent-orchestration.md` for how voice intents route into the council.*
