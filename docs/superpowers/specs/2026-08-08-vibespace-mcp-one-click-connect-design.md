# VibeSpace MCP One-Click Connection Design

Date: 2026-08-08  
Status: Approved design

## Objective

Turn the existing **Connect VibeSpace MCP** action into the shortest reliable
setup flow that ChatGPT officially supports. VibeSpace automates endpoint
validation, endpoint copying, navigation, status presentation, and desktop
relay recovery. ChatGPT retains the explicit account-owner actions required to
enable Developer mode, create the private plugin connection, and approve
OAuth.

## Product boundary

The app must never inject into ChatGPT, inspect browser sessions, scrape
credentials, alter account settings, fabricate a connected state, or claim
that OAuth was approved before an authenticated request proves it. OpenAI's
documented developer flow requires explicit owner interaction for Developer
mode, plugin creation, and OAuth consent.

This release therefore provides one VibeSpace action followed by the smallest
honest ChatGPT handoff:

1. VibeSpace validates the configured public MCP endpoint.
2. VibeSpace verifies protected-resource and authorization-server discovery.
3. VibeSpace copies the exact `/mcp` URL.
4. VibeSpace opens `https://chatgpt.com/plugins` through the operating system's
   default browser.
5. The user performs ChatGPT's required Developer-mode, add-plugin, and OAuth
   decisions.
6. VibeSpace automatically reconnects its existing desktop relay after a valid
   signed-in session and workspace grant are available.

## Architecture

### Connection preflight

A small pure helper derives the canonical ChatGPT Plugins URL and validates the
configured MCP URL. The connection action performs bounded `GET` requests to:

- `/health`;
- `/.well-known/oauth-protected-resource`;
- the advertised authorization server's
  `/.well-known/oauth-authorization-server`.

Every request has a short timeout and cancellation. The preflight accepts only
HTTPS, the exact configured MCP resource, a non-empty authorization-server
list, and successful metadata responses. It never sends a Supabase token or
local workspace data.

### Browser handoff

After a successful preflight, VibeSpace writes the canonical MCP URL to the
clipboard and opens `https://chatgpt.com/plugins` with the existing safe
system-browser bridge. The action does not open generic ChatGPT and does not
hardcode Chrome, Edge, or another browser executable.

If clipboard access is unavailable, navigation still proceeds and the endpoint
remains visible with an explicit copy control. If navigation fails, the
endpoint remains visible and the error explains that no account setting was
changed.

### Connection state

The existing Browser Chat relay remains the authority for desktop connectivity:

- `Setup required`: no healthy relay connection;
- `Opening ChatGPT Plugins`: preflight succeeded and handoff started;
- `Waiting for owner approval`: the browser handoff completed but no
  authenticated relay connection is present;
- `Desktop connected`: the authenticated relay is live.

No state claims that the ChatGPT plugin itself is installed merely because a
browser page opened. Existing automatic one-use ticket issuance and reconnect
behavior continue unchanged after consent.

### User interface

The current Browser Chat layout remains intact. The VibeSpace MCP card gains:

- a connection-progress label;
- the exact endpoint with a copy fallback;
- a compact three-step checklist:
  `Enable Developer mode`, `Add VibeSpace MCP`, `Approve access`;
- one primary **Connect VibeSpace MCP** button;
- truthful retry and recovery messages.

The checklist is informational, not a fabricated completion tracker. Only
preflight, browser handoff, and relay connectivity are machine-verifiable.

## Failure handling

- Missing or invalid endpoint: fail before clipboard or browser side effects.
- Health or discovery failure: show one actionable retry message and do not
  open ChatGPT.
- Clipboard failure: keep going and expose the visible copy fallback.
- Browser-open failure: retain the endpoint and provide the direct Plugins URL.
- OAuth denial or cancellation: remain in `Waiting for owner approval`; do not
  loop, spam browser windows, or weaken authentication.
- Relay reconnect failure: preserve the workspace grant, use the existing
  bounded retry behavior, and expose the real disconnected state.

## Performance and privacy

Preflight runs only when the user presses Connect or Retry. There is no new
background poller, dependency, browser automation process, or persistent
telemetry. Responses are bounded and discarded after validation. Local paths,
tokens, browser data, and credentials never enter the preflight request or UI.

## Verification

Focused tests must prove:

1. The action opens exactly `https://chatgpt.com/plugins`.
2. Endpoint copying uses the canonical HTTPS `/mcp` URL.
3. Browser navigation never occurs when health or OAuth discovery fails.
4. Clipboard failure does not block the safe browser handoff.
5. Invalid metadata, timeout, and cancellation fail safely.
6. The UI never labels the plugin installed without authenticated evidence.
7. Existing project grants and automatic relay reconnect behavior remain
   intact.
8. The operating-system default browser bridge is used without a hardcoded
   browser family.

Run the focused Browser Chat tests, TypeScript, Prettier, diff hygiene, and the
staged added-line secret scan. Broader tests are required only if a focused
failure proves a wider boundary changed.

## Rollback

The change is isolated to the Browser Chat MCP connection helper, card, focused
tests, and documentation. Reverting its focused commit restores the prior
copy-and-open behavior without changing the deployed Worker, Supabase OAuth,
workspace grants, or relay protocol.
