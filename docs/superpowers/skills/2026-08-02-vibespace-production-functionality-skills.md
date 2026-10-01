# VibeSpace Production Functionality Agent Skills

**Goal:** `VS-PR31-PRODUCTION-FUNCTIONALITY-20260802`

This file defines the execution skills and decision rules required for the goal. It supplements `AGENTS.md`; it does not replace repository guardrails.

## Skill 1 — Fast reconnaissance without speculative rewrites

- Locate the canonical store/service before editing a surface.
- Trace one real event from UI control to backend/native command and back.
- Identify dead controls, duplicate state, stale migrations, and browser/native boundaries.
- Record exact reproduction steps and current evidence.
- Prefer repairing the existing domain boundary over introducing a second subsystem.

## Skill 2 — Truthful capability modeling

For every state shown to a user, answer:

1. What evidence proves it?
2. When was that evidence observed?
3. Is it browser, desktop, local, hosted, API, OAuth, CLI, or cached?
4. Can it become stale?
5. What should happen when evidence is missing?

Unknown remains unknown. `Selected` is not `available`. `Installed` is not `ready`. `Executable found` is not `authenticated`. `Connected` is not `usage available`.

## Skill 3 — Provider adapter integration

- Normalize providers through the shared family/mode contract.
- Keep secrets behind credential handles.
- Emit sanitized connection and request-lifecycle events.
- Implement optional usage adapters independently from request adapters.
- Respect official API rate limits and authentication requirements.
- Report quota unavailable instead of estimating.
- Isolate adapter failures with timeouts, abort signals, and circuit/backoff behavior.

## Skill 4 — Secure OAuth implementation

- Use official authorization endpoints and documented scopes.
- Use PKCE where supported; always validate state and callback origin/path.
- Keep token exchange and refresh in the native/backend security boundary where required.
- Store tokens in the existing secure credential layer.
- Redact callbacks and errors.
- Test cancel, replay, expiry, invalid state, duplicate callback, and disconnect.

## Skill 5 — Tauri multi-window lifecycle

- Create exactly one taskbar-usage window.
- Use stable labels and idempotent create/show/hide/close operations.
- Validate stored geometry against current monitor work areas.
- Handle taskbar/Dock/panel edge, auto-hide, display changes, DPI, and restart.
- Do not inject into native taskbars or manipulate unrelated OS UI.
- Keep browser preview functional with an explicit desktop-only state.

## Skill 6 — Efficient live data

- Prefer event-driven local activity.
- Use one five-second reconciliation clock while the usage module is enabled.
- Refresh remote data on provider-safe intervals, not blindly every tick.
- Cache and deduplicate concurrent refreshes.
- Add jitter and exponential backoff.
- Stop all work when disabled.
- Skip stale visual ticks under load instead of queuing them.

## Skill 7 — Microphone and voice state machines

- Centralize media-device acquisition and release.
- Make click-to-talk and hands-free ownership explicit.
- Separate wake listening, utterance capture, transcription, finalization, playback, and interruption states.
- Abort stale sessions when settings, assistant identity, route, or device changes.
- Resolve voice eligibility and fallback before playback.
- Never present a fallback voice as the selected premium voice.

## Skill 8 — Robust file/model lifecycle

- Calculate disk requirements using remaining download bytes, temporary space, extraction, and rollback needs.
- Use resumable downloads where supported.
- Verify checksums/manifests before promotion.
- Keep operations cancelable and recoverable.
- Make repair and update idempotent.
- Do not delete user data outside the owned model directory.
- Report reclaimed space only after confirmed deletion.

## Skill 9 — Local runtime streaming

- Check process/endpoint health and exact model existence.
- Stream incrementally through a normalized protocol.
- Handle malformed chunks and disconnects.
- Enforce first-token and idle timeouts.
- Propagate cancellation to the underlying request/process.
- Never hide an unavailable selected model by routing elsewhere.

## Skill 10 — Hardware inventory

- Use native OS APIs/commands already approved by the Tauri boundary.
- Return optional typed values and source/evidence.
- Support multiple GPUs/adapters.
- Treat dedicated and shared memory separately.
- Cache stable inventory but refresh free memory/storage when needed.
- Test parsers against fixtures and unexpected/partial output.

## Skill 11 — Concise product copy

- Lead with status and action.
- Use one short supporting sentence.
- Move technical detail into a disclosure.
- Remove repeated claims and marketing filler.
- Preserve terms users need to make decisions: provider, connection mode, local/hosted, credits, size, hardware fit, and privacy.

## Skill 12 — Theme-safe UI refinement

- Use semantic tokens only.
- Verify every affected appearance, including reduced motion and forced colors.
- Do not duplicate entire component trees per theme.
- Keep layout stable as live values change.
- Use tabular numerals for counters and fixed metric columns.

## Skill 13 — Regression-first bug fixing

For each reported bug:

1. Reproduce it.
2. Add the smallest failing regression test at the right layer.
3. Fix the root cause.
4. Run the focused test.
5. Visualize the real surface.
6. Run the coherent subsystem suite.
7. Record exact evidence.

Do not replace a reproducible bug with an unverified broad refactor.

## Skill 14 — Browser and native verification

Browser control is required for web-supported behavior and visual inspection. Native Tauri testing is required for taskbar windows, keychain, CLI, microphone/global behavior, local models, hardware inventory, OAuth callback integration, and Ollama.

Use screenshots only as evidence of visual state, never as proof that a backend action succeeded. Pair screenshots with logs, state assertions, files, API responses, or test results.

## Skill 15 — Performance triage

Use measurements before and after the bounded quick pass. Prioritize:

- leaked timers/listeners/subscriptions;
- full-store rerenders;
- duplicate provider requests;
- heavy startup imports;
- hidden-window work;
- large unvirtualized lists;
- repeated graph layout;
- blocking file/model operations.

Avoid speculative micro-optimization and do not weaken correctness.

## Skill 16 — Safe multi-agent coordination

- Assign slices by independent domain boundaries.
- Lock files before edits.
- Keep shared contracts owned by one agent.
- Require each agent to log intent, paths, tests, and result.
- Integrate frequently and resolve contract mismatches centrally.
- Do not allow parallel agents to create competing provider, credential, microphone, or appearance stores.

## Mandatory stop conditions

Stop the affected slice and report a block when:

- a required external OAuth client/provider account is unavailable;
- native behavior cannot be tested in the available environment;
- a requested provider has no supported usage/quota API;
- a change would require exposing a secret to the frontend;
- a fix would weaken auth, billing, updater, terminal, or external-action security;
- the source-of-truth contract cannot be determined without risking data migration.

A block is not permission to fabricate success. Complete all unblocked work and document the exact dependency.
