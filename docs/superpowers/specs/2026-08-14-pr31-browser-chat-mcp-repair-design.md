# PR31 Browser Chat + VibeSpace MCP Design

## Purpose

This contract repairs Browser Chat without changing normal VibeSpace Chat, RLM/context, model routing, agents, voice, drones, billing, Stripe, or unrelated application infrastructure.

## Trust boundary

```text
VibeSpace-owned UI and local capabilities
                 │ controlled native/MCP interfaces
                 ▼
Provider-owned consumer web page
```

VibeSpace owns the Browser Chat workspace, local sessions and projects, child-WebView lifecycle, relay, capability registry, project grants, activity, and outputs. The provider owns the consumer UI, account, cookies, messages, model selection, authentication, and subscription behavior.

## Runtime topology

```text
VibeSpace native main window
├── React VibeSpace WebView
│   └── Browser Chat shell
│       ├── session rail
│       ├── project/status chrome
│       ├── provider host rectangle
│       └── VibeSpace-owned activity/status
└── provider child WebView
    └── ChatGPT / future allowlisted provider
```

The preferred path never creates a separate floating Browser Chat window.

## Visibility authority

A single invariant controls native provider visibility:

```text
visible =
  route == 'chat'
  && activeChatEngine == 'browser'
  && hostConnected
  && hostWidth > 0
  && hostHeight > 0
  && documentVisible
```

Two layers enforce the invariant:

1. `BrowserChatSurfaceGuard` reads the immediate app route/engine and hides all provider children before deferred route teardown.
2. `BrowserProviderSurface` applies the same immediate route/engine authority to each open/update operation and re-hides stale asynchronous opens.

The native controller serializes open and hide operations. Browser Chat child views are never allowed to outlive route/account authority merely because React teardown is delayed.

## Provider profile model

```ts
type ProviderProfile = {
  vibespaceAccountId: string;
  provider: 'chatgpt' | 'claude' | 'gemini';
  mode: 'vibespace-persistent-profile';
};
```

The renderer sends an opaque account-scoped profile key to the trusted native command. Native code validates and SHA-256 hashes the key. Only the digest is used in the WebView label and profile directory:

```text
<app-data>/browser-chat/<sha256(account-profile-key)>/<provider>/
```

The raw account ID is not placed in the filesystem path. Passwords and raw cookies are never read, exported, copied into React state, or stored in VibeSpace databases.

## Native lifecycle

All native operations are serialized. The native state tracks every child created during the app process:

```text
absent → creating → hidden/visible → hidden → disposed at app shutdown
```

Rules:

- create once per account/provider label when practical;
- update bounds only for real host geometry changes;
- hide every non-selected child before showing one;
- focus only on creation or profile/provider activation;
- hide all on route departure, engine switch, account switch, and shutdown;
- preserve profile data when hiding;
- never overlap create/destroy/open operations.

## Navigation policy

The child permits only:

- HTTPS provider-owned origins;
- static/content origins required by the provider;
- recognized OAuth/identity-provider origins required for supported sign-in;
- `about:blank` as a controlled browser bootstrap page.

HTTP, credentials in URLs, malformed URLs, and unrelated external origins are denied. Provider JavaScript receives no direct Tauri authority.

## Browser Chat shell

The VibeSpace shell owns:

- provider tabs;
- local Browser Chat session rail;
- selected project;
- provider page state;
- relay transport state;
- MCP authorization guidance;
- project grant state;
- installed connection health;
- local activity and outputs.

The actual provider page remains a real provider child WebView. VibeSpace does not recreate or scrape provider message DOM.

## Global relay ownership

```text
App global bridge lifecycle
└── Browser Chat relay supervisor
    ├── Supabase identity listener
    ├── one-use ticket request
    ├── singleton desktop WebSocket
    ├── heartbeat and bounded reconnect
    ├── account/project scope
    └── current project grant
```

`BrowserChatHub` is a status observer. The existing global bridge lifecycle remains transport owner, so leaving Browser Chat does not stop the relay.

## Capability truth

Availability is calculated from four independent facts:

```text
available = implementedLocally
         && enabledByPermission
         && healthyNow
         && supportedAndAuthorizedByProvider
```

The present secure Browser Chat gateway remains read-only unless additional adapters meet the full authority, approval, scope, cancellation, and test contract. UI or documentation must not imply write, terminal, Git, Playwright, or downstream MCP execution is available merely because the relay socket is connected.

## Account switch sequence

1. immediate global hide;
2. mark old provider operations stale;
3. revoke old project grant;
4. cancel old account relay work;
5. switch profile namespace;
6. establish new relay identity;
7. reopen only the new account/provider child when Browser Chat is still visible.

A stale result from the old account must not mutate the new account's project.

## Failure behavior

- Provider WebView failure: preserve profile, show truthful error, allow bounded retry/system-browser fallback.
- Relay failure: Browser Chat page remains usable; relay reports reconnecting/degraded/error truthfully.
- MCP authorization absent: show owner action; never fake authorization.
- Tool failure: fail only that tool; do not kill Browser Chat.
- Provider sign-out: show provider-managed sign-in state; keep local Browser Chat metadata.
- Untrusted navigation: cancel it.

## Regression firewall

Normal native Chat does not import provider runtime logic into its message pipeline. Shared code is limited to the shell visibility seam, auth/project identity, and existing global relay infrastructure. No native Chat, RLM, model, agent, voice, drone, billing, Stripe, or production Supabase behavior is changed by this design.
