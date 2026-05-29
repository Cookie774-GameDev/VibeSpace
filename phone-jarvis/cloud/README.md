# phone-jarvis cloud backend

The Pipecat-based voice loop. Runs on Fly.io free tier (or any Docker host).
Owns:
- Twilio Programmable Voice webhook (Path A — real phone number, inbound)
- Twilio outbound calling (Path A — Jarvis calls user)
- LiveKit WebRTC room hosting (Path C — in-app voice)
- Tool dispatch bridge to desktop daemons (per-user routing)

## Layout

```
cloud/
├── README.md              # this file
├── Dockerfile
├── fly.toml               # Fly.io deploy config
├── requirements.txt
├── main.py                # FastAPI app entrypoint
├── config.py              # env loader, provider keys
├── pipeline.py            # Pipecat pipeline factory (cascade STT->LLM->TTS)
├── twilio_handler.py      # /twiml endpoint + /twilio/<call_sid> WS
├── livekit_handler.py     # /livekit/token endpoint + room provisioning
├── outbound.py            # Twilio outbound dial logic
├── bridge.py              # /bridge/<token> WS — desktop daemon tool dispatch
├── auth.py                # PIN, caller-ID allowlist, per-call session tokens
├── audit.py               # JSONL audit logger
├── tools.py               # Tool catalog forwarded to LLM (proxies to bridge)
├── prompts/
│   └── persona.md         # System prompt template (Sage default)
└── tests/
    └── test_auth.py       # PIN verification, caller allowlist
```

## What you (operator) need to provide

Set as Fly.io secrets via `fly secrets set KEY=value`:

| Secret | Source | Required for |
|---|---|---|
| `SUPABASE_URL` | your Supabase project | per-user auth + settings lookup |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard → API | server-side queries |
| `TWILIO_ACCOUNT_SID` | console.twilio.com | Path A |
| `TWILIO_AUTH_TOKEN` | console.twilio.com | Path A |
| `TWILIO_PHONE_NUMBER` | bought via Twilio | Path A inbound + outbound |
| `LIVEKIT_API_KEY` | livekit.io free tier OR self-hosted | Path C |
| `LIVEKIT_API_SECRET` | livekit.io free tier | Path C |
| `LIVEKIT_URL` | e.g. wss://your-project.livekit.cloud | Path C |
| `DEEPGRAM_API_KEY` | console.deepgram.com (free $200) | Path A premium STT |
| `ANTHROPIC_API_KEY` | console.anthropic.com | Path A premium LLM |
| `CARTESIA_API_KEY` | play.cartesia.ai | Path A premium TTS |
| `GROQ_API_KEY` | console.groq.com (free) | Path C default LLM/STT |
| `BRIDGE_TOKEN_PEPPER` | random 64-char hex (you generate) | bridge auth |

Per-user keys (Groq, Anthropic, etc.) are stored encrypted in Supabase
`phone_settings.byok_provider_keys` and looked up at call start.

## Phased deploy

1. **Phase 0** — `fly launch`, `/twiml` returns hardcoded TwiML, dial number → robot voice. Done in 1h.
2. **Phase 1** — Pipecat pipeline + Deepgram + Claude + Cartesia. Real conversation, no tools. ~3 days.
3. **Phase 2** — `/bridge/<token>` WS endpoint, dispatch tool calls to desktop. ~2 days.
4. **Phase 3** — LiveKit WebRTC room provisioning, in-app calling. ~2 days.
5. **Phase 4** — outbound calling, audit log, PIN, allowlist. ~2 days.

## Local dev

```bash
cd cloud/
python -m venv .venv
.\.venv\Scripts\Activate.ps1   # Windows
pip install -r requirements.txt
copy .env.example .env
# fill in keys
uvicorn main:app --reload --port 8080
```

Twilio webhook for local dev: use `ngrok http 8080` and set Twilio number's voice webhook to the ngrok URL.

## Production deploy

```bash
fly launch --name phone-jarvis-cloud --region <closest-to-you>
fly secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=...
# ... all other secrets ...
fly deploy
```

Set Twilio number's voice webhook to `https://phone-jarvis-cloud.fly.dev/twiml`.

Then:
- Inbound: dial the number → AI picks up
- Outbound: Jarvis app sends a request to `/outbound/call` with the user's stored phone number
- In-app: Jarvis app requests a LiveKit token from `/livekit/token`, joins the room, AI agent joins the same room

## Cost

~$2-3/mo Fly.io always-on, plus pay-as-you-go provider fees scaled by call volume.
For a user making 30 minutes of calls per day:
- Twilio: ~$0.30/day
- Deepgram + Claude + Cartesia: ~$0.50/day
- Total: ~$24/mo per heavy user (free credits cover the first ~3 months)

For Path C (in-app, no Twilio leg): LiveKit free tier gives 1000 participant-minutes/day. With Groq + Cartesia free tier: $0/mo for moderate use.
