# VibeSpace OpenCode Client and SSE Design

**Phase:** PR31 Phase 5
**Authority:** OpenCode-only harness master goal, sections 8, 9, and Phase 5
**Starting HEAD:** `44b0a19d`

## Outcome

VibeSpace talks to its already-owned, authenticated loopback OpenCode server
through one internal typed client. Product code consumes only
`VibeSpaceHarness` and normalized `HarnessEvent` values; OpenCode response and
event shapes do not escape the harness boundary.

## Boundaries

- Use the private connection produced by `HarnessRuntimeManager`.
- Accept only the runtime manager's validated `http://127.0.0.1:<port>/`
  connection and generate Basic auth internally.
- Never log, serialize into errors, or expose the authorization value.
- Do not start another OpenCode process or shell out per prompt.
- Do not switch the production AI router in this phase.
- Tests use injected fetch responses and streams, never a live OpenCode server.

## Client

`OpenCodeHttpClient` is a small generated-schema-shaped wrapper rather than a
new dependency. It owns:

- authenticated JSON requests with bounded error reads;
- health and provider/config discovery;
- session create/read/delete, children, messages, diffs;
- async prompts, commands, shell, and cancellation;
- permission responses;
- the `/event` SSE subscription;
- instance disposal.

All path segments are encoded. Redirects are rejected so credentials cannot
follow a redirect. Responses are size-bounded before JSON parsing. Success
payloads are structurally validated at the VibeSpace boundary.

## Stream lifecycle

`OpenCodeHarness.send()` opens the event request before submitting
`prompt_async`, preventing loss of a very fast first delta. The bridge:

1. parses UTF-8 SSE incrementally with bounded event and buffer sizes;
2. ignores comments, unrelated fields, malformed JSON, and unknown events;
3. filters each event to the requested OpenCode session;
4. normalizes accepted events to stable `HarnessEvent` values;
5. tracks only the latest 256 event identities/fingerprints for deduplication;
6. terminates on the session's `done` or `error` event;
7. reconnects a bounded number of times after transient stream interruption;
8. validates that the session still exists before reconnecting;
9. emits one sanitized error if recovery is exhausted or the server died.

No replay cursor is assumed because the current instance-wide `/event` stream
does not promise replay. Deduplication protects against repeated delivery at a
transport boundary, while authoritative session refresh prevents a blind
reconnect to a lost server generation.

## Cancellation and disposal

An input `AbortSignal`, explicit `cancel()`, iterator early return, or harness
disposal aborts the active stream. If a submitted turn is still active, the
harness makes one best-effort authenticated session-abort request. Disposal
also closes all active stream controllers and sends the scoped instance
dispose request; it never terminates a process itself.

## Verification

Focused Vitest coverage must prove:

- authenticated typed endpoint construction without credential leakage;
- streamed normalized deltas and completion;
- bounded reconnect and duplicate suppression;
- input cancellation and server abort;
- malformed event tolerance;
- cross-session filtering;
- terminal behavior after server death;
- bounded SSE parser behavior;
- TypeScript typecheck, scoped Prettier, diff hygiene, and credential scan.
