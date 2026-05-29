# phone-jarvis - Providers and Cost

*BYO API matrix, free-tier paths, per-call cost estimates, recommendations. Updated 2026-05-29.*

---

## 1. The provider matrix

phone-jarvis has six provider slots. You pick one for each:

| Slot | What it does | Default | Free tier? |
|---|---|---|---|
| **Telephony** | the phone number, PSTN bridge, media streams | Twilio | $15.50 trial credit |
| **STT** | speech-to-text, streaming | Deepgram | $200 credit, no card |
| **LLM** | the brain | Anthropic Claude Haiku | varies, see below |
| **TTS** | text-to-speech, streaming | ElevenLabs Flash | 10k chars/mo free |
| **Cloud host** | always-on Pipecat service | Fly.io | one machine free |
| **Optional S2S** | speech-to-speech alternate path | OpenAI Realtime | pay-as-you-go |

You only need keys for: telephony, STT, LLM, TTS. Cloud host can be free. S2S is optional for v1.

## 2. Telephony (Twilio)

Twilio Programmable Voice + Media Streams.

| Item | Cost |
|---|---|
| US local phone number | $1.15/mo |
| Inbound call | $0.0085/min |
| Outbound call (US) | $0.014/min |
| Media Streams | included, no extra charge |

Plus their per-minute "Voice Insights" if you want them ($0.001/min, optional, off by default).

A 10-minute inbound call: $0.085 + $1.15/30 in number rental amortized = ~$0.13 marginal.

### Alternates considered
- **Telnyx**: cheaper per minute (~$0.0035), worse onboarding, smaller Pipecat support. Reasonable if you have an existing Telnyx footprint.
- **Plivo**: similar to Twilio at slightly lower cost. Smaller community.
- **Bandwidth**: enterprise focus, painful onboarding for personal use. Skip.

**Recommendation: Twilio.** Pipecat has first-class Twilio support; the entire AI-voice tutorial canon uses Twilio; trial credit covers months of personal use.

## 3. STT (Deepgram default)

Streaming speech recognition. Latency budget on this slot: 100-200 ms first-final.

| Provider | Model | Latency | Cost |
|---|---|---|---|
| **Deepgram** | Nova-3 streaming | ~200 ms | $0.0043/min ($0.26/hr) |
| **Deepgram** | Flux | ~150 ms | $0.0058/min ($0.35/hr) |
| **AssemblyAI** | Universal-Streaming | ~250 ms | $0.0058/min |
| **OpenAI** | Whisper-1 streaming | ~400 ms | $0.006/min |
| Local | Whisper.cpp small.en | ~100 ms | free |
| Local | Moonshine | ~80 ms | free |

A 10-minute call: ~$0.04-0.06 with Deepgram Nova-3.

### Free tier
Deepgram gives $200 credit on signup, no card required. That is ~50 hours of phone calls before they ask for payment. Easily covers personal use for the first year.

### Local option
Whisper.cpp or Moonshine on the cloud host. Skips the per-minute STT fee entirely. Trade-off: more CPU on the cloud host (Fly free tier may not handle it), and slightly higher latency variance. Reasonable for a phase-5 cost-cut, not a phase-0 default.

**Recommendation: Deepgram Nova-3.** Latency is fine, free tier is generous, Pipecat plug-in is mature. Switch to Flux if you want the extra 50 ms shaved off.

## 4. LLM

The brain. Tool-calling support is required (rules out a lot of older models). Streaming is required.

| Provider | Model | TTFT | Cost in / out per 1M tokens |
|---|---|---|---|
| Anthropic | Claude Haiku 3.5 | ~250 ms | $1 / $5 |
| Anthropic | Claude Sonnet 4 | ~400 ms | $3 / $15 |
| OpenAI | GPT-5 mini | ~300 ms | $0.50 / $2 |
| OpenAI | GPT-5 nano | ~150 ms | $0.10 / $0.40 |
| Google | Gemini 2.5 Flash | ~200 ms | $0.30 / $2.50 |
| Local | Llama 3.3 70B / Qwen 3 | varies | free + GPU |

For a typical 10-minute call (~30 turns, ~500 input tokens per turn after history accumulates, ~80 output tokens): ~15K input + 2.4K output total. With Haiku: $0.027. With Sonnet: $0.081. With GPT-5 nano: $0.0025.

### What to default to
**Claude Haiku 3.5.** Fast enough, smart enough for casual conversation and tool use, and follows persona prompts cleanly. Sonnet is overkill on a phone call (you cannot read its detailed prose; the medium rewards short answers).

### What to use for tool-heavy turns
For complex tool use (multi-step searches, summarizations), the default LLM may fall short. Pipecat supports per-turn model swaps: the simple "what is in X" goes to Haiku, the harder "find every TODO across my repos and group them" goes to Sonnet for that turn. Configurable.

### Local LLM
If you have a beefy laptop with a 24+ GB GPU, you can run Llama 3.3 70B or Qwen 3 32B locally and have the cloud service hit it via Ollama. Adds latency (your home network -> cloud -> home network), trades cost for privacy. Worth it only for sensitive use cases.

**Recommendation: Anthropic Claude Haiku 3.5 as default; Claude Sonnet 4 for explicit "deep" turns.** GPT-5 mini is a drop-in alternate; pick based on which API key you already have.

## 5. TTS

Streaming text-to-speech. Latency budget: 70-150 ms first-byte.

| Provider | Model | TTFB | Cost |
|---|---|---|---|
| **ElevenLabs** | Flash v2.5 (eleven_flash_v2_5) | ~75 ms | $0.18/1k chars (~$0.36/min spoken) |
| **ElevenLabs** | Turbo v2.5 | ~270 ms | $0.30/1k chars |
| **Cartesia** | Sonic 2 | ~90 ms | $0.065/1k chars |
| **OpenAI** | tts-1-hd | ~450 ms | $0.030/1k chars |
| Local | Piper | ~50 ms | free |
| Local | Kokoro 82M | ~100 ms | free |

Spoken English is roughly 150 words/min, ~5 chars/word, so ~750 chars/min. A 10-minute call where the AI talks half the time produces ~3,750 chars. With ElevenLabs Flash: $0.68. With Cartesia: $0.24.

TTS is the most expensive provider slot for a chatty call. Cartesia is roughly 3x cheaper than ElevenLabs at similar latency.

### Free tier
ElevenLabs gives 10,000 characters/mo free. That is ~13 minutes of AI talking per month. Good for testing, not enough for daily use.

Cartesia free tier is similar (10k chars/mo).

### Local TTS
Piper runs on a CPU and produces decent-but-not-great voices in ~50 ms first-byte. Kokoro 82M is the better-sounding small model. Either is free and runs on the Fly free machine.

**Recommendation for v1: Cartesia Sonic 2.** Same latency as ElevenLabs Flash, 3x cheaper. ElevenLabs has slightly better voice quality but the gap is closing fast and Cartesia's price advantage is large.

If you want the absolute lowest cost: Piper or Kokoro on the cloud host.

## 6. Cloud host

Where the Pipecat service runs.

| Option | Spec | Cost | Notes |
|---|---|---|---|
| **Fly.io** | shared-cpu-1x, 256 MB | free (one machine) | scale-to-zero, ~30s cold start |
| **Fly.io** | shared-cpu-1x, 1 GB | $0/mo for the machine, + bandwidth | larger free machine |
| **Railway** | starter | $5/mo | always-on, no cold start |
| **Render** | free web service | free | spins down after 15 min inactivity, slow cold start |
| **Hetzner CX22** | 2 vCPU, 4 GB | ~$4/mo | always-on, full VPS |
| **Local + Cloudflare Tunnel** | your machine | $0 + electricity | works but laptop must stay on |

Pipecat one-call memory is ~150 MB. The 256 MB Fly machine handles one concurrent call comfortably. For more than one concurrent caller (not a v1 concern), bump to 1 GB.

Cold start matters because if the machine is asleep when a call comes in, Twilio's webhook will time out (Twilio waits ~15 s) and the call will fail. Two ways around it:
1. Pin the machine to "always on" (Fly.io: `min_machines_running = 1`). Costs a few dollars/month.
2. Use Railway / Hetzner / a VPS that does not scale to zero.

**Recommendation: Fly.io with `min_machines_running = 1` on a 256 MB machine.** ~$1.94/mo with the always-on bump. If you want zero-cost: same setup with `min_machines_running = 0` and accept the occasional dropped first-call after idle.

## 7. Optional: speech-to-speech (S2S)

For "just chat" mode where you do not need transcripts and want maximum latency cut:

| Provider | Model | Latency | Cost |
|---|---|---|---|
| **OpenAI** | gpt-realtime (gpt-4o-realtime) | ~500 ms | $5/min ($0.24/hr) of audio in + out |
| **Google** | Gemini Live | ~600 ms | varies, similar to OpenAI |

S2S is meaningfully more expensive than the cascade because it counts both the audio you speak and the audio it speaks back at audio-token rates. A 10-minute call at $5/min = $50. Yes, fifty cents per call. That is why the default is cascade.

S2S is worth it for: short casual chats where transcripts do not matter and lowest latency matters most.

**Recommendation: leave S2S off in v1. Add it in phase 5 if you find yourself wanting "just chat" mode.**

## 8. Total cost per call

A representative 10-minute call, default stack (Twilio + Deepgram Nova-3 + Claude Haiku + Cartesia Sonic + Fly.io always-on):

| Item | Cost |
|---|---|
| Twilio inbound (10 min) | $0.085 |
| Twilio number rental, amortized (10 min of a $1.15/mo) | $0.0027 |
| Deepgram STT (10 min) | $0.043 |
| Claude Haiku LLM | $0.027 |
| Cartesia TTS | $0.24 |
| Fly.io machine, amortized | $0.0011 |
| **Total** | **~$0.40 per 10 min call** |

That is **$2.40/hour of AI phone conversation**. Versus Vapi's $5-12/hour, that is a real cost saving once volume is high enough. For one user it is more about the principle than the dollars.

If you swap Cartesia -> ElevenLabs Flash: total becomes ~$0.85 per 10-min call. Still under a dollar.

If you swap Cartesia -> Piper local TTS: total becomes ~$0.16 per 10-min call.

If you swap Claude Haiku -> GPT-5 nano: shaves another $0.025/call.

**The cost floor with all-local STT + TTS + Llama 3.3 LLM**: ~$0.10/call (just Twilio + Fly).

## 9. Free-tier-only recipe

If you want to run phone-jarvis for $0/mo (modulo the Twilio number's $1.15):

- Twilio: free trial credit ($15.50, several hundred minutes)
- Deepgram: $200 free credit
- Anthropic / OpenAI: $5 trial credits
- Cartesia: 10k chars/mo free
- Fly.io: free 256 MB machine
- ElevenLabs / Cartesia: 10k chars overflow into the free tier

You can demo phone-jarvis without spending anything beyond the phone number. Once trial credits run out, costs are still under $5/mo for personal use.

## 10. What is not in this matrix

- **Wake word.** No wake word here; phone calls do not need one. Twilio rings the phone.
- **Voice cloning.** Out of v1 scope.
- **Multi-language.** All stack components support Spanish/French/German/etc. Default language is English; per-call language is configurable.
- **Call recording.** Twilio can record calls for $0.0025/min. Off by default for privacy. Enable per call if you want.
- **SMS fallback.** Twilio SMS is $0.0079/msg. Out of v1 scope.

## 11. Bottom line

For under $5/month plus free trial credits, you get a working AI phone agent. For $0 if you stay on free tiers. For under a penny per minute marginal once the free credits are gone.

The biggest single line item is TTS. Use Cartesia or local Piper to keep that down. Everything else is cents per call.
