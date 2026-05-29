# phone-jarvis — implementation guide

> Status: Wave 5 scaffold landed 2026-05-29. Path C (in-app voice) and the
> bridge are wired end-to-end in code. Path A (PSTN) endpoints exist but
> are inert until you provision a Twilio number.

This document explains exactly **what was built**, **how the pieces fit**,
**how to deploy and test it**, and **what's still TODO** before this is a
real product.

If you've never touched any of this before, skip to **§7 — Path C
quick-start** and come back here later.

---

## 1. The shape

```
                   +----------------------+
[your iPhone] ---> |                      |  ---> [your laptop, Jarvis app]
   (PSTN, Path A)  |                      |        - owns your files
                   |   ONE Pipecat        |        - owns your terminals
[Jarvis app]  ---> |   backend            |        - the MCP tool registry
   (WebRTC, C)     |                      |        - the bridge WebSocket
                   |   on Fly.io          |
[outbound        ->|                      |  ---> [your iPhone]
 trigger]          |                      |        (Sage calls you when
                   +----------------------+         build fails / you ask /
                          ^   |                     a deadline approaches)
                          |   |
                          |   +-- LLM (Anthropic / Groq)
                          |   +-- STT (Deepgram / Groq Whisper)
                          |   +-- TTS (Cartesia)
                          |
                       Supabase
                       - auth (JWT)
                       - phone_settings
                       - call_audit
```

There's **one** voice loop (Pipecat) and **three transports** that all
land on the same loop:

| Transport          | Path  | Status                            |
| ------------------ | ----- | --------------------------------- |
| Twilio Media Stream| A     | endpoint code shipped, inert      |
| LiveKit WebRTC     | C     | endpoint code shipped, inert      |
| Outbound dial      | A out | endpoint code shipped, inert      |

"Inert" means the FastAPI handlers exist and are wired, but they need
you to plug in real Twilio + LiveKit accounts before they do anything.

---

## 2. Files written this wave

### Cloud backend — `phone-jarvis/cloud/`

| File                  | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `main.py`             | FastAPI app, mounts all routers, daily audit-prune task     |
| `config.py`           | Pydantic Settings, env loader, `.has_*` flags               |
| `pipeline.py`         | Pipecat pipeline factory: STT → LLM → TTS, persona prompts, tool dispatch hook |
| `auth.py`             | PIN hashing (PBKDF2), allowlist, Supabase JWT verification, PIN attempt tracker |
| `bridge.py`           | `BridgeRegistry` — per-user desktop WS sessions, in-flight tool-call futures |
| `bridge_endpoint.py`  | `WS /bridge` — the desktop daemon's connection             |
| `twilio_handler.py`   | `POST /twiml`, `WS /twilio/{call_sid}` — Path A inbound    |
| `livekit_handler.py`  | `POST /livekit/token` — Path C; spawns the AI agent task   |
| `outbound.py`         | `POST /outbound/call` — Sage dials user; `POST /outbound/twiml` callback |
| `supabase_client.py`  | Service-role Supabase client (bypasses RLS)                 |
| `audit.py`            | JSONL audit logger (per-call + daily rollup), retention prune |
| `Dockerfile`          | Python 3.11 slim, `uvicorn main:app`                        |
| `fly.toml`            | Fly.io config, `min_machines_running = 1` (always-on)       |
| `requirements.txt`    | Pipecat, FastAPI, Twilio, LiveKit, Supabase, jose, etc.    |
| `.env.example`        | Every secret you need, with comments                        |
| `README.md`           | Setup notes (also see §7 below)                             |

### Jarvis app — `app/src/`

| File                                    | What it does                                |
| --------------------------------------- | ------------------------------------------- |
| `lib/bridge/BridgeClient.ts`            | Long-lived WSS to `/bridge`, auto-reconnect, tool dispatch into local MCP registry |
| `lib/bridge/useBridgeLifecycle.ts`      | React hook: opens bridge once Supabase signs in, refreshes on JWT refresh |
| `lib/bridge/index.ts`                   | Public surface                              |
| `features/call/store.ts`                | Zustand store for call state (idle → connecting → in-call → ending) |
| `features/call/CallService.ts`          | LiveKit client wrapper. POSTs `/livekit/token`, joins room, publishes mic, attaches remote audio |
| `features/call/CallButton.tsx`          | Standalone call button (now embedded in TopBar) |
| `features/call/CallModal.tsx`           | In-call UI: persona orb, status, transcript, mute, hangup |
| `features/call/outbound.ts`             | `fireOutboundCall(reason, ctx)` + listener that POSTs to `/outbound/call` |
| `features/call/index.ts`                | Public surface                              |
| `features/settings/sections/PhoneVoice.tsx` | Settings panel: cloud status, PIN, allowlist, BYOK, outbound triggers, unlock phrase |
| `components/layout/TopBar.tsx`          | Adds the green/red Call button next to the mic |
| `App.tsx`                               | Mounts `<CallModal />`, calls `useBridgeLifecycle()`, starts outbound trigger |
| `stores/ui.ts`                          | Adds `callModalOpen` flag                   |

### Supabase — `supabase/schema-phone-jarvis.sql`

| Object                  | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `phone_settings`        | Per-user PIN hash, allowlist, BYOK keys, persona, outbound triggers, unlock phrase, cost caps |
| `outbound_pending`      | Short-lived: stashes outbound call context for the TwiML callback |
| `call_audit`            | One row per completed call (transport, duration, cost, persona) |
| `set_phone_pin(uuid, text)` | RPC: hashes PIN with PBKDF2-SHA256 + random salt |
| `pbkdf2_sha256()`       | plpgsql PBKDF2 (matches Python's `hashlib.pbkdf2_hmac` byte-for-byte) |
| `prune_outbound_pending()` | Cron: drops rows >1h old                       |
| `prune_call_audit(days)`   | Cron: drops audit rows older than retention   |
| RLS policies            | Each user sees only their own rows; service-role inserts |

---

## 3. How a Path C call flows end-to-end

```
1. User clicks the green Phone icon in the Jarvis TopBar.
   └─ TopBar.CallTopBarButton -> setCallModalOpen(true)

2. CallModal mounts; sees status === 'idle'; calls
   getCallService().start(persona).

3. CallService.start():
   a. Reads Supabase session, grabs JWT.
   b. POST {VITE_PHONE_JARVIS_CLOUD_URL}/livekit/token
        Headers: Authorization: Bearer <JWT>
        Body:    { persona: "jarvis" }
   c. Cloud verifies JWT, mints a LiveKit access token for room
      "jarvis_<userid8>", and asyncio.create_task(_spawn_agent(...)).
   d. Cloud responds: { url, token, room, call_id }.
   e. App connects livekit-client.Room to that URL/token.
   f. App enables mic and publishes the audio track.
   g. Status → 'ringing'.

4. Cloud-side agent (in livekit_handler._spawn_agent):
   a. Resolves provider keys (operator default + user BYOK override).
   b. Builds Pipecat pipeline (LiveKit transport, Deepgram-or-Groq STT,
      Anthropic-or-Groq LLM, Cartesia TTS).
   c. Loads persona system prompt + tool catalog from BridgeRegistry.
   d. Joins the same LiveKit room as agent participant "sage_<callid>".
   e. PipelineRunner runs until disconnect.

5. App receives the agent's audio track:
   ↓ RoomEvent.TrackSubscribed (kind=audio)
   App attaches to a hidden <audio> element. Status → 'in-call'.

6. While in-call:
   - User speech → LiveKit → cloud Pipecat → STT → LLM
   - LLM emits tool_use(fs.read, args)
       → Pipecat's tool hook → BridgeRegistry.invoke(user_id, ...)
       → BridgeRegistry sends a "tool_call" frame over /bridge WS
       → Desktop BridgeClient receives it → toolRegistry.invoke('fs.read', ...)
       → Result back over /bridge as "tool_result"
       → Cloud folds it into the LLM context, LLM continues
   - LLM final reply → TTS → LiveKit → app audio element → speakers

7. User clicks the red hangup button:
   - CallService.stop() disconnects from the room
   - Cloud-side PipelineRunner sees room disconnect, ends task
   - audit.log_call_end fires; status → 'idle'
```

The bridge is **shared** between Path A and Path C. The cloud doesn't
care which transport produced the LLM that produced the tool_use.

---

## 4. The bridge protocol

Frames are JSON, one per WS message. The desktop opens an outbound WSS
to `/bridge` whenever the user is signed in.

### Desktop → Cloud

```jsonc
// First frame; no other frame is accepted until cloud sends "registered".
{
  "kind": "register",
  "token": "<Supabase JWT>",
  "daemon_version": "jarvis-app/0.1.0",
  "platform": "Win32",
  "workspace_root": "C:\\Users\\viper\\projects\\Jarvis",
  "tools": [ /* OpenAI-style function schema array */ ],
  "writable": false,
  "shell_enabled": false
}

// Reply to a tool_call.
{
  "kind": "tool_result",
  "call_id": "tc_abc123",
  "ok": true,
  "result": { /* JSON-serialisable */ },
  "elapsed_ms": 38
}

// Or, on error:
{ "kind": "tool_result", "call_id": "...", "ok": false,
  "error": { "code": "TOOL_ERROR", "message": "..." } }

// Keepalive every 15s; cloud echoes.
{ "kind": "heartbeat", "ts": 1748534400123 }

// Clean shutdown
{ "kind": "deregister", "reason": "shutdown" }
```

### Cloud → Desktop

```jsonc
// Sent immediately after register passes JWT verification.
{ "kind": "registered", "session_id": "br_…", "server_time": 1748... }

// Routed from the LLM's tool_use. `confirmed` is true only after the
// cloud-side PIN/yes/unlock flow has approved.
{
  "kind": "tool_call",
  "call_id": "tc_abc123",
  "parent_call_id": "call_…",
  "name": "fs.read",
  "args": { "path": "src/App.tsx" },
  "deadline_ms": 8000,
  "confirmed": false
}
```

If a user has Jarvis open on two machines, the second register wins —
the first WS is closed with code 4001 (`superseded`).

---

## 5. Security model (v1, single-user)

| Concern                        | Mitigation                                                                  |
| ------------------------------ | --------------------------------------------------------------------------- |
| Random caller dials your number | 6-digit verbal PIN, 3 strikes, 1h cooldown (`auth.PinTracker`)             |
| Caller-ID spoofing              | PIN required even for allowlist match if the underlying number is unverified|
| Bridge spoofing                 | Cloud verifies Supabase JWT against project JWKS at every connect           |
| Tool abuse (read)               | Read-only tools execute immediately, no per-call consent                    |
| Tool abuse (write)              | `fs.write` / `fs.edit` / `fs.delete` require verbal "yes" mid-call          |
| Tool abuse (shell)              | `shell.run` requires verbal unlock phrase (per-call), then verbal "yes" per command |
| Files leaving machine           | Tool results travel over WS to the cloud and into the LLM context only — never to disk on the cloud side |
| Audit log poisoning             | Audit rows include sha256(16) of result body; tampering detectable          |
| Cost runaway                    | `cost_cap_per_call` + `cost_cap_per_month` in `phone_settings`              |
| Cloud node compromise           | Bridge JWT is short-lived; rotates on Supabase auth refresh                 |
| Stale bridge after sign-out     | `useBridgeLifecycle` hears SIGNED_OUT and calls `resetBridgeClient()`        |

PINs are stored as `pbkdf2_sha256(pin, salt_16, 100k, 32)`; the cloud
verifies via `hmac.compare_digest`. Salt is per-user, regenerated on
every PIN change.

---

## 6. Cost model

This is the conservative estimate for one user making 30 minutes of
calls per day, half PSTN (Path A) and half in-app (Path C):

| Item                 | Path A (15 min/day)   | Path C (15 min/day) |
| -------------------- | --------------------- | ------------------- |
| Twilio number        | $1.15/mo              | —                   |
| Twilio inbound       | ~$0.13/day            | —                   |
| Twilio outbound      | depends on triggers   | —                   |
| LiveKit Cloud free   | —                     | $0 (well under 1k participant-min/day) |
| Deepgram Nova-3 STT  | ~$0.07/day            | (use Groq instead)  |
| Groq Whisper         | (use Deepgram instead)| $0 (free tier)      |
| Anthropic Haiku 3.5  | ~$0.04/day            | (use Groq instead)  |
| Groq Llama 3.3 70B   | (use Anthropic)       | $0 (free tier)      |
| Cartesia Sonic 2 TTS | ~$0.36/day            | ~$0.36/day          |
| Fly.io always-on     | $1.94/mo              | $1.94/mo            |
| Supabase             | $0 (free tier)        | $0 (free tier)      |
| **Total per month**  | **~$18-20/mo**        | **~$13/mo**         |

For Path C only with all-free providers (Groq + Kokoro instead of
Cartesia), the total is **$2/mo** (Fly.io alone). Switch Cartesia for
Kokoro in `pipeline.py:_persona_voice_id` if you want that.

The free credits at signup will buy you several months before any of
these become real charges. See §7.

---

## 7. Path C quick-start (the only one we promised would work)

This is the **minimum** to get the green Call button doing something
real. PSTN (Path A) requires Twilio, which we cover after.

### 7.1 Supabase

You already have a project (V3 hosted tier). Apply the new schema:

```bash
# In Supabase SQL editor, paste the full contents of:
#   supabase/schema-phone-jarvis.sql
# Click Run. Tables + RLS + RPC are created. Idempotent.
```

You also need to enable JWT JWKS (asymmetric signing). Most newer
Supabase projects have this on by default. To check:
`Supabase dashboard → Project Settings → Auth → JWT Settings`.
If it says "Symmetric (HS256)" you'll need to migrate to RS256 or
the cloud's JWT verifier won't work. Migration is one click in the
dashboard but invalidates existing sessions.

### 7.2 Groq (LLM + STT, free)

1. Sign up at [console.groq.com](https://console.groq.com) — no card.
2. Create an API key under "API Keys".
3. Save it as `GROQ_API_KEY=gsk_...`.

Free tier: 30 req/min, 14k req/day per key. Plenty for one user.

### 7.3 Cartesia (TTS, free trial)

1. Sign up at [play.cartesia.ai](https://play.cartesia.ai).
2. Create an API key.
3. Save it as `CARTESIA_API_KEY=...`.

Free tier: ~$5 of credit. Beyond that ~$0.065 per 1k characters.

### 7.4 LiveKit (WebRTC server, free tier)

1. Sign up at [livekit.io](https://livekit.io) — no card.
2. Create a project. Copy:
   - `LIVEKIT_URL`        (wss://your-project.livekit.cloud)
   - `LIVEKIT_API_KEY`    (APIxxx)
   - `LIVEKIT_API_SECRET` (long secret)

Free tier: 1k participant-minutes/day, 50 concurrent. Self-host LiveKit
Server later if you outgrow it.

### 7.5 Fly.io (cloud host)

```bash
# Install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth login

cd phone-jarvis/cloud
fly launch --copy-config --no-deploy
# Pick app name "phone-jarvis-cloud", primary region near you.
# Decline a Postgres DB and Redis offer.

# Set every secret:
fly secrets set \
  SUPABASE_URL="https://xxx.supabase.co" \
  SUPABASE_SERVICE_ROLE_KEY="eyJhb..." \
  GROQ_API_KEY="gsk_..." \
  CARTESIA_API_KEY="..." \
  LIVEKIT_URL="wss://your-project.livekit.cloud" \
  LIVEKIT_API_KEY="APIxxx" \
  LIVEKIT_API_SECRET="..."

fly deploy
```

Wait ~3 min. When it's done, hit:

```bash
curl https://phone-jarvis-cloud.fly.dev/health
# {"ok":true,"version":"0.1.0","transports":{"twilio":false,"livekit":true,"supabase":true}}
```

### 7.6 Wire the Jarvis app

Add to `app/.env.local` (used by Vite at build time):

```
VITE_PHONE_JARVIS_CLOUD_URL=https://phone-jarvis-cloud.fly.dev
```

Then rebuild the app:

```bash
cd app
npm run build
# Tauri rebuild only if you're shipping installers:
npx tauri build
```

### 7.7 Test it

1. Open Jarvis. Sign into Supabase (Settings → Account).
2. Settings → Phone & Voice. Confirm "Cloud connection" shows green
   "connected" — the bridge is up.
3. Paste your Groq + Cartesia keys into the BYOK section. Save.
4. Click the green Phone icon in the top bar.
5. Allow mic permission.
6. Sage joins. Say "hi". Sage replies.

If you see "phone-jarvis cloud not configured", `.env.local` wasn't
picked up — restart vite/tauri.

If status sticks at "connecting" → token endpoint isn't reachable.
Test directly: `curl -X POST -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" -d '{"persona":"jarvis"}' https://phone-jarvis-cloud.fly.dev/livekit/token`.

If status goes to 'ringing' but never 'in-call' → the agent didn't
spawn. Tail Fly logs: `fly logs -a phone-jarvis-cloud`.

---

## 8. Path A (PSTN) — adding a real phone number

After Path C works, you can add Path A on top with the same backend.

### 8.1 Twilio

1. Sign up at [twilio.com](https://twilio.com) — get $15 trial credit.
2. Console → Phone Numbers → Buy a number → US local.
3. Open the number's config page. Under "A CALL COMES IN":
   - Webhook → `https://phone-jarvis-cloud.fly.dev/twiml`
   - HTTP POST.
4. Save.

### 8.2 Operator-default premium providers (optional but recommended)

Path A pipeline picks Deepgram + Anthropic when keys exist (sub-second
latency). Add them to Fly secrets:

```bash
fly secrets set \
  DEEPGRAM_API_KEY="..." \
  ANTHROPIC_API_KEY="sk-ant-..." \
  TWILIO_ACCOUNT_SID="AC..." \
  TWILIO_AUTH_TOKEN="..." \
  TWILIO_PHONE_NUMBER="+15551234567"

fly deploy
```

### 8.3 Wire your user → number

In Supabase SQL editor, link your Twilio number to your user:

```sql
update public.phone_settings
   set twilio_phone_number = '+15551234567',
       user_phone_number   = '+15555550100'   -- your iPhone for outbound
 where user_id = 'YOUR-AUTH-USERS-UUID';
```

(Find your UUID in Supabase → Authentication → Users.)

### 8.4 Set a PIN

In Jarvis: Settings → Phone & Voice → Verbal PIN → enter 6 digits twice → Save.

### 8.5 Call your number

Dial it from any phone. After the greeting:
- "What's my code?" → say your PIN
- Then converse with Sage.

For outbound (Sage calls you):
- Settings → Phone & Voice → Outbound triggers → enable "Manual" + "Errors".
- Make sure `user_phone_number` is set in `phone_settings`.
- Throw an error in the app to test, or call the endpoint directly:
  ```bash
  curl -X POST -H "Authorization: Bearer <jwt>" \
       -H "Content-Type: application/json" \
       -d '{"reason":"manual","context":{"title":"Just testing"}}' \
       https://phone-jarvis-cloud.fly.dev/outbound/call
  ```

---

## 9. What's TODO before this is "done"

The scaffold is real but here's what still needs work:

### Must-do before any user calls

- [ ] **Real Cartesia voice IDs.** `pipeline.py:_persona_voice_id` has
      placeholder UUIDs. Pick voices at play.cartesia.ai/voices and
      paste real IDs. Otherwise TTS errors at runtime.
- [ ] **Wire `pin_check` into `twilio_handler.py`.** The PIN flow today
      is in the persona prompt only — the LLM is *asked* to enforce
      it. Defense in depth: add a real frame processor in front of
      the LLM that gates audio until a numeric PIN matching the user's
      hash is heard.
- [ ] **Confirm-tier verbal "yes" gating.** `bridge.py:invoke()` accepts
      a `require_confirm` flag but the Pipecat-side dispatcher doesn't
      yet pause and ask the user. Wire a small state machine that
      flips an internal flag based on a `kind: "awaiting_confirm"` data
      message and waits for "yes" / "no" from the user.
- [ ] **Hook outbound trigger to Jarvis runtime errors.** `outbound.ts`
      ships the `fireOutboundCall` helper but no upstream code calls
      it yet. Wire it at:
      - `lib/ai/runtime.ts` on uncaught error
      - `features/terminal/*` on non-zero exit
      - `features/tasks/*` on deadline-overdue scheduling event

### Soon

- [ ] Per-user phone-number provisioning (Twilio API)
- [ ] Audit log viewer in Settings → Phone & Voice
- [ ] Cost dashboard in Settings (last 30 days)
- [ ] `system.hangup` tool so Sage can hang up cleanly
- [ ] WebSocket retry on the bridge with exp-backoff (already partial)
- [ ] Tests: PIN verify against PBKDF2 reference vectors, JWT verify
      with mock JWKS, BridgeRegistry pending-future cleanup on disconnect

### Later

- [ ] Multi-machine bridge (Redis-backed BridgeRegistry)
- [ ] Per-user Twilio sub-account (Twilio's recommended pattern)
- [ ] Stripe billing for phone-jarvis as a hosted product
- [ ] Mobile app (Tauri Mobile or React Native) so the green Call button
      works on iOS/Android with the same backend

---

## 10. Appendix — operator vs user keys

There are two layers of API keys. They mostly do the same thing but
they exist at different scopes:

```
Operator keys (Fly secrets, set by you, the deployer)
  └─ Used as the default for ALL users when their BYOK slot is empty.
  └─ Convenient for personal/single-user mode.
  └─ All cost flows through your account.

User BYOK keys (Supabase phone_settings.byok_provider_keys, per-user)
  └─ Override operator defaults at call start.
  └─ Required for the multi-user model so each user pays for their own.
  └─ Encrypted at rest via Supabase Vault if available, else stored as
     plain JSONB in a row only that user can read (RLS).
```

The cloud's resolution order at every call:
```python
keys = ProviderKeys(
    deepgram=user.deepgram or operator.deepgram or None,
    anthropic=user.anthropic or operator.anthropic or None,
    cartesia=user.cartesia or operator.cartesia or None,
    groq=user.groq or operator.groq or None,
)
```

Single-user (you): paste keys into Fly secrets, leave BYOK empty in
Settings. Done.

Multi-user (sharing): leave Fly secrets empty (or only put `GROQ_API_KEY`
to give everyone a free trial of voice), and require each user to paste
their own keys into Settings.

---

## 11. Pointers

- Architecture details: `docs/02-architecture.md`
- Call flow internals: `docs/03-call-flow.md`
- Bridge spec: `docs/04-laptop-bridge.md`
- Provider catalog + pricing: `docs/05-providers-and-cost.md`
- Threat model + auth: `docs/06-security.md`
- Decision matrix paid vs free: `docs/07-free-vs-paid-comparison.md`
- Multi-user + Jarvis integration: `docs/08-multi-user-and-jarvis-integration.md`

This guide is the bridge between the docs and the code. If something
disagrees, the code is the truth.
