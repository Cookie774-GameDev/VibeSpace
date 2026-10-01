# Browser Chat

Browser Chat is a second chat mode alongside native VibeSpace Chat. Its product
contract is deliberately simple: **VibeSpace owns the surrounding desktop UI and
local tools; ChatGPT owns the actual ChatGPT webpage, account session, chat UI,
subscription, and model responses.**

On Windows desktop, VibeSpace displays the real provider site in an isolated
WebView2 surface inside the Browser Chat content region. A system-browser
fallback is always available. The web build uses the system browser instead of
pretending it can provide the same managed desktop surface.

## The intended ChatGPT flow

1. The user signs in to VibeSpace. This identifies the VibeSpace account used by
   the MCP gateway and desktop relay.
2. VibeSpace opens the real `https://chatgpt.com/` provider page in the isolated
   Browser Chat surface. ChatGPT owns its own sign-in flow and cookies.
3. While VibeSpace is open and the VibeSpace account is signed in, the desktop
   relay starts automatically and keeps an outbound authenticated connection to
   the VibeSpace MCP gateway. It may be connected with zero local project tools.
4. The user connects the VibeSpace custom ChatGPT app/MCP once through ChatGPT's
   supported plugin/developer-mode flow and completes the explicit OAuth grant.
   VibeSpace may open the setup page and copy the canonical endpoint, but it
   must never claim that it silently installed or approved the ChatGPT-side app.
5. If the user explicitly grants one local VibeSpace project for the current
   app session, the MCP bridge can expose the bounded read tools for that
   project. Revoking the grant immediately removes local project access.
6. Browser Chat keeps the provider page, VibeSpace account, ChatGPT app grant,
   desktop relay, and local project grant as separate states. One state being
   healthy must never imply that the others are healthy.

## What an MCP is in this system

An MCP is **not a GitHub repository**. A repository can contain the source code
for an MCP server or tool adapter, but ChatGPT connects to a running MCP server
that exposes typed tools/resources over the Model Context Protocol.

For example, Playwright can be used behind a VibeSpace browser-control tool, and
file or terminal code can be implemented behind VibeSpace MCP tools. Merely
installing or cloning those repositories does not make the tools available to
ChatGPT. Each capability needs a real running adapter, authorization boundary,
and a registered MCP tool.

## Current VibeSpace MCP capabilities

The current production bridge is intentionally read-only:

- `vibespace.get_capabilities`
- `vibespace.list_workspaces`
- `vibespace.list_directory`
- `vibespace.read_file`

The on-device relay behind those tools exposes only `fs.list` and `fs.read` for
an explicitly approved project. Absolute roots, credential files, detected
secret content, and paths outside the grant are denied on-device.

The following catalog concepts exist but are **not implemented in the current
ChatGPT MCP bridge** and must not be presented as working:

- file writes
- Playwright/browser mutation
- terminal command execution
- arbitrary downstream MCP mutation

As of 2026-08-10, OpenAI's ChatGPT Pro custom-MCP path is limited to read/fetch
permissions; full MCP write/modify support is currently a Business and
Enterprise/Edu capability. VibeSpace therefore must not try to turn a consumer
ChatGPT web subscription into an unofficial terminal/write API.

VibeSpace can still show and run its own local terminal alongside Browser Chat.
That terminal is a VibeSpace-native surface. A future ChatGPT-triggered terminal
or write tool must use a supported full-MCP plan and the VibeSpace approval
broker described below.

## Future write / browser / terminal contract

When the platform and account are eligible for full MCP, mutations may be added
only through explicit VibeSpace tools with a visible approval lifecycle. A
sensitive request must carry the exact action, workspace, arguments, expected
side effects, and bounded timeout. VibeSpace shows that preview to the user,
issues a one-use approval, executes only the approved action, and returns the
result. There is no ambient shell, no hidden browser control, and no automatic
approval merely because the ChatGPT app is connected.

Playwright/browser tools must control a VibeSpace-owned approved browser session.
They must not inject into, scrape, or programmatically operate the consumer
ChatGPT provider page as a substitute for an API.

## Trust boundary

- The provider owns its page, authentication, subscription, limits, and data.
- Each provider receives a separate local browser profile.
- Provider webviews are not granted VibeSpace Tauri IPC capabilities.
- VibeSpace does not inspect the provider DOM, intercept network traffic,
  capture cookies, scrape conversations, or programmatically extract replies.
- The provider webview never receives VibeSpace filesystem, terminal, Git,
  browser-control, credential, or MCP authority.
- The VibeSpace MCP gateway authenticates the VibeSpace account separately from
  the provider browser session.
- Page status and local-tool/MCP bridge status are always separate.

## Browser Chat status model

The UI should show these states independently rather than one generic
"connected" badge:

1. **ChatGPT page** — opening / ready / error / system-browser fallback.
2. **VibeSpace account** — signed in / signed out.
3. **Desktop relay** — connecting / connected / reconnecting / error / offline.
4. **ChatGPT MCP authorization** — setup required / waiting for user approval /
   externally authorized or unknown. VibeSpace must not infer authorization from
   the provider page.
5. **Local project grant** — none / read-only approved / revoked.
6. **Mutation capability** — unsupported / approval required / approved for one
   action / executing / settled.

A loaded ChatGPT page does not mean MCP is connected. A connected desktop relay
does not mean ChatGPT has authorized the MCP. A ChatGPT MCP grant does not grant
local project access. A project read grant does not grant writes or terminal
execution.

## Native surface reliability

The native Browser Chat open command is completion-sensitive. It may report
`ready` only after the WebView2 surface was actually created, positioned, shown,
and focused. WebView creation/show errors must propagate back to the renderer so
the Browser Chat hub can display the real failure and system-browser fallback.
Geometry updates are serialized so a later resize cannot be falsely acknowledged
while an earlier native open is still in flight.

## Current provider behavior

- Supported provider pages: ChatGPT, Claude, and Gemini.
- Desktop: a provider-owned WebView2 surface is aligned to the Browser Chat
  content region and remains scoped to the VibeSpace experience.
- Web build: the provider opens in the system browser.
- Failure: the hub preserves the provider account and offers the system-browser
  fallback with the actual native error.

Tool bridges remain disabled unless a separately verified, provider-supported
integration is configured. VibeSpace never simulates a bridge or converts a
consumer web subscription into an API.
