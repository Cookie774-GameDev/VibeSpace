# Jarvis Call, Account, Admin, and Release Setup

This guide wires the production-facing pieces that are not purely local UI: Supabase auth/billing state, Stripe checkout links, the phone-jarvis cloud bridge, Jarvis Call entitlement gating, usage reporting, and signed silent updates.

## 1. App environment

Create `app/.env.local` from the root template:

```powershell
copy ..\.env.example .env.local
```

Required for cloud identity and account state:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

Required for in-app Jarvis Call:

```env
VITE_PHONE_JARVIS_CLOUD_URL=https://your-phone-jarvis-cloud.example.com
```

Optional Stripe checkout links. When present, the Plans and Account pages open the matching tier checkout:

```env
VITE_STRIPE_CHECKOUT_STARTER=
VITE_STRIPE_CHECKOUT_PRO=
VITE_STRIPE_CHECKOUT_ULTRA=
VITE_STRIPE_CHECKOUT_URL=
```

Optional admin build flags. Admin users resolve to effective Ultra in the app and can use Jarvis Call even before Stripe subscription sync is fully deployed:

```env
VITE_JARVIS_ADMIN=false
VITE_JARVIS_LOCAL_ADMIN=false
VITE_JARVIS_ADMIN_EMAILS=owner@example.com,admin@example.com
VITE_JARVIS_ADMIN_LOCAL_IDS=
```

Admin flags are a client-side owner/admin convenience for this desktop app. Do not treat them as a server-side authorization boundary; server write operations still need Supabase RLS, service-role checks, or webhook-verified billing state.

## 2. Supabase

Apply the Supabase migrations from the repo root:

```powershell
supabase link --project-ref <project-ref>
supabase db push
```

Server-side secrets for billing/webhooks belong in Supabase, not in the Vite client env:

```powershell
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
supabase secrets set STRIPE_PRICE_STARTER=price_...
supabase secrets set STRIPE_PRICE_PRO=price_...
supabase secrets set STRIPE_PRICE_ULTRA=price_...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

Expected app behavior after Supabase is configured:

- The top-left `J` avatar opens the Account page.
- The Account page shows local/cloud identity, plan, billing entry points, saved provider-key count, usage summary, and Jarvis Call status.
- Paid tiers update through Stripe/Supabase billing sync when those webhooks are deployed.
- Admin identities resolve to effective Ultra inside the client.

## 3. phone-jarvis cloud

The desktop app only needs `VITE_PHONE_JARVIS_CLOUD_URL`. The cloud service itself uses `phone-jarvis/cloud/.env.example`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...

TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+15551234567

LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_URL=wss://your-project.livekit.cloud

CARTESIA_API_KEY=...
GROQ_API_KEY=...
```

Minimum in-app call path:

- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and `LIVEKIT_URL` are configured on the cloud service.
- `VITE_PHONE_JARVIS_CLOUD_URL` points at the deployed HTTPS cloud origin.
- The user is on `starter`, `pro`, `ultra`, or is admin-enabled.

Twilio is required for PSTN inbound/outbound phone calls. LiveKit is required for the desktop green call button.

## 4. Entitlement gates

Jarvis Call availability:

| Plan | Voice minutes | In-app Jarvis Call |
| --- | ---: | --- |
| `free` | 0 | No |
| `starter` | 60 | Yes |
| `pro` | 300 | Yes |
| `ultra` | Unlimited | Yes |
| Admin effective Ultra | Unlimited | Yes |

All call entry points must enforce the same rules:

- If cloud call config is missing, show a Phone & Voice setup message.
- If the user is not entitled, show an upgrade/admin message.
- If a call is already active, allow hangup even if the user loses entitlement mid-call.

## 5. Usage reporting

The `/usage` slash command and Account page combine local and provider-backed data:

- Local monthly message/token totals are available for every provider because they come from Jarvis IndexedDB message metadata.
- OpenAI live organization usage/cost totals are fetched when the saved OpenAI key can access the usage and costs endpoints.
- OpenRouter live key usage, daily/monthly spend, limit, and remaining credit are fetched from the current-key endpoint when an OpenRouter key is linked.
- Other providers currently fall back to local totals until their hosted usage APIs are wired.

Verification:

```text
/usage
```

Expected result:

- With OpenAI usage-scope access: local totals plus live OpenAI requests/tokens/cost.
- With OpenRouter access: local totals plus live current-key spend and limit information.
- Without compatible provider access: local totals and a clear explanation that live hosted usage is unavailable for that provider.

## 6. Silent updates and release channel

Jarvis One uses the `Cookie774-GameDev/Jarivs-One` release channel. Production update behavior:

- Tauri updater checks signed GitHub Releases.
- Silent install uses the NSIS current-user installer under `%LOCALAPPDATA%`.
- The app warns at 1 hour, 30 minutes, and 5 minutes before auto-install.
- Users can choose Update Now, Snooze 1 Hour, or Update Later.

Windows release commands:

```powershell
npm run typecheck
npm --prefix app run build
npm run release:windows
npm run release:stage
```

Local silent install smoke test:

```powershell
$env:JARVIS_LOCAL="1"
$env:JARVIS_SILENT="1"
powershell -NoProfile -ExecutionPolicy Bypass -File install/install.ps1
```

Production signing requirements:

- Tauri updater signing key configured through `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Windows Authenticode code-signing certificate for installer and executable distribution. Configure `WINDOWS_CERT_BASE64` + `WINDOWS_CERT_PASSWORD`, or `WINDOWS_CERT_THUMBPRINT` when the cert is already installed. `scripts/sign-windows.ps1` is wired into Tauri's `bundle.windows.signCommand` during release builds so Authenticode signing happens before Tauri updater `.sig` generation.
- macOS Developer ID signing and notarization for `.app`/`.dmg`.
- Linux package signing or checksum publication for `.deb`, `.rpm`, and AppImage.

Windows Defender and SmartScreen reputation cannot be bypassed in application code. A new unsigned or low-reputation binary can still warn even when the app is technically correct. Production mitigation is trusted signing, consistent release identity, checksum publication, and distribution reputation over time.

If `install/install.ps1` reports that Application Control blocked the file, the installer did not get far enough for Jarvis arguments or silent flags to matter. Resolve that with Authenticode signing and endpoint policy allowlisting; do not treat it as an NSIS/Tauri updater bug.

## 7. Verification checklist

Run this before calling the production update complete:

- `npm --prefix app run typecheck` passes.
- `npm --prefix app run test` passes or unrelated failures are documented.
- `npm --prefix app run build` passes.
- `npm run release:windows` stages signed Windows artifacts.
- `releases/latest.json` points at `https://github.com/Cookie774-GameDev/Jarivs-One/releases/...`.
- Account page opens from the top-left `J` avatar.
- Admin env identity shows effective Ultra and Jarvis Call enabled.
- Free user sees Jarvis Call blocked with upgrade copy.
- Starter/pro/ultra user or admin can open the call modal when `VITE_PHONE_JARVIS_CLOUD_URL` is configured.
- `/usage` returns local totals, and OpenAI live usage when the linked OpenAI key has usage endpoint access.
- Tools page can create and run a workflow tool with multiple built-in action steps.
- Settings -> About shows the current version, current release notes, correct repo links, and update warning behavior.
