# Phone and SMS readiness — October 4, 2026

Agent/task: `VS-CODEX-A6-PHONE-20261004-T6` / `PHONE-SMS-READINESS`.
Canonical checkout: `C:/Users/viper/VibeSpace-UnifiedChungus`, branch `UnifiedChungus`.
Base: `649ed2f4d113c0907fcaea3290b8ad7546822986`.

**Verdict: not ready for live calling or paired Jarvis SMS.** Existing implementations were audited and repaired locally. No service was deployed, enabled, registered, funded, or exercised with a billable call/text. This updates the phone-related findings in `PR31_FULL_BACKEND_FEATURE_AUDIT.md`; it does not certify unrelated backend systems.

## Current evidence

- The official native window was observed read-only: PID `34716`, executable `D:/VibeSpace-BuildCache/n8-final-target/debug/jarvis.exe`, WebView PID `34292`, official desktop profile, CDP port `9259`, native window label `main`. At `2026-10-04T21:53:14Z`, its actual `callCloudUrl()` was empty and cloud sign-in state was false. No navigation, microphone activation, token request, or provider request was performed.
- `app/.env.local` configures the expected Supabase project. It does not configure `VITE_PHONE_JARVIS_CLOUD_URL`. No local phone-service `.env` exists. Local configuration absence does not prove that hosted secret stores are empty; hosted Twilio/Telnyx/LiveKit credentials and phone-service deployment remain unverified.
- Read-only connector inventory for the configured Supabase project found 21 deployed Edge Functions. `third-party-call` and `telnyx-call-webhook` are absent. `call-start`, `sms-send`, `twilio-message-webhook`, and `twilio-voice-webhook` exist.
- Schema metadata contains `phone_settings` and `outbound_pending`. Current Call Anyone contacts/jobs/approvals and remote-messaging identity/pairing/event/turn tables and RPCs are absent. These were metadata queries; no customer rows or message contents were read.
- Retrieved deployed sources differ from current local `call-start`, `sms-send`, and `twilio-message-webhook`. Deployed `twilio-voice-webhook` matches the local minimal greeting/goodbye implementation; it does not provide the conversational media loop. Deployed `twilio-message-webhook` handles STOP/HELP and usage recording, with no pairing or AI completion.
- The old audit's blanket snapshot is not reused: the current deployment includes subsequent telemetry functions and a compatibility-repair migration. The phone-related schema/function drift above was verified independently against current metadata and source.

## Route matrix

| Existing route | Implemented source | Current activation/result |
| --- | --- | --- |
| Twilio calls the owner's saved number | Desktop outbound event listener calls cloud `/outbound/call`; JWT resolves the account and server reads its saved number/category preferences. Twilio callback enters the Pipecat media route. | Native phone URL missing; hosted cloud/provider configuration unknown; no dial or audio verified. Deployed Supabase `call-start` is a separate older budgeted dial path whose voice callback only greets and ends. |
| LiveKit in-app AI call | Desktop requests `/livekit/token` with Supabase JWT, joins a per-user room, publishes microphone, and subscribes to the background Pipecat agent. | Corrected both SDK token TTL failures locally. Native URL/sign-in missing; hosted room connectivity, provider audio, and full media dependency compatibility remain unverified. |
| Telnyx Call Anyone | Existing prepare/approve/start functions, exact approval fingerprint, credit reservation, signed provider events, media gateway, and scheduled desktop dispatcher. | Required Edge Functions and job/contact/approval schema are absent from the configured deployment. Provider credentials, rates, sender, and callback registration also need operator verification. |
| Twilio outbound SMS to own number | Desktop uses authenticated metered `sms-send`; server chooses saved E.164 destination, enforces rate/budget windows, and records settlement. | Function exists but deployed source is older. Credentials, sender availability, budget eligibility, and carrier delivery are unverified. The unused unmetered cloud `/outbound/message` route now fails closed with HTTP 410. |
| Paired inbound SMS / Jarvis replies | Current signed Twilio webhook redeems pairing codes, resolves identities, deduplicates events, loads conversation history, checks service access, and performs metered remote completion. | Live inbound code has no pairing or replies, and required remote-messaging schema/RPCs are absent. Current source must be rehearsed and deployed before registration/live acceptance. |

## Credentials and automation

Twilio account/token/sender, Telnyx account/signing key/Call Control application/sender, LiveKit API key/secret/URL, Supabase server credentials, the public phone origin, bridge signing pepper, speech/LLM/TTS defaults, and metering rates are **operator configuration**. They never belong in desktop `VITE_` secrets. Ordinary users sign in, save their own number, choose opt-ins, provide Call Anyone approval, or pair their SMS identity. User AI-provider BYOK overrides are optional in the cloud resolver when operator defaults exist; phone carrier credentials are not per-user requirements.

Setup does not provision carrier accounts, numbers, credentials, webhooks, or missing deployments automatically. After activation:

- An explicit owner-call request dispatches through the running desktop's listener. Other event categories require opt-in; this audit found the listener and manual/scheduled producer, not proof that every advertised error category has a producer.
- Owner-call scheduling currently uses a desktop timer. It is not a verified cloud cron or a guarantee while the app is closed.
- Approved Telnyx schedules are persisted server-side but dispatched by the signed-in desktop runner, which polls every 30 seconds. Job claims prevent duplicate dispatch. Required scheduling schema is not deployed here.
- Inbound paired SMS can reply automatically after signature, identity, access, replay, and usage gates pass, once the current webhook and schema are deployed.

## Local repairs

- `phone-jarvis/cloud/main.py`: mounts the existing kill switch; disabled services remain healthy for liveness but do not advertise operational transports.
- `security.py`, `twilio_handler.py`, `outbound.py`: validate signed callbacks against the configured public origin, reject unsigned media upgrades, reuse existing one-time media tokens bound to the user/call, ignore untrusted custom identity/preauth, reject missing outbound owners, and sanitize outbound context. Canonical upgrade validation covers HTTPS/WSS and documented trailing-slash variants without trusting client Host headers. Unauthenticated callers receive no desktop tool schema.
- `livekit_handler.py`: supplies `timedelta(hours=1)` in both participant and agent token paths, matching the actual pinned `livekit-api==1.0.5` API.
- `outbound.py`: retains the legacy SMS endpoint as an explicit HTTP 410 response. The existing desktop already uses metered `sms-send`; no replacement transport was introduced.
- `_shared/budget.ts`: uses an explicit `.ts` dependency path so Node/Deno can resolve the Edge helper. A narrow directive accommodates the desktop's existing extension-import restriction on this cross-runtime import; the rest of the helper remains typechecked. Desktop compiler settings are unchanged.
- Call/SMS preflight tests now assert the existing empty HTTP 204 response. The scheduled-call test uses a future timestamp instead of an expired September fixture.
- `test_phone_readiness_routes.py`: covers disabled service, unsigned callbacks/upgrades, canonical callback origin, replay and forged media identity, missing pending owner, both real SDK token paths, and disabled unmetered SMS. Audio/provider/database execution is mocked; these tests do not establish live delivery.

## Remaining boundaries before enablement

1. Rehearse the missing schema dependencies, including Call Anyone migration `0036`, remote messaging `0046`/service access `0047`, and scheduling `0051`, on an authorized disposable environment. Compare actual schema/RPC inventory rather than blindly applying migration names over the compatibility-repair history.
2. Deploy the reviewed current Edge Functions and cloud code through separately authorized release work; verify deployed digests and callback origins.
3. Configure the operator secrets, nonzero contract-based rates, sender/application registration, HTTPS/WSS callbacks, and desktop public URL. Keep `PHONE_JARVIS_ENABLED=false` until readiness checks pass.
4. Complete the remaining cloud voice contracts: the current Twilio/LiveKit Pipecat path verifies JWT identity but has no demonstrated subscription/access gate, atomic call-budget reservation/settlement, or enforced duration cap. Its advertised voice PIN/unlock flow is not wired to a verified frame gate. The repair withholds desktop tools from unconfirmed Twilio callers; it does not implement a new PIN system. Admin metrics remain a public stub. The older deployed `call-start` accepts a client destination, unlike the saved-number-only cloud route; review that separate endpoint before enabling public calling. These are source gaps, not credential-only activation steps.
5. Run authorized native and provider acceptance: signed-in own-number call, bidirectional in-app audio, approved Telnyx call/cancel/settlement, outbound own-number SMS, pairing/replay/STOP/HELP/reply, invalid signatures, outage, duration limits, and actual provider accounting. No such live acceptance is claimed here.

## Verification receipts

Task-owned evidence: `D:/VibeSpace-Agent6-Phone-20261004-T6/`.

- Phone/cloud baseline: 30 passed. Route regression before fixes: 10 failed as expected after an initial missing-SDK fixture error was corrected. Legacy SMS regression: 1 failed before HTTP 410 protection.
- Full available cloud suite with isolated pinned LiveKit SDK and mocked media/database boundary: **51 passed**, five existing FastAPI lifecycle deprecation warnings.
- Eight focused Edge suites: **143 passed**. Initial failures were preserved: extensionless helper resolution, expired schedule fixture, and stale preflight status expectations.
- Seven frontend call/PhoneVoice suites: **38 passed**.
- Release manifest: **45 passed**. Python fatal-error static checks passed.
- Final app typecheck/build/full-suite results are recorded in the completion checkpoint below; the first app typecheck exposed TS5097 from the newly explicit Edge dependency and motivated the scoped configuration fix.
- Cargo and native backend build are not claimed: another agent holds the active shared native build claim. No Rust source was changed. Native acceptance is limited to the read-only configuration receipt above.

Source/deployment receipt files include `deployment-evidence.json`, `deployed-source-comparison.json`, `config-presence.json`, `native-config.json`, and full test logs. They contain metadata and code, not secret values or customer messages.

References: [Twilio request validation](https://www.twilio.com/docs/usage/security), [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams), [LiveKit Python token API](https://docs.livekit.io/reference/python/livekit/api/access_token.html).

## Final verification checkpoint

- Final app and node typechecks: **exit 0**. The broad compiler-setting experiment was reverted completely; `app/tsconfig.json` is clean and excluded from this commit.
- Final production Vite bundle: **exit 0**, 1m46s, with existing chunk-size warnings. Prebuild contracts passed. Outputs and caches are isolated on the task-owned D: path; no shared native executable was rebuilt.
- Fresh final cloud tests: **51 passed**. Fresh final focused Edge tests: **143 passed**. Frontend call/settings checks: **38 passed**. Release checks: **45 passed**.
- Broader frontend gate: **exit 1**, stopped after **3,142 passed / 1 failed**, 41 passed files / 1 failed file; unexecuted files remain unverified. Failure: `src/features/appearance/warmTheme.test.ts:353` expects the History source literal `selectedChatId`, while the current History lane uses its validated visible-chat state. No History or appearance files were edited by this task.
- Cargo remains blocked by the active N10 native-cache ownership claim. No Rust change or live-provider acceptance is claimed.
- Exact source hashes, reversible patch, scoped commit receipt, and release state are stored with the task's evidence and appended to `docs/AGENT_COORDINATION.md`.
