# Voice Assistant Tech Stack for "Jarvis-Style" Overarching Assistant - 2026 Research Report

*Subagent #3, scoped to public-internet sources only. Today: 28 May 2026.*

---

## 0. Executive summary - recommended stack

For a desktop/web AI app that wants a Jarvis-style overarching layer (always-listening, low latency, expressive, multi-modal, runs alongside an LLM brain), the best-of-2026 stack is a **cascade pipeline with a hot-swap to a unified speech-to-speech model when ultra-low latency or affect matters**, orchestrated through Pipecat or LiveKit Agents.

| Layer | Primary | Fallback / alt |
|---|---|---|
| Wake word | **Picovoice Porcupine v3** (commercial, custom hotword) | **openWakeWord** (Apache-2.0, "hey jarvis" prebuilt) |
| Mic capture + VAD | **Silero VAD v6** | **LiveKit / WebRTC VAD** |
| Turn detection | **LiveKit turn-detector (Qwen2.5-0.5B multilingual, 50-160 ms)** | **Krisp VIVA Turn Prediction v3** |
| Noise / voice isolation | **Krisp VIVA SDK 2.0** (Voice Isolation v3) | **RNNoise** (open-source) or **Picovoice Koala** |
| STT (cloud, streaming) | **Deepgram Nova-3 / Flux** (5.26% WER, ~150 ms streaming) | **Cartesia Ink 2** or **Groq Whisper Large-v3-Turbo** |
| STT (on-device fallback) | **Moonshine Medium Streaming** (6.65% WER, 107 ms on M-series) | **faster-whisper distil-large-v3 int8** |
| TTS (primary, conversational) | **Cartesia Sonic 3.5** (90 ms TTFB, 42 langs) | **ElevenLabs Flash v2.5** (75 ms TTFB, 32 langs) |
| TTS (expressive long-form) | **ElevenLabs v3** (audio tags, 70+ langs) | **Hume Octave 2** |
| Realtime / S2S | **OpenAI `gpt-realtime` (Realtime API GA Aug 2025)** | **Gemini Live 2.5** |
| Orchestration | **Pipecat** (Python) for desktop, **LiveKit Agents 1.5** for browser/WebRTC | **Vocode** for Python-only stacks |
| Speaker ID / diarization | **pyannote community-1** (open) / **precision-2** (hosted) | **Picovoice Falcon + Eagle** |

Total achievable mic-to-first-audio-byte latency: **400-650 ms** with cascade, **300-450 ms** with `gpt-realtime`. Detail and reasoning below.

---

## 1. Speech-to-Text (STT)

### 1.1 Cloud streaming leaders

**Deepgram Nova-3 / Flux** is the 2026 reference point. Nova-3 reports a 5.26 % batch WER and 54 % streaming improvement over previous-gen, at $0.0077/min streaming / $0.0043/min batch. Flux is purpose-built for voice agents and embeds end-of-turn detection inside the STT model itself, so you do not bolt a separate VAD/turn-taker on top - that is the single biggest latency saver in current voice agent pipelines. ([deepgram.com/learn/best-speech-to-text-apis](https://deepgram.com/learn/best-speech-to-text-apis))

**Cartesia Ink 2** (May 2026) is the closest competitor. Marketed as "the world's fastest, most accurate streaming STT model with native turn detection." Same architectural bet as Flux - fold turn-taking into the STT - and pairs naturally with Cartesia Sonic 3.5 if you want one vendor for the whole audio loop. ([docs.cartesia.ai](https://docs.cartesia.ai/get-started/overview))

**AssemblyAI Universal-2 / Slam-1** (Oct 2025) is cheaper at $0.37/hr async and pushes hard on text-formatting accuracy (alphanumerics, IDs, phone numbers - relevant for a personal assistant that has to dictate codes, names, paths). WER 10.7 % overall, behind Nova-3 but the formatting wins matter for an assistant. Multilingual streaming added in Oct 2025. ([deepgram.com/learn/best-speech-to-text-apis](https://deepgram.com/learn/best-speech-to-text-apis))

**Speechmatics** is the strongest option for non-US accents (UK, Indian English, EU). 55+ languages. ~$0.30/hr.

**OpenAI** offers two paths: the open Whisper Large-v3-Turbo (Oct 2024, 5.4x faster than Large-v3) and `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` (March 2025, December 2025 snapshots). Whisper does not natively stream - you must chunk it or use the Realtime API. For a Jarvis layer this is generally not the right tool unless you are already inside the Realtime API.

**Groq Whisper API** runs Whisper Large-v3-Turbo on Groq's LPU and is the cheapest fast-Whisper option. Useful as a fallback because it is OpenAI-compatible and has very low warm-call latency (~200 ms for short clips), but does not stream incrementally - you submit chunks.

### 1.2 On-device options

For privacy or offline mode, two open-source families are worth shipping:

- **Moonshine v2 (Moonshine AI, 2025)** - purpose-built for live voice. Medium Streaming model: 6.65 % WER, 245 M params, **107 ms per inference on a MacBook Pro**, 269 ms on Linux x86, 802 ms on Pi 5. Ships a portable C++ core with bindings for Python, Swift, Java, and Windows/macOS/iOS/Android/Linux/RPi. Streams natively (caches the encoder, no 30-second window limit). This is the right edge model for a desktop Jarvis. ([github.com/moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine))
- **faster-whisper (CTranslate2)** - most mature Whisper deployment, 4x faster than openai/whisper, supports int8 quantization. distil-large-v3 with batch_size=16 on a 3070 Ti hits 13.5 % WER on YT Commons. Use it when you want broader language coverage than Moonshine offers natively. ([github.com/SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper))
- **Picovoice Cheetah** is a commercial on-device streaming STT that runs even on microcontrollers; useful if you want to hit Pi-Zero-class hardware. Less accurate than Moonshine Medium.
- **Vosk / Parakeet-TDT (Nvidia, 2024)** are also viable. Parakeet is GPU-only but extremely fast on Nvidia hardware.

### 1.3 STT recommendation

- **Primary cloud:** Deepgram Nova-3 with the Flux conversational model for the active voice loop. The native end-of-turn detection inside the STT eliminates an entire pipeline stage and saves 100-200 ms.
- **Cloud fallback:** Cartesia Ink 2 (similar architectural design, lets us A/B without rewriting the pipeline).
- **Edge / privacy mode:** Moonshine Medium Streaming. Drop in faster-whisper distil-large-v3 int8 when we need to do post-call analysis or transcription of long-form audio that is not the live voice loop.

---

## 2. Text-to-Speech (TTS)

### 2.1 The two real-time leaders

**Cartesia Sonic 3.5** (May 2026) is the current real-time TTS leader. **90 ms time-to-first-byte**, 42 languages, native handling of confirmation codes, order numbers, phone numbers, IDs, emails without preprocessing, and accurate English heteronyms (`read`, `bass`, `bow`). ([docs.cartesia.ai/build-with-cartesia/tts-models/sonic-3-5](https://docs.cartesia.ai/build-with-cartesia/tts-models/sonic-3-5))

**ElevenLabs Flash v2.5** ships **75 ms model-side latency + network** and supports 32 languages. It is the lowest-latency commercial TTS model on the market. The trade-off is reduced expressive depth versus Turbo or Multilingual v2. For a Jarvis that must respond conversationally, Flash is the right default. ([elevenlabs.io/blog/meet-flash](https://elevenlabs.io/blog/meet-flash))

These two are interchangeable from a latency standpoint. Pick by voice quality preference and ecosystem fit. Cartesia bundles Ink 2 STT in the same vendor, which simplifies billing and reduces network hops if you co-locate.

### 2.2 Expressive / long-form

**ElevenLabs v3** (released June 2025, GA late 2025) is the most expressive model on the market: inline audio tags `[whispers]`, `[laughs]`, `[sighs]`, multi-speaker dialogue, 70+ languages. It is **explicitly not recommended for real-time** - too high latency. Use it for canned responses, story mode, audio-tag-heavy interactions. ([elevenlabs.io/blog/eleven-v3](https://elevenlabs.io/blog/eleven-v3))

**Hume Octave / EVI** specializes in emotion-aware TTS that adapts prosody to the conversation context. Worth shipping as an option for an empathic Jarvis mode.

### 2.3 Other options worth knowing

- **Deepgram Aura-2** - same vendor as Nova-3, attractive if you want a single-vendor stack. ~150 ms latency, 21 languages, broad accent coverage.
- **OpenAI TTS** (`tts-1`, `tts-1-hd`, plus the realtime voices) - cheap, decent, but lags Cartesia/ElevenLabs on naturalness and latency.
- **Inworld TTS-2** - competitive on price and language support (15 langs incl. Hebrew, Arabic).
- **Rime Arcana / Coda** - strong on stylized characterful voices (Gen-Z, emo, etc.). Useful if Jarvis should have personality.
- **Coqui XTTS v2** (open-source, Apache-style license but Coqui as a company shut down) - still the best open-weights voice cloning model. Run locally for offline mode or for cloning the user's own voice.
- **Kokoro-TTS / Piper / Orca / Chatterbox** - small open-weights models for offline. Picovoice's TTS comparison page benchmarks Orca at >4x faster than the alternatives in LLM voice-assistant pipelines, but quality is a step below cloud.

### 2.4 TTS recommendation

- **Primary, real-time:** Cartesia Sonic 3.5 - 90 ms TTFB, 42 languages, paired naturally with Ink 2.
- **Fallback / A-B:** ElevenLabs Flash v2.5 - 75 ms TTFB, mature SDKs.
- **Expressive mode (canned responses, narration, story):** ElevenLabs v3.
- **Offline mode:** Coqui XTTS v2 (local clone of user's preferred voice) or Piper/Kokoro.

---

## 3. Realtime / speech-to-speech

This is the **biggest architectural decision** for a Jarvis layer. There are two design patterns:

**A. Cascade pipeline** - `mic -> VAD -> STT -> LLM -> TTS -> speaker`. Pros: any STT, any LLM, any TTS; lower per-minute cost; you keep transcripts; easy to swap models. Cons: each handoff costs latency.

**B. Speech-to-speech model** - one model takes audio in and emits audio out. Pros: fewer hops, more natural turn-taking and prosody, the model can express affect. Cons: locked to one vendor's voice, less control over content, more expensive per minute, you lose the explicit transcript unless you ask for it.

A serious Jarvis ships **both**, behind a feature flag, because the trade-offs are workload-specific.

### 3.1 Speech-to-speech models available May 2026

- **OpenAI Realtime API (`gpt-realtime`)** - GA Aug 28, 2025. Native S2S with the new `gpt-realtime` model, voice options including "alloy", "marin", "cedar". Supports tool use mid-conversation. This is the production reference today. The API supports interruption handling and partial input. Pricing is metered by audio token, ~$0.06/min audio in, $0.24/min audio out (roughly).
- **Gemini Live 2.5 (Google, Vertex AI)** - bidirectional streaming audio with a 1M-token context window. Strong multimodal input (camera + screen + voice). Better than `gpt-realtime` if you want the assistant to also see what is happening on screen.
- **Anthropic** - as of May 2026, Anthropic does not ship a public realtime audio API. Voice is text-mediated only. If you want Claude in the loop, you cascade.

### 3.2 Orchestration frameworks

The pipeline plumbing is no longer something you write from scratch.

**Pipecat (Daily.co, Python, Apache-2.0)** - the most popular open-source framework for voice and multimodal conversational AI. Ships providers for every STT, TTS, and LLM listed above. Best for a desktop Python or a server-side Python app. Pipecat provides the FrameProcessor abstraction that lets you stitch VAD -> STT -> LLM -> TTS as a graph.

**LiveKit Agents 1.5 (Apache-2.0)** - production-grade WebRTC-first framework. Ships a Python and Node.js SDK, plus an open-weights turn-detector model (Qwen2.5-0.5B-Instruct, 396 MB on disk, 50-160 ms per turn, 14 languages, ~99 % true-positive rate) and a Silero VAD plugin. LiveKit Inference offers managed STT/TTS without API keys. This is the right pick if the UI runs in a browser and you want WebRTC for the audio leg. ([docs.livekit.io/agents/build/turns/turn-detector](https://docs.livekit.io/agents/build/turns/turn-detector/))

**Vocode** - Python-first, fewer providers than Pipecat, smaller community. Reasonable third option.

### 3.3 Recommendation

- For the live voice loop: **OpenAI `gpt-realtime`** as primary speech-to-speech path, **cascade through Pipecat** as fallback and as the canonical pipeline for everything that needs explicit transcripts (logs, multi-step reasoning, tool calls that depend on text intermediaries).
- Use **LiveKit's open turn-detector model** even with the Realtime API. Its docs explicitly recommend disabling the Realtime API's built-in turn detection in favor of the LiveKit one for better accuracy.

---

## 4. Wake word detection

The Jarvis layer needs an always-on lightweight model that triggers full STT. Two viable options:

- **Picovoice Porcupine v3** - commercial, $0-enterprise pricing. Custom hotword training takes minutes via the Picovoice Console. Runs on microcontrollers, browsers (WASM), every desktop OS. The benchmark page shows it beating Snowboy and PocketSphinx. Multi-language. This is the right pick for production. ([picovoice.ai/docs/porcupine](https://picovoice.ai/docs/porcupine/))
- **openWakeWord (Apache-2.0)** - fully open-source, ships a prebuilt **"hey jarvis"** model, plus alexa, hey-mycroft, hey-rhasspy, weather-query, and timer models. Trained on synthetic speech, runs ONNX or TFLite. Performance is competitive with Porcupine on the Alexa benchmark. The pre-trained models carry a CC-BY-NC-SA license - fine for a hobby project, not for commercial. Train your own model for commercial use; takes <1 hour in a Colab notebook. ([github.com/dscripka/openWakeWord](https://github.com/dscripka/openWakeWord))
- **microWakeWord** is the open-source choice if you also want ESP32 / microcontroller support.
- **Snowboy** is dead. Don't use it.

For a desktop/web Jarvis, ship openWakeWord by default (free, prebuilt "hey jarvis", licensed acceptably for a personal assistant) and offer Porcupine as an option for commercial deployments.

---

## 5. Voice activity detection (VAD)

**Silero VAD v6 (MIT-licensed)** is the de-facto standard. <1 ms per 30 ms chunk on a single CPU thread, ~2 MB JIT model, supports 6000+ languages, runs in PyTorch and ONNX, and integrates cleanly with faster-whisper. Used inside Pipecat, LiveKit, openWakeWord, and basically everyone else. Ship this. ([github.com/snakers4/silero-vad](https://github.com/snakers4/silero-vad))

**WebRTC VAD** is older, more permissive (more false positives), but is built into every browser. It is the right pick when you literally cannot run Silero (e.g., a strict CSP browser context where you can't ship a 2 MB ONNX model).

For **turn detection** - a different problem from VAD - use the **LiveKit open-weights turn-detector** (Qwen2.5-0.5B-Instruct fine-tune). VAD answers "is someone speaking right now?" Turn detection answers "is the user *finished* with their thought?" - which lets you wait through a 2-second pause when the user is mid-thought instead of barging in. The LiveKit model adds <160 ms and dramatically reduces interruption errors.

**Krisp VIVA Turn Prediction v3** (May 2026) is the commercial alternative. Krisp processes 1B+ minutes/month and was first to market with ML-based turn prediction; their v3 is multilingual and runs on CPU. Worth licensing if you cannot accept the LiveKit model's 50-160 ms tail.

---

## 6. Speaker diarization

For an overarching assistant that may have multiple users in a household:

- **pyannote (MIT-licensed)** - community-1 open-source pipeline, plus precision-2 hosted service. precision-2 hits 12.9 % DER on AMI-IHM and runs at 14 sec/hour audio on an H100. Standard reference. ([github.com/pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio))
- **Nvidia NeMo** - strong if you already have NeMo deployed. Used in many WhisperX-style pipelines.
- **Picovoice Falcon (diarization) + Eagle (speaker ID)** - on-device, real-time. The right pick if you want to identify "this is the owner of the device" vs. "this is a guest" without phoning home.

For Jarvis: ship pyannote community-1 for batch transcripts (logs, summaries) and Picovoice Eagle for live speaker recognition (so Jarvis only responds to the owner's voice).

---

## 7. Always-listening UX patterns

This is where most voice assistants fall down. Three patterns work, three are creepy.

**Works:**

1. **Hotword -> record -> respond.** The classic Alexa/Siri pattern. Wake word runs locally on-device, never streams audio to the cloud. After detection, a 300 ms pre-roll is included so the user does not have to pause after "hey Jarvis." This is the only privacy-acceptable always-on pattern for desktops.
2. **Push-to-talk overlay.** A global hotkey (e.g., `Ctrl+Space`) that opens a lightweight overlay. Faster and more reliable than wake word for technical users. Should be the default for a developer-targeted Jarvis layer.
3. **Tap-to-talk plus visible mic indicator.** UI affordance that always shows whether the mic is hot. macOS/Windows force a system-level mic indicator anyway; do not fight it.

**Don't:**

4. **Continuous transcription with implicit triggering.** Leaks tons of audio to the cloud. Drains battery on laptops. Activates from TV background audio. Skip.
5. **"Open mic" mode by default.** Same problems. Make it opt-in with a clear UI state.
6. **Hot-wording on cloud audio.** Some products send a continuous compressed stream to a cloud model that "decides" if a wake word fired. This is a privacy disaster. Always run wake word locally.

**Battery cost** - Porcupine and openWakeWord both run continuously on a fraction of one CPU core. On a laptop, the cost is negligible (<1 % CPU on M-series). On a phone, leave it off by default and wake on screen-on or on a hardware button. Microsoft's Voice Access guideline of <2 % continuous CPU is a reasonable design target.

**Pre-roll buffer** - keep a circular buffer of the last 1.5 seconds of mic audio at all times (memory-only, never written to disk) so that when the wake word fires you can replay the audio that came right after the wake word ended. Without this, the user has to insert a noticeable pause after "hey Jarvis."

---

## 8. Audio routing on desktop

Capturing system audio (so Jarvis can hear what is playing on YouTube, in a video call, etc.) is OS-specific and has no clean cross-platform abstraction yet:

- **macOS** - Core Audio. Use [BlackHole](https://github.com/ExistentialAudio/BlackHole) or [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit) (macOS 13+) to tap system audio without a virtual driver. Apple's `SCStreamConfiguration` finally exposes audio in macOS 14.4+ without kernel extensions.
- **Windows** - WASAPI loopback capture. Native, no third-party driver. Use `IMDeviceEnumerator` -> `IMMDevice` -> `IAudioClient::Initialize(AUDCLNT_STREAMFLAGS_LOOPBACK)`.
- **Linux** - PulseAudio monitor sources (`<sink>.monitor`) or PipeWire (preferred 2024+).
- **Browser** - `navigator.mediaDevices.getDisplayMedia({ audio: true })` works on Chromium-based browsers; Safari/Firefox audio capture is partial. WebRTC streams the captured audio.

**Mic selection** - let the user pick a device explicitly. Default to the system default but show device names. For meetings, prefer the device whose name contains "headset" or "USB" over the laptop's built-in mic.

**Noise suppression**:

- **Krisp VIVA SDK 2.0** (May 2026) - commercial, the best in class. Voice Isolation v3 removes background noise *and* secondary speakers, on CPU, in front of your VAD/STT. Used by Discord, Twilio, Daily, Pipecat, LiveKit. Sits at "1B+ minutes/month traffic" scale, so it is battle-tested. ([krisp.ai/sdk](https://krisp.ai/sdk/))
- **RNNoise** (open-source, Mozilla) - the default open option. Lightweight, works in browser via WASM. Less aggressive than Krisp but free.
- **Picovoice Koala** - open benchmark page shows it ahead of RNNoise in intelligibility metrics. Commercial.

For a Jarvis layer on desktop, ship RNNoise for the free tier and offer Krisp VIVA for the paid tier.

---

## 9. Latency budgets

The total mic-to-first-audible-syllable round trip is the single number that determines whether voice feels natural. Humans react to a turn pause beyond ~600 ms as awkward; below 300 ms feels human.

### 9.1 Cascade pipeline today (May 2026)

| Stage | Time | Notes |
|---|---|---|
| Mic capture + VAD endpointing | 50 ms | Silero @ 30 ms chunks, +20 ms tail |
| Network in | 30 ms | Reasonable broadband |
| STT first partial | 100-200 ms | Deepgram Flux streaming |
| Turn detection confirm | 50-160 ms | LiveKit turn-detector |
| LLM first token | 200-400 ms | GPT-4-class via streaming |
| TTS first audio byte | 75-90 ms | Flash v2.5 / Sonic 3.5 |
| Network out + jitter buffer | 50 ms | |
| **Total** | **555-980 ms** | |

Aggressive design (speculative TTS, parallelize LLM and TTS streaming) gets this to **~450 ms median** on broadband.

### 9.2 Speech-to-speech (`gpt-realtime`)

| Stage | Time | Notes |
|---|---|---|
| Mic + VAD | 50 ms | |
| Network in | 30 ms | |
| Realtime model first token (audio) | 200-350 ms | OpenAI GA |
| Network out | 50 ms | |
| **Total** | **330-480 ms** | Closer to human |

### 9.3 Tricks that actually move the needle

1. **Stream STT partials directly into LLM context** - start the LLM on the first transcript token, do not wait for end-of-turn. If the user keeps talking, cancel the in-flight LLM call. This buys 200-400 ms but burns LLM cost.
2. **Stream LLM output token-by-token to TTS** - never buffer a full sentence. Cartesia Sonic and ElevenLabs Flash both accept streaming text input over WebSocket. This is the single biggest win.
3. **Speculative TTS warm-up** - if you can predict the first few words (e.g., the assistant frequently starts with "Sure," "Got it," "Let me check"), pre-synthesize a tiny ack and play it the moment the user stops. Gives the LLM 500 ms of cover.
4. **Co-locate stages** - Cartesia or Deepgram in the same region as your LLM saves 30-80 ms per hop. With Pipecat, picking a single vendor for STT+TTS reduces wall-clock latency more than picking the technically-best individual models.
5. **Use Flux / Ink turn-detection STT** - folding turn detection into the STT model removes a serial stage. Worth 100-200 ms.
6. **Disable bidirectional barge-in echo cancellation in software** when the OS already does it (macOS does, Windows mostly does). Doing it twice adds latency.

### 9.4 Rough achievable today

| Mode | Median latency | What you give up |
|---|---|---|
| Aggressive cascade with Flux + Sonic 3.5 + GPT-4o-mini streaming | 450 ms | Some LLM quality |
| `gpt-realtime` direct | 380 ms | Voice choice locked, can't easily swap LLM |
| Conservative cascade for accuracy-critical responses | 800 ms | Feels slightly slow but is fine for non-conversational tasks |

---

## 10. Final recommendation for our Jarvis layer

Build a **dual-path architecture** orchestrated by Pipecat (Python desktop) and LiveKit Agents (browser). Both paths share wake-word, VAD, and turn-detection.

```
+------------------------------------------------------------------+
|  Always-on local layer (CPU, never streams)                      |
|  - Porcupine OR openWakeWord ("hey jarvis")                      |
|  - Silero VAD v6                                                 |
|  - Pre-roll ring buffer (1.5 s)                                  |
+------------------------------+-----------------------------------+
                               | wake fired
                               v
+------------------------------------------------------------------+
|  Krisp VIVA (paid) / RNNoise (free) noise suppression            |
+------------------------------+-----------------------------------+
                               |
            +------------------+-------------------+
            v                                      v
   +-----------------+                  +---------------------+
   | Cascade path    |                  | S2S path            |
   | (default)       |                  | (fast/affect mode)  |
   |                 |                  |                     |
   | Deepgram Flux --+--> LLM (Claude/   | OpenAI gpt-realtime |
   | + LiveKit       |    GPT/Gemini) --+--> same socket      |
   | turn-detector   |                  | (with LiveKit       |
   |     |           |                  |  turn-detector      |
   |     v           |                  |  overriding         |
   | Cartesia Sonic  |                  |  built-in)          |
   | 3.5 / EL Flash  |                  |                     |
   | streaming TTS   |                  |                     |
   +--------+--------+                  +----------+----------+
            |                                      |
            +------------------+-------------------+
                               v
                         Audio to user
```

**Defaults to ship:**

- Wake word: openWakeWord "hey jarvis" prebuilt model. Offer Porcupine in settings.
- VAD: Silero v6.
- Turn detection: LiveKit open-weights model (Qwen2.5-0.5B). Even on the OpenAI Realtime path.
- Noise suppression: RNNoise free, Krisp VIVA paid.
- STT: Deepgram Flux primary, Cartesia Ink 2 fallback, Moonshine Medium offline.
- TTS: Cartesia Sonic 3.5 primary, ElevenLabs Flash v2.5 fallback, ElevenLabs v3 for canned/expressive responses.
- Speech-to-speech alt path: OpenAI `gpt-realtime`, with Gemini Live 2.5 fallback (and the only path with vision-in-the-loop today).
- Speaker ID: Picovoice Eagle for live, pyannote community-1 for post-hoc transcripts.
- Orchestration: Pipecat for the desktop daemon, LiveKit Agents for any browser surface.
- Achievable end-to-end median latency: **~450 ms cascade, ~380 ms S2S** on broadband.

**Things to be careful about:**

- Do not stream wake-word audio to the cloud. Ever.
- Do not enable continuous transcription by default.
- Always show a system-level mic indicator and respect OS-level mic privacy controls.
- Cap pre-roll buffer at 1.5 s and keep it RAM-only.
- For the open-source build, swap openWakeWord prebuilt models (CC-BY-NC-SA) for self-trained models if you commercialize.

---

## Sources

- Deepgram: *The Best Speech-to-Text APIs in 2026* - [deepgram.com/learn/best-speech-to-text-apis](https://deepgram.com/learn/best-speech-to-text-apis)
- Cartesia: *Welcome to Cartesia* and *Sonic 3.5* - [docs.cartesia.ai/get-started/overview](https://docs.cartesia.ai/get-started/overview), [docs.cartesia.ai/build-with-cartesia/tts-models/sonic-3-5](https://docs.cartesia.ai/build-with-cartesia/tts-models/sonic-3-5)
- ElevenLabs: *Meet Flash* (Dec 2024) - [elevenlabs.io/blog/meet-flash](https://elevenlabs.io/blog/meet-flash); *Eleven v3* (Jun 2025) - [elevenlabs.io/blog/eleven-v3](https://elevenlabs.io/blog/eleven-v3)
- LiveKit: *Agents Introduction* - [docs.livekit.io/agents](https://docs.livekit.io/agents/); *Turn detector* - [docs.livekit.io/agents/build/turns/turn-detector](https://docs.livekit.io/agents/build/turns/turn-detector/); *TTS overview* - [docs.livekit.io/agents/models/tts](https://docs.livekit.io/agents/models/tts/)
- Pipecat: [pipecat.ai](https://www.pipecat.ai/) and [github.com/pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat)
- Moonshine AI: [github.com/moonshine-ai/moonshine](https://github.com/moonshine-ai/moonshine)
- Silero VAD v6.2.1 - [github.com/snakers4/silero-vad](https://github.com/snakers4/silero-vad)
- openWakeWord v0.6 - [github.com/dscripka/openWakeWord](https://github.com/dscripka/openWakeWord)
- Picovoice Porcupine docs - [picovoice.ai/docs/porcupine](https://picovoice.ai/docs/porcupine/)
- pyannote.audio v4.0.4 - [github.com/pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio); precision-2 benchmarks Sep 2025
- faster-whisper v1.2.1 - [github.com/SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- Krisp VIVA 2.0 (May 2026) - [krisp.ai/sdk](https://krisp.ai/sdk/), [krisp.ai/blog/viva-2-0-ai-infrastructure-for-voice-ai-agents](https://krisp.ai/blog/viva-2-0-ai-infrastructure-for-voice-ai-agents/)
- OpenAI Realtime API GA (Aug 28, 2025) and `gpt-realtime`
