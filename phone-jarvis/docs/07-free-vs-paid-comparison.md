# phone-jarvis - Free vs Paid Stack Comparison

*Three paths in: NetworkChuck-style 3CX, free-leaning LiveKit self-host, and in-app WebRTC. Side-by-side features, latency, quality, and what "free" actually means.*

---

## 1. The honest framing

"Completely free, unlimited, secure" decomposes into three different questions:

1. **The phone leg.** Does anyone with any phone need to be able to dial a number? PSTN is not free; the cheapest realistic floor is around a dollar per month for a number plus pennies per minute for the calls. The NetworkChuck "FREE cloud phone system" video is on AWS Lightsail's 12-month free tier, then ~$5/mo - and that is just the PBX server, not the SIP trunk that connects to PSTN.
2. **The brain.** LLM, STT, TTS, hosting. All of this can be 100% free forever via Oracle Cloud Always Free + Groq + local Whisper + local Kokoro. Rate limits exist but they are generous.
3. **The app-only path.** If you do not need a real phone number and the user is fine tapping a "Call Sage" button inside the Jarvis app on their phone or laptop, then **everything** can be free, including the voice transport (WebRTC). This is the right path for sharing Jarvis with other people.

This doc compares all three.

## 2. The three paths

### Path A: Twilio + paid providers (the original plan)
The path in `02-architecture.md` and `05-providers-and-cost.md`. Twilio number, Pipecat in the cloud, paid Deepgram + Anthropic + Cartesia. Easiest setup, most reliable, ~$5/mo per user. Already documented; not repeated here.

### Path B: NetworkChuck-style self-hosted SIP + free providers
The "lifetime free" path that closest matches the NetworkChuck video's spirit. Self-host a SIP PBX on Oracle Cloud Always Free (lifetime, not 12 months), bring a cheap DID for PSTN calls, and run Pipecat with free providers (Groq LLM, local Whisper STT, Kokoro TTS).

### Path C: In-app WebRTC inside Jarvis (the multi-user free path)
No PSTN at all. Users tap "Call Sage" inside the Jarvis desktop or mobile app. Audio flows over WebRTC to your Pipecat server. Same free providers as path B. Zero telco cost. This is what you want for sharing inside Jarvis.

## 3. The free stack (paths B and C)

| Slot | Free option | Notes |
|---|---|---|
| **Hosting** | Oracle Cloud Always Free | 4 ARM Ampere cores + 24 GB RAM, lifetime free, 10 TB egress/mo |
| **Voice transport (path C)** | LiveKit OSS / Daily Pipecat WebRTC | open source, runs on Oracle ARM box |
| **Voice transport (path B)** | LiveKit SIP server (built into LiveKit OSS) | bridges PSTN -> WebRTC; same Oracle box |
| **PSTN trunk (path B only)** | voip.ms / Telnyx pay-as-you-go | not free, but ~$1/mo + $0.005/min |
| **STT** | Groq Whisper Large v3 (free API) OR local Whisper.cpp | Groq is faster, has rate limits; local has no limits but uses CPU |
| **LLM** | Groq Llama 3.3 70B (free) OR local Llama via Ollama | Groq: 30 RPM, ~14k req/day, ~6k tokens/min - generous; local: slow on ARM CPU |
| **TTS** | Kokoro 82M (local) OR Piper (local) | both run on CPU, ~50-100 ms first byte |
| **Auth** | Better Auth / Supabase Auth free tier | both have generous free tiers |
| **Persistence** | SQLite on the Oracle box | free, simple |

This entire stack costs **$0/mo forever** (path C) or **~$1-2/mo for the DID** (path B). Provider rate limits are the only ceiling.

## 4. Side-by-side feature comparison

| Feature | Path A (Twilio + paid) | Path B (NetworkChuck-style free) | Path C (Jarvis in-app WebRTC) |
|---|---|---|---|
| **Cost setup** | $1.15/mo number | $0/mo (Oracle ARM lifetime) | $0/mo (Oracle ARM lifetime) |
| **Cost per call** | ~$0.40 / 10 min | ~$0.05 / 10 min (DID minutes only) | $0 |
| **Cold start** | ~3 s | ~3 s | <1 s (no PSTN handshake) |
| **Median turn latency** | 800 ms | 1000-1300 ms | 600-900 ms |
| **TTFT (first AI word)** | 250 ms | 400-600 ms | 200-400 ms |
| **Voice quality** | excellent (ElevenLabs/Cartesia) | good (Kokoro is decent) | good (Kokoro) |
| **STT accuracy** | excellent (Deepgram) | good (Groq Whisper, very close to Deepgram) | good (Groq Whisper) |
| **Reliability** | very high (Twilio uptime) | medium-high (Oracle uptime + Groq uptime) | high (you control the path) |
| **Caller can use any phone** | yes | yes (with DID) / no (SIP-only mode) | no, must use Jarvis app |
| **Caller needs Jarvis app** | no | no (PSTN), yes (WebRTC fallback) | yes |
| **Setup effort** | ~1 day (after phase 0-1) | ~3 days (more knobs) | ~2 days (Jarvis client work) |
| **Multi-user friendly** | needs per-user number ($1.15 each) | needs per-user DID (~$1 each) | yes, one server -> N users at zero marginal cost |
| **Rate limits** | provider quotas only | Groq 30 RPM, ~14k/day per key | Groq 30 RPM, ~14k/day per key |
| **Works offline (laptop)** | no, cloud needed | no, cloud needed | no, cloud needed |
| **Privacy floor** | Twilio + provider TOS | Oracle + Groq TOS (Groq does not train on free tier as of 2026-05) | Oracle + Groq TOS |
| **Open source** | partial (Pipecat + daemon) | mostly all | mostly all |

## 5. Latency reality check

Free is not free in latency. The reasons:

- **Local STT/TTS adds CPU overhead.** Whisper.cpp on the Oracle ARM box adds ~80-150 ms over Deepgram. Kokoro adds ~50 ms over Cartesia. These are CPU-bound; ARM cores are competent but not as fast as dedicated inference servers.
- **Groq LLM is fast.** Groq actually beats most paid LLMs on TTFT. Llama 3.3 70B on Groq is ~150-250 ms TTFT, sometimes faster than Anthropic. The 70B model also follows tool-call schemas well.
- **WebRTC vs PSTN.** WebRTC saves the ~180 ms PSTN one-way leg entirely. So path C actually has a lower median than path A despite slower individual components, when comparing apples-to-apples (caller in good wifi vs caller on cell).

The result: free + WebRTC is roughly **as fast as paid + PSTN** in practice. Free + PSTN is the slowest of the three because it stacks the PSTN delay on top of the slower local components.

## 6. Quality reality check

The biggest quality gaps:
- **TTS voice naturalness.** Kokoro 82M is good for an open model. Cartesia Sonic 2 and ElevenLabs Flash are noticeably more natural-sounding. Most users will not care after the first few calls. Cartesia for free-tier users wanting a step up: $0.065/1k chars after 10k/mo free.
- **STT in noisy environments.** Whisper Large v3 (via Groq) is among the best STT models in 2026. The gap to Deepgram is small for English; bigger for code-switched speech.
- **LLM tool-call reliability.** Llama 3.3 70B follows schemas well. Claude Sonnet is still the gold standard for complex multi-tool flows. For a phone agent doing simple file lookups, Llama 3.3 70B is plenty.

## 7. Rate-limit reality check

Groq's free tier is the constraint:

| Model | RPM | Tokens/min | Requests/day |
|---|---|---|---|
| Llama 3.3 70B | 30 | 6,000 | 14,400 |
| Llama 4 Scout | 30 | 30,000 | 1,000 |
| Whisper Large v3 | 20 | n/a (audio sec/min limit) | 28,800 sec/day |

For one user making personal calls: never going to hit it. 30 RPM = 1 LLM call every 2 seconds; a phone conversation is more like 1 LLM call every 5-10 seconds.

For multi-user (sharing inside Jarvis): you will hit the per-key limits when ~10 people are calling at once. Solution: each Jarvis user supplies their own Groq API key (free, no card required, takes 30 seconds to register). Groq does not enforce a per-account-but-shared-IP limit, so per-user keys give you N x 30 RPM total.

## 8. The 3CX-style flavor (closest to NetworkChuck's video)

If you want to follow the NetworkChuck video as literally as possible:

1. Spin up an **AWS Lightsail** instance (free for 12 months) OR an **Oracle Cloud Always Free ARM** instance (lifetime free).
2. Install **3CX** (free for up to 10 users / 1 SIP trunk). 3CX is a polished web-managed SIP PBX.
3. Buy a SIP trunk from voip.ms or Telnyx. ~$1/mo + per-minute.
4. Configure inbound DID -> 3CX extension that bridges to your AI service.
5. Run Pipecat as a **3CX queue agent** OR use 3CX's Webhooks/CFD module to fork the audio to a Pipecat WebRTC endpoint.

Honest take: 3CX is great for traditional PBX needs (voicemail, call routing, IVRs) but not optimized for real-time AI voice agent integration. The Pipecat-with-LiveKit-SIP path is meaningfully simpler for our use case. **3CX path is the most "NetworkChuck-faithful" but not the most efficient for AI.**

If your goal is "I want to follow the video and end up with phone-jarvis on top," do this:
- Use NetworkChuck's 3CX-on-Oracle-ARM setup as the host VM and PBX layer.
- Add a separate Pipecat container alongside 3CX on the same Oracle box.
- Have 3CX route calls into the Pipecat container via SIP.
- This works. It is just more pieces than necessary.

If your goal is "fully free phone-jarvis with the same Oracle hosting and the same NetworkChuck spirit," do this instead:
- Skip 3CX. Use **LiveKit's self-hosted SIP server** running on the same Oracle box.
- LiveKit + Pipecat is the canonical AI voice agent stack in 2026.
- Same free hosting, same DID provider, fewer moving parts.

## 9. Cost projection by user count

For sharing in Jarvis, what does it actually cost as users grow?

Assuming each user makes 30 minutes of calls per day on average.

| Path | 1 user | 10 users | 100 users | 1,000 users |
|---|---|---|---|---|
| A (Twilio + paid) | $5/mo | $50/mo | $500/mo | $5,000/mo |
| B (free + DID per user) | $1/mo | $10/mo | ~$100/mo | concurrency limit hit |
| B (free + shared DID) | $1/mo | $1/mo | $1/mo | concurrency limit hit |
| C (in-app WebRTC) | $0/mo | $0/mo | $0/mo | $0-50/mo (Oracle scale) |

Path C is the only one that scales to 1,000+ users for free. Path B with shared DID works up to a point - one DID can only handle one concurrent inbound call. Path A is per-user-linear in cost which makes it untenable to give away.

## 10. Recommendations

For a phone-jarvis you build, use, and ship to other people inside the Jarvis app, do this:

**Phase 0-1: Path A (Twilio + paid)** for fastest learning. Build the voice loop with the most reliable, best-documented stack. Pay $5-10 for credits. This is throwaway plumbing that proves the architecture works.

**Phase 2: Add Path C alongside Path A.** Add a WebRTC transport to the same Pipecat server. Now Jarvis users can "Call Sage" from the app, and the same Pipecat pipeline handles either input. Path C is what gets shipped to other Jarvis users.

**Phase 3: Migrate Path A to Path B if PSTN access matters.** If you want to keep a real phone number for personal use without the Twilio bill, swap to Oracle ARM + LiveKit SIP + voip.ms DID. Path B becomes your personal phone number; Path C is what your friends get.

**Phase 4+: Free-ify path A.** Once Path B is working, consider migrating providers: Deepgram -> Groq Whisper. Anthropic -> Groq Llama 3.3 70B. ElevenLabs -> Cartesia (still paid, but cheaper) or Kokoro (local, free). Each swap saves $.

The key insight is that **path C does not require giving up path A**. The same Pipecat backend can take calls from both Twilio (PSTN) and a WebRTC client (in-app). You build one server, run two transports.

## 11. What "completely secure" means in this context

Each path has a different trust model. Detail in `08-multi-user-and-jarvis-integration.md`. Quick summary:

| Path | Who sees the call audio | Who sees the transcripts | Who sees user files |
|---|---|---|---|
| A | Twilio + STT + TTS providers | LLM provider + you (cloud audit log) | only the user's own laptop daemon |
| B | Oracle host (you) + DID provider + Groq | Groq + you (audit log) | only the user's own laptop daemon |
| C | Oracle host (you) + Groq | Groq + you (audit log) | only the user's own laptop daemon |

In all three paths, the host operator (you) has access to call metadata and transcripts. To reduce your exposure: encrypt audit logs at rest, rotate provider keys regularly, set transcript retention to 0 days for users who request it. Full discussion in the security doc.

The user's own files are NEVER on the cloud server in any path. The laptop daemon runs on the user's own machine and is the only thing that can read their files. This is the structural safety guarantee.

## 12. Bottom line

You asked for "free, unlimited, secure, sharable." The honest answers:

- **Free**: yes for in-app (path C); near-free for PSTN (path B, ~$1/mo per number); $5/mo for the easy turnkey (path A).
- **Unlimited**: yes for personal use; rate-limited at high concurrency on free LLM tier (mitigation: BYO API keys per Jarvis user).
- **Secure**: yes - same security model in all three paths, since the trust boundary is the laptop daemon, not the call transport.
- **Sharable in Jarvis**: path C is the clean answer; build it after path A proves out.

Recommendation: build path A first to learn fast, add path C for sharing, leave paths B/3CX as v2 nice-to-haves.
