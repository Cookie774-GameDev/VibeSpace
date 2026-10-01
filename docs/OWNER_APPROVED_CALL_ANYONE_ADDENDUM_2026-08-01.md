# Owner-Approved Call Anyone Addendum

This addendum implements and narrows the owner-approved “JARVIS CALL ANYONE”
prompt without replacing or weakening the preserved billing/provider handoff.

## Authoritative boundaries

- Existing owner calls and in-app voice calls remain separate and available.
- Third-party calls use `owner`, `saved_contact`, `business`, or
  `one_time_number` destination classifications.
- A natural-language request prepares a server-authoritative draft. It never
  dials immediately.
- Every third-party call requires a stored approval snapshot covering the
  destination, purpose, disclosure, script, duration, allowed actions, and
  maximum credit reservation.
- Changing any approved material field invalidates approval.
- Telnyx is the intended production PSTN/SMS provider. Twilio remains only as
  isolated legacy compatibility until coordinated removal is verified.
- The long-running media loop belongs in the phone gateway, not a Supabase Edge
  Function.

## Safety and privacy

Jarvis introduces itself as a VibeSPACE AI assistant. It never impersonates the
user or silently discloses passwords, authentication codes, banking data,
payment cards, private files, sensitive medical information, or unapproved
personal details. Emergency, premium-rate, opted-out, blocked, bulk,
harassing, spoofed, and rapid-redial calls are denied server-side.

The first release may gather information, request availability, ask for a
basic quote, relay an approved non-sensitive message, or request a
reservation/appointment. It cannot autonomously complete purchases, payments,
contracts, loans, insurance agreements, prescriptions, legal commitments,
account recovery, password resets, authentication-code exchanges, emergency
calls, or financial transfers. Protected decisions pause for fresh live user
approval.

## Billing

All company-paid work uses the one shared monthly credit pool:

```text
reserve -> perform -> settle actual cost -> release remainder
```

One shared credit equals `$0.001` of actual provider cost. Concurrent
reservations serialize on server-owned rows and cannot create a negative
balance. BYOK/local operations do not consume company credits.

## External activation gate

No external deployment or provider mutation is complete until the target is
independently identified as the isolated VibeSPACE test environment. The
connected Supabase project inspected on 2026-08-02 contains AccessRevamp
tables, so it is explicitly excluded. The connected Stripe account reports
`JarvisOne`, but its VibeSPACE test identity has not yet been independently
proven. No live billing, live call, production migration, or unrelated account
mutation is authorized by this addendum.

## Local implementation evidence

The bounded local implementation includes migration `0036`, server-selected
Stripe line items, signed webhook reconciliation, authenticated call
prepare/approve/start/cancel/read/contact operations, server-calculated credit
reservations, idempotent Telnyx callbacks, durable recipient opt-out, and a
long-running Telnyx → Deepgram Flux → DeepSeek → Deepgram Aura media path.
The desktop shows a masked server-returned review, requires explicit approval,
polls active status, supports protected-action approve/decline and active-call
termination, and shows settled/returned credits.

Focused evidence at the final local snapshot:

- 77 Node-compatible billing, Stripe, calling, and webhook tests pass.
- 11 focused Call Anyone and preserved Phone & Voice component tests pass.
- 4 Python gateway contract tests and scoped Python compilation pass.
- App TypeScript and the production build pass.
- Scoped formatting, diff hygiene, added-line secret scanning, and the
  no-secret manual-file scan pass.

Runtime SQL, provider calls, Stripe Checkout lifecycle, and end-to-end calling
remain unclaimed until the correct isolated VibeSPACE test targets and provider
credentials are supplied and the controlled checklist is executed.
