# Persistent VibeSpace MCP and Chat Welcome Art Design

Date: 2026-08-10
Status: Approved by the owner

## Goals

1. Keep the authenticated desktop side of VibeSpace MCP connected for the
   entire authenticated VibeSpace app lifetime, independent of the current
   route or chat engine.
2. Recover safely from failed registration, half-open sockets, token refresh,
   network interruption, sleep/wake, and transient Worker failure.
3. Keep ChatGPT's installation state truthful. A healthy Worker or desktop
   relay must never be presented as proof that the external ChatGPT app is
   installed.
4. Preserve the existing Default, MonoChrome, and Jarvis Core chat-welcome
   compositions while regenerating their backgrounds to match the exact chat
   canvas colors. Warm remains unchanged.

## Current failures

- `useBrowserChatRelay` is owned by `BrowserChatHub`. Leaving Browser Chat can
  unmount the only relay owner.
- `BridgeClient` has no registration deadline or server heartbeat
  acknowledgement. An open but non-responsive socket can remain stuck.
- A token or grant reconnect closes and immediately opens a socket while the
  old socket can still schedule another reconnect.
- Reconnect attempt state is reset as soon as registration succeeds, so rapid
  connect/drop loops never develop useful backoff.
- The setup UI opens a legacy Plugins URL and cannot distinguish Worker
  health, desktop-relay health, and ChatGPT app installation.
- The three dark welcome images have outer pixels that do not match their
  theme canvases, leaving visible rectangular halos despite the mask.

## Runtime design

`VibeSpaceMcpRuntimeHost` mounts inside the stable authenticated runtime
boundary. It reads the current cloud account/project scope and owns exactly one
`useBrowserChatRelay` lifecycle. A tiny external status store publishes the
desktop relay state to `BrowserChatHub`; the page no longer creates a second
connection.

`BridgeClient` uses a monotonically increasing connection generation. Every
socket handler, registration timeout, heartbeat timer, and reconnect timer is
generation-bound. Stale handlers cannot publish state or schedule work.

Registration must complete within a bounded deadline. Once registered, the
client sends periodic heartbeats and requires a Worker acknowledgement within
a bounded liveness window. Missing acknowledgement closes only the owned
socket and enters reconnect.

Reconnect uses one timer, capped exponential backoff, and no overlapping
socket. Backoff resets only after a genuinely stable connection period.
Browser `online` and document visibility recovery may request an immediate
generation-safe retry, but neither creates a second owner.

The Worker responds to a registered desktop heartbeat with a minimal
`heartbeat_ack` frame. It includes no account, path, token, or user content.

## Connection presentation

The MCP preflight continues to verify the Worker and complete OAuth discovery.
It additionally verifies the authorization server supports authorization-code
PKCE, refresh tokens, and `offline_access`.

The UI presents three independent facts:

- public gateway readiness;
- desktop relay state;
- ChatGPT app setup is external and requires one-time Developer Mode creation
  and OAuth approval.

No browser handoff or relay state may label the ChatGPT app installed.

## Artwork design

The current 512×512 welcome images are edit targets:

- Default: open notebook, coffee, and paperclip; outer background `#2a2018`.
- MonoChrome: paper organizer, cup, and pencil; outer background `#0a0b0f`.
- Jarvis Core: closed smart notebook, cup, and pen; outer background `#060911`.

The subject, framing, object count, relative placement, lighting direction, and
no-text/no-logo contract remain fixed. Each regenerated image must transition
smoothly into a perfectly uniform target color over the outer edge region.
The existing radial mask remains as a secondary blend, not as compensation for
a mismatched raster rectangle.

## Security and privacy

- The relay remains read-only and advertises no local tools without an
  explicit session grant.
- Tokens remain in HTTPS headers and never enter WebSocket URLs.
- No ChatGPT DOM access, credential scraping, silent installation, permission
  escalation, write tools, or shell tools.
- Heartbeat and status frames contain no user content.

## Verification

- RED/GREEN tests for app-lifetime ownership, route independence, register
  timeout, half-open recovery, stale-generation suppression, single reconnect,
  stable-period backoff reset, and heartbeat acknowledgement.
- Existing account/grant/replay/path/secret protections remain green.
- MCP preflight rejects authorization metadata without long-lived OAuth
  support.
- Worker tests prove heartbeat acknowledgement only after registration.
- Image checks prove 512×512 WebP output, bounded size, and theme-matched outer
  edge/corner colors.
- Run TypeScript, focused app/Worker Vitest, production build, Worker dry-run,
  formatting/diff/credential checks, then deploy only the verified Worker and
  recheck live health/discovery.

## Rollback

Revert the runtime-host/status-store slice, then BridgeClient/Worker heartbeat
slice, then the three artwork assets independently. Worker rollback uses the
previous deployed version. Warm artwork and all unrelated dirty work remain
untouched.
