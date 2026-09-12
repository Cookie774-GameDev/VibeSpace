# phone-jarvis cloud backend

The Pipecat-based voice loop. Runs on Fly.io free tier (or any Docker host).
Owns:

- Telnyx Call Control media streams for owner-approved third-party calls
- Deepgram Flux STT, DeepSeek reasoning, and Deepgram Aura TTS for those calls
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
├── telnyx_gateway.py      # approved-call media pipeline and exact usage settlement
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

| Secret                              | Source                                | Required for                    |
| ----------------------------------- | ------------------------------------- | ------------------------------- |
| `SUPABASE_URL`                      | your Supabase project                 | per-user auth + settings lookup |
| `SUPABASE_SERVICE_ROLE_KEY`         | Supabase dashboard → API              | server-side queries             |
| `TELNYX_API_KEY`                    | portal.telnyx.com                     | Call Anyone outbound voice      |
| `TELNYX_PUBLIC_KEY`                 | Telnyx Mission Control                | webhook signature verification  |
| `TELNYX_CALL_CONTROL_CONNECTION_ID` | Telnyx Call Control app               | Call Anyone                     |
| `TELNYX_PHONE_NUMBER`               | Telnyx number                         | Call Anyone caller ID           |
| `TWILIO_ACCOUNT_SID`                | console.twilio.com                    | Path A                          |
| `TWILIO_AUTH_TOKEN`                 | console.twilio.com                    | Path A                          |
| `TWILIO_PHONE_NUMBER`               | bought via Twilio                     | Path A inbound + outbound       |
| `LIVEKIT_API_KEY`                   | livekit.io free tier OR self-hosted   | Path C                          |
| `LIVEKIT_API_SECRET`                | livekit.io free tier                  | Path C                          |
| `LIVEKIT_URL`                       | e.g. wss://your-project.livekit.cloud | Path C                          |
| `DEEPGRAM_API_KEY`                  | console.deepgram.com (free $200)      | Path A premium STT              |
| `DEEPGRAM_FLUX_MODEL`               | approved Deepgram model name          | Call Anyone STT                 |
| `DEEPGRAM_AURA_MODEL`               | approved Deepgram voice               | Call Anyone TTS                 |
| `DEEPSEEK_API_KEY`                  | platform.deepseek.com                 | Call Anyone LLM                 |
| `DEEPSEEK_MODEL`                    | approved DeepSeek model               | Call Anyone LLM                 |
| `ANTHROPIC_API_KEY`                 | console.anthropic.com                 | Path A premium LLM              |
| `CARTESIA_API_KEY`                  | play.cartesia.ai                      | Path A premium TTS              |
| `GROQ_API_KEY`                      | console.groq.com (free)               | Path C default LLM/STT          |
| `BRIDGE_TOKEN_PEPPER`               | random 64-char hex (you generate)     | bridge auth                     |
| `MCP_PUBLIC_URL`                    | public HTTPS URL ending in `/mcp`     | official ChatGPT MCP resource   |

Per-user keys (Groq, Anthropic, etc.) are stored encrypted in Supabase
`phone_settings.byok_provider_keys` and looked up at call start.

Call Anyone additionally requires the five provider-rate environment variables
listed in `.env.example`. They drive measured-cost-to-credit settlement and
must match the operator's current contracts.
`CALL_ANYONE_MAX_CREDITS_PER_MINUTE` is the conservative server-side
reservation ceiling; the desktop cannot supply or override it.

## Browser Chat MCP

Browser Chat uses two independent connections:

- The desktop opens outbound `WSS /browser-chat/bridge` only after the user
  approves the current project for this app session.
- ChatGPT connects to public `POST /mcp` through the official Streamable-HTTP
  MCP protocol and signs in through the project's Supabase OAuth 2.1 server.

Enable Supabase Auth's OAuth 2.1 server, configure its consent page, migrate to
asymmetric JWT signing, and set `MCP_PUBLIC_URL` to the deployed HTTPS
endpoint. The MCP server accepts only OAuth tokens containing both `sub` and
`client_id`; it exposes directory listing and bounded text reads only. It
never exposes writes, shell access, absolute local paths, browser cookies, or
the embedded provider webview.

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

Call Anyone uses the authenticated Supabase `third-party-call` Edge Function
for prepare/approve/start, the public signature-verified
`telnyx-call-webhook` Edge Function for provider events, and
`wss://<phone-gateway>/telnyx/media` for approved media streams. The gateway
will not start a job that is unapproved, unreserved, or absent from Supabase.

## Production deploy

```bash
fly launch --name phone-jarvis-cloud --region <closest-to-you>
fly secrets set TWILIO_ACCOUNT_SID=AC... TWILIO_AUTH_TOKEN=...
# ... all other secrets ...
fly deploy
```

Set Twilio number's voice webhook to `https://<your-app>.fly.dev/twiml`.

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
