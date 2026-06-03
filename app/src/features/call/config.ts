/**
 * Cloud-URL-only config for the call feature.
 *
 * The `CallService` class statically imports `livekit-client` (~500KB).
 * We avoid pulling that into the boot chunk by gating the heavy import
 * behind a lazy dynamic `import()` (see `index.ts` async helpers).
 *
 * This file holds the cheap checks any boot-time UI needs — "does the
 * Call button light up, or does it stay grey with a config tooltip?" —
 * without touching LiveKit at all.
 */

/**
 * Read the phone-jarvis cloud URL from the build env. Trailing slash
 * stripped so callers can append `/livekit/token`, `/outbound/call`,
 * etc. without thinking about it.
 */
export function callCloudUrl(): string {
  const env = (import.meta.env as Record<string, string | undefined>)
    .VITE_PHONE_JARVIS_CLOUD_URL;
  return (env ?? '').replace(/\/$/, '');
}

/**
 * True iff the operator wired up the cloud URL at build time. The Call
 * button reads this synchronously to decide whether to render an active
 * green icon or a muted "not configured" tooltip — without paying the
 * cost of loading LiveKit just to look at a string.
 */
export function isCallConfigured(): boolean {
  return Boolean(callCloudUrl());
}
