# Supabase Edge Functions

These run in **Supabase's Deno runtime**, not Node. They are deliberately
**excluded from the desktop app's TypeScript project** (`app/tsconfig.json`) and
are not compiled by the app build.

## Why `// @ts-nocheck`

Each function uses:
- URL imports (`https://esm.sh/@supabase/supabase-js`, `https://esm.sh/stripe`)
- Deno globals (`Deno.serve`, `Deno.env`, `crypto.subtle`, `EdgeRuntime`)

The app's Node-based `tsc` cannot resolve these, so type-checking them with the
app toolchain produces false errors. `@ts-nocheck` prevents that. This is the
standard pattern for Supabase functions and does **not** hide app type errors —
the app's `tsc --noEmit` never touches this directory.

To type-check the functions with the correct toolchain, use Deno directly:

```bash
deno check supabase/functions/**/index.ts
```

(Requires a local Deno install; not run as part of the app CI.)

## Functions

| Function | Auth | Notes |
|----------|------|-------|
| `tts-speak` | JWT | Cloud TTS; reserves the **shared call/voice budget** |
| `get-voice-usage` | JWT | Reads shared call/voice budget |
| `message-complete` | JWT | Company-paid AI messages; message budget |
| `get-message-usage` | JWT | Friendly credits |
| `call-start` | JWT | Authorizes a call; reserves call budget; duration cap |
| `get-call-usage` | JWT | Friendly minutes |
| `call-status` | Twilio sig | Settles real call duration |
| `twilio-voice-webhook` | Twilio sig | TwiML (greeting + time cap) |
| `twilio-message-webhook` | Twilio sig | Inbound SMS + STOP opt-out |
| `create-checkout-session` | JWT | Server-side price→plan |
| `create-customer-portal` | JWT | Stripe billing portal |
| `stripe-webhook` | Stripe sig | Raw-body verify, idempotent |
| `model-manifest` | public | Kokoro manifest (status `unavailable` until published) |
| `jarvis-proxy` | JWT | Pre-existing hosted DeepSeek proxy |

Deploy commands and required secrets are in `docs/supabase-setup.md`.
