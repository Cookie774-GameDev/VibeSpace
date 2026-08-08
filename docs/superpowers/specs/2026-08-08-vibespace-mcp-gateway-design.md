# VibeSpace MCP Gateway Design

## Status

Approved by the owner on 2026-08-08. Public product name: **VibeSpace MCP**.

## Objective

Provide one ChatGPT app/MCP connection that discovers and routes the free
VibeSpace tools available on the user's connected desktop. The gateway must
not turn a provider page into an unrestricted local execution surface.

## Architecture

```text
ChatGPT
  -> HTTPS Streamable HTTP MCP + OAuth
  -> Cloudflare VibeSpace MCP Worker
  -> account-scoped SQLite Durable Object
  -> hibernatable outbound desktop WebSocket
  -> project grant + approval broker
  -> available local VibeSpace tool or MCP connector
```

The public MCP server exposes stable VibeSpace facade tools. A capability
catalog reports the concrete tools currently available for the authenticated
account, project grant, desktop session, and platform. The cloud service never
receives an absolute workspace root. It forwards only validated relative paths
and bounded typed arguments.

## Capability policy

- Catalog and capability checks are read-only.
- File reads and directory listings require an explicit session workspace
  grant and remain path-contained.
- File writes, terminal commands, browser navigation/click/type operations,
  and other mutations require the existing VibeSpace approval mechanism for
  each action or a narrowly scoped trusted rule created by the user.
- Tools not installed, connected, supported, or approved are reported as
  unavailable; the gateway never simulates success.
- Browser automation is presented only when the VibeSpace desktop has an
  approved browser host. It retains the browser runtime's project and action
  boundaries.
- Existing third-party MCP connections stay individually authenticated. The
  gateway may route only tools already approved in VibeSpace; it does not copy
  provider credentials into ChatGPT.

## Identity and isolation

Supabase OAuth identifies the VibeSpace account. Every desktop relay
registration is account-scoped, short-lived, replay-resistant, and bound to one
session grant. Every tool request checks the OAuth subject, account, project,
workspace grant, advertised schema, requested classification, and approval
receipt. The verified VibeSpace Supabase target is
`tipeobvisjqvpbzcpckh`; the AccessRevamp project
`vbkkimvedmklebghtkzs` is explicitly excluded.

## Deployment and connection

The public service is deployed to Cloudflare Workers Free with one
SQLite-backed Durable Object per Supabase account. WebSocket Hibernation keeps
an idle signed-in relay from consuming continuous CPU. The public HTTPS
endpoint is
`https://vibespace-mcp.combatonline02.workers.dev/mcp`. Supabase OAuth 2.1
provides PKCE, dynamic client registration, account identity, consent, refresh
rotation, and ES256-verifiable access tokens. ChatGPT requires the user to
approve the app's OAuth connection once; this consent cannot be bypassed.

The desktop never places its Supabase access token in a WebSocket URL. It
exchanges that token over HTTPS for a signed, one-use, 60-second relay ticket.
After the one-time ChatGPT consent, the desktop relay reconnects automatically
whenever Browser Chat has an active workspace grant.

## Failure behavior

- Missing OAuth, invalid tokens, wrong accounts, stale grants, replayed calls,
  oversized bodies, unadvertised tools, or absent approval fail closed.
- A disconnected desktop returns a stable unavailable response with no local
  path or secret leakage.
- A changed connector schema revokes its exposed tools until re-approved.
- External deployment or account-registration gates are reported truthfully
  and never replaced by a fake connected state.

## Verification

Focused tests cover branding, capability discovery, unavailable tools,
account-scoped Durable Object routing, hibernatable WebSockets, one-use relay
tickets, scope isolation, path containment, approval enforcement, replay and
size bounds, OAuth denial, MCP protocol negotiation, and Browser Chat
connection state. Deployment verification covers HTTPS health, OAuth metadata,
unauthenticated denial, MCP initialization, tool discovery, a read-only call,
and a denied mutation.
