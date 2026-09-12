# Browser Chat provider feasibility

Last reviewed: 2026-08-08

| Provider | Provider page                | Managed desktop surface                                                       | System-browser fallback         | Local tool/MCP bridge                                                                                                        |
| -------- | ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT  | `https://chatgpt.com/`       | Implemented with Windows WebView2; physical sign-in remains account-dependent | Windows default-browser handler | `VibeSpace MCP` is deployed with Supabase OAuth 2.1; one owner connection and a live signed-in read remain account-dependent |
| Claude   | `https://claude.ai/`         | Implemented; physical sign-in validation remains environment-dependent        | Implemented                     | Not configured; never inferred from page load                                                                                |
| Gemini   | `https://gemini.google.com/` | Implemented; physical sign-in validation remains environment-dependent        | Implemented                     | Provider-unsupported in this surface                                                                                         |

## Acceptance boundary

The managed surface uses only fixed registry URLs and independent local
profiles. It has no initialization script and receives no VibeSpace IPC
capability. These controls are verified in focused automated tests.

A real provider sign-in, challenge flow, subscription entitlement, or
provider-side policy can change outside VibeSpace. Those flows must be
validated against the installed desktop build and the user's own account;
unit tests cannot truthfully certify them. If a provider rejects embedding,
the supported result is the system-browser fallback—not scraping, cookie
transfer, automation, or security bypass.

No provider is labeled tool-connected merely because its page is available.
ChatGPT's separate MCP resource requires an OAuth token carrying both the
VibeSpace user subject and OAuth client ID, plus a live outbound desktop relay
for the same account. The first release exposes only capability discovery,
one opaque session workspace, bounded directory listing, and bounded text
reads. Absolute roots, credential files, detected secret content, write
operations, and terminal access are blocked. Writes and other mutation
bridges remain unavailable until their explicit approval, change-preview, and
recovery protocol is implemented. A browser login or MCP connection never
grants silent local mutation authority.

## Live VibeSpace MCP boundary

`https://vibespace-mcp.combatonline02.workers.dev/mcp` is deployed on the
verified VibeSpace Cloudflare account. The live boundary reports branded
protected-resource metadata, rejects anonymous MCP and relay requests with
HTTP 401, rejects an unapproved web origin with HTTP 403, and exposes the
Supabase authorization server with PKCE and dynamic registration. The consent
UI is live at `https://vibespaceos.com/oauth/consent/`.

ChatGPT still requires the standards-mandated one-time owner OAuth decision.
VibeSpace cannot silently install an app into a user's ChatGPT account or
bypass that consent. After consent, the desktop relay obtains a fresh one-use
ticket automatically whenever it connects or reconnects.

The Browser Chat **Connect VibeSpace MCP** action automates every safe step
before that decision. On demand, it verifies `/health`, the protected-resource
document, and the advertised authorization-server document; copies the
canonical HTTPS `/mcp` endpoint; and opens exactly
`https://chatgpt.com/plugins` through the operating system's default browser.
It does not open the provider page when discovery fails. Clipboard failure
does not block navigation because both setup URLs remain visible for manual
copying.

ChatGPT account-owner actions remain explicit: enable Developer mode, add the
private VibeSpace MCP connection, and approve OAuth access. Opening the Plugins
page is reported as **Waiting for owner approval**, never as an installed
plugin. The existing authenticated desktop relay remains the connection
authority and automatically resumes after a valid account grant is available.
