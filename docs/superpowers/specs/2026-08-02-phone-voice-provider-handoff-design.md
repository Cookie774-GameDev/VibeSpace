# Phone and Voice Provider Handoff Design

## Authority

Prompt 19 and the owner-approved billing/provider handoff, SHA-256
`2C17F905F9668108B0D7F6B70B265ED06E827264101FD95BD476D97A2DDD6653`.
The requested Downloads filename is absent, but the Downloads copy without
` (1)` and the preserved prompt copy with ` (1)` are byte-identical.

## Design

Keep the existing phone security controls and server-authoritative Call Anyone
workflow. Reframe the page as a readiness surface with distinct headings:
backend status, providers and privacy, outbound setup, inbound security, and
automation. Provider credentials remain in their existing shared secure stores;
this page reports connection state and routes users to Providers instead of
collecting duplicate secrets.

The configured phone-cloud URL is normalized and validated, then `/health` is
probed only on page load or explicit retry. Missing, invalid, unreachable, and
healthy states are distinct. The health response controls truthful transport
copy; no fallback URL is invented.

Call Anyone becomes a three-step wizard: recipient, call brief, server review.
Local validation prevents malformed E.164 numbers and incomplete briefs.
The server remains authoritative for the reservation. Before dialing, the
review shows the maximum shared-credit reservation, the equivalent maximum
company provider cost, and that unused credits are returned after settlement.

Shared-credit UI prefers the server's explicit included/used/remaining fields.
Legacy bucket reconstruction remains only as compatibility for older responses.

## Safety

No production deployment, provider mutation, call, or charge is performed.
Secrets are never rendered or copied into phone settings. Existing PIN,
allowlist, shell approval, consent, call approval, cancellation, opt-out, and
server budget enforcement remain intact.
