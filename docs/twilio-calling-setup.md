# Twilio Calling & Messaging Setup

The desktop app **never** holds Twilio credentials. It calls `call-start`
(authenticated); the Edge Function checks subscription + call budget and
initiates the call. Twilio then hits signature-verified webhooks.

## 1. Twilio account

- Create a Twilio account, buy a voice+SMS capable phone number.
- Note your **Account SID** and **Auth Token**.
- (Optional) Create a Messaging Service and note its SID.

## 2. Set Supabase secrets

```powershell
npx supabase secrets set TWILIO_ACCOUNT_SID="AC..."
npx supabase secrets set TWILIO_AUTH_TOKEN="..."
npx supabase secrets set TWILIO_PHONE_NUMBER="+1..."
npx supabase secrets set TWILIO_MESSAGING_SERVICE_SID="MG..."   # optional
npx supabase secrets set APP_BASE_URL="https://tipeobvisjqvpbzcpckh.supabase.co"
```

## 3. Configure webhooks in Twilio

- Voice number "A call comes in" / outbound TwiML URL →
  `https://tipeobvisjqvpbzcpckh.supabase.co/functions/v1/twilio-voice-webhook`
- Call status callback (set automatically by `call-start`) →
  `.../functions/v1/call-status`
- Messaging webhook →
  `.../functions/v1/twilio-message-webhook`

## 4. Deploy

```powershell
npx supabase functions deploy call-start get-call-usage
npx supabase functions deploy twilio-voice-webhook --no-verify-jwt
npx supabase functions deploy twilio-message-webhook --no-verify-jwt
npx supabase functions deploy call-status --no-verify-jwt
```

## Security & budget guarantees (implemented)

- All Twilio webhooks verify the `X-Twilio-Signature` HMAC-SHA1 over the full
  URL + sorted params. Invalid signatures → 403.
- `call-start` requires auth, reserves a 1-minute minimum atomically, denies
  free users and exhausted budgets, and sets a hard `TimeLimit`
  (`MAX_CALL_SECONDS = 1800`).
- `call-status` settles the real duration against the call budget.
- SMS `STOP`/`UNSUBSCRIBE`/`HELP` keywords are handled (opt-out compliance).
- The Twilio auth token never reaches the client and is never logged.

## Budget model

Per-plan call budget (USD/month, internal): Starter $2.50, Pro $12.50,
Ultra $25. Surfaced to users only as minutes (≈ $0.10/min): 25 / 125 / 250.

## Blocked until you provide

- Twilio account SID, auth token, and a provisioned phone number.
- A live call/SMS round-trip (needs the above + deployed functions).
- The in-call media agent (STT→LLM→TTS streaming via `<Connect><Stream>`) is
  stubbed in `twilio-voice-webhook` with a greeting + time cap; wiring the live
  media pipeline (LiveKit/Pipecat) is a follow-up.
