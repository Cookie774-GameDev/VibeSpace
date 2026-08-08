# VibeSpace plugin connection compatibility

The machine-readable source of truth is
`app/src/features/plugins/compatibilityMatrix.ts`. It contains one record for
each of the 112 entries in `PLUGIN_CATALOG`, retains the entry’s official
developer-documentation URL, and records protocol, redirect method,
public/confidential-client constraints, scopes, high-risk scopes, refresh,
expiry, revocation, disconnect, review requirements, and the selected
connection class.

## Decision order

1. Official installed-app OAuth with system-browser PKCE when the provider
   explicitly supports a public desktop client.
2. Official OAuth through a confidential VibeSpace callback when a client
   secret, hosted callback, production review, or partnership is required.
3. Provider-owned MCP or connector authorization.
4. A community connector only after a separate source, license, dependency,
   secret-handling, network-boundary, and maintenance review.
5. Least-privilege manual credentials through the operating-system credential
   store.
6. Unsupported when none of the above can be established safely.

The matrix is deliberately conservative: a service having “OAuth” in its
documentation is not enough to label it one-click. The provider must allow the
actual desktop redirect/client model, and VibeSpace must have the required
production application registration.

## 112-entry closeout

All 112 catalog identifiers are represented exactly once in both the research
matrix and the connection-adapter registry. Each record now separates:

- the provider protocol that official documentation supports;
- the connection path actually shipped by this build;
- external registration, review, paid-plan, or partnership prerequisites;
- required and high-risk scopes;
- secure-storage, refresh, expiration, revocation, and disconnect behavior;
- whether a community implementation was selected and reviewed.

No community implementation is bundled by this pass, so every community-review
record is explicitly `not_applicable` instead of implying an unperformed
license or security audit. Likewise, no OAuth entry is marked
`oneClickReady` merely because the protocol exists. Until its production app
registration is configured and exercised, the UI retains its truthful guided
credential path. Unsupported entries remain visible with setup guidance rather
than a decorative Connect button.

The focused coverage tests assert that all 112 cards render, every identifier
has one matrix record and one adapter, each shipped manual path uses the secure
credential boundary, and every entry carries disconnect/revocation guidance.

## Shared security architecture

Native authorization opens the system browser, uses authorization code plus
S256 PKCE and a random state value, accepts only the registered exact callback,
times out and cancels safely, and passes the code to a trusted adapter. The
renderer never receives refresh or access tokens. Hosted-callback providers use
the same consent and state contract but complete the confidential exchange in
the VibeSpace backend. Provider grants live in platform secure credential
storage, while the renderer receives only normalized connection status and
non-sensitive account metadata.

Remote MCP uses one exact HTTPS Streamable HTTP endpoint. Newly discovered
tools start disabled and require explicit per-tool permission. Custom MCP
configuration cannot launch arbitrary local processes.

## Authoritative protocol references

- RFC 8252, OAuth 2.0 for Native Apps:
  https://datatracker.ietf.org/doc/html/rfc8252
- Google OAuth for desktop apps:
  https://developers.google.com/identity/protocols/oauth2/native-app
- Microsoft authorization code flow with PKCE:
  https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- MCP Streamable HTTP transport:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP authorization:
  https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization

Every provider-specific official reference remains in its matrix record. A
production registration, provider review, paid plan, or partnership is an
external prerequisite, not something this repository can silently fabricate.
