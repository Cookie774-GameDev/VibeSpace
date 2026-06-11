# VibeSpace 0.1.31 — Production Hardening & Ultra Galaxy

### Security

- **Billing lockdown** — subscription tier and quota columns are now server-managed; clients cannot self-upgrade. Stripe webhooks remain the only writer of billing state.
- **Database hardening** — pinned `search_path` on all public functions, indexed the subscription-events foreign key, and optimized RLS policies; Supabase advisors report no open database findings.
- **API keys out of URLs** — Gemini keys now travel in the `x-goog-api-key` header everywhere, and DevConsole logs redact sensitive query params.
- **Message rate limiting** — messages now use their own rate-limit window (and enforce it) instead of sharing the voice window.
- **CORS tightened** — legacy proxy edge function no longer answers `*`; only desktop app origins are allowed.
- **Env hygiene** — `.env.production` / `.env.development` are now git-ignored in every form.

### Fixed

- **Windows installer restored** — `install/install.ps1` is back, pointing at the VibeSpace repository with current `VibeSpace_*` asset names.
- **Jarvis launcher** — terminal launch and silent update now find installs under both `Programs\VibeSpace` and legacy `Jarvis One` paths.
- **macOS/Linux installer** — fallback download URLs match VibeSpace bundle names; `JARVIS_ARCH` override works.
- **Inbound SMS** — Twilio message webhook resolves users via `phone_settings` instead of a nonexistent column.
- **About page** — shows the real installed version and an up-to-date release timeline.
- **Plan sync** — the app pulls your real subscription tier from the server on sign-in.

### Improved

- **Ultra galaxy is back** — brighter nebula core, drifting color swirl, and two counter-rotating star layers on the Singularity card (GPU-friendly, honors reduced-motion).
- **Website** — vibespaceos.com landing updated with live install commands and an active download button.

### Assets

- **Windows x64 NSIS installer**: `VibeSpace-0.1.31-Windows-x64.exe`
- **Silent updater**: `latest.json` on GitHub Releases

### Install (one line)

```powershell
irm https://raw.githubusercontent.com/Cookie774-GameDev/VibeSpace/main/install/install.ps1 | iex
```
