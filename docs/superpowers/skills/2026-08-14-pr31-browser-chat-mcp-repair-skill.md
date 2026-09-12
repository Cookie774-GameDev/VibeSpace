# Skill — PR31 Browser Chat + MCP Repair

## When to use

Use this skill when implementing, debugging, reviewing, or verifying PR #31 Browser Chat, its provider child WebView, persistent provider profiles, route isolation, and the account-scoped VibeSpace MCP relay.

## Target

```text
repository: Cookie774-GameDev/VibeSpace
pull request: 31
branch: agent/pr30-fixes-and-updates
```

Always refresh the actual PR head before writing.

## Scope rule

Read broadly. Write narrowly.

Primary writable scope:

```text
app/src/features/browser-chat/**
app/src/lib/bridge/** when directly required
app/src-tauri/src/browser_chat_surface.rs
Browser Chat-specific tests
one narrow global shell visibility seam
docs for this repair
```

Do not casually edit normal Chat, AI routing, RLM, token systems, Composer, Jarvis Voice, agents, drones, billing, Stripe, unrelated Supabase, themes, pets, Model Foundry, or installers.

## Start snapshot

Record:

- current branch and HEAD;
- current changed paths;
- existing Browser Chat child implementation;
- route/engine visibility behavior;
- provider profile path/label behavior;
- relay owner and number of subscribers/connections;
- existing Browser Chat and bridge tests.

## Reproduction discipline

For each issue:

1. reproduce deterministically;
2. record observed and expected behavior;
3. identify the owning component;
4. add a focused failing test when practical;
5. implement the smallest coherent repair;
6. run affected tests;
7. update the ledger;
8. commit the slice.

Do not write “probably a WebView race” without file/line and behavioral evidence.

## Route-escape invariant

```text
If the immediate app route is not Chat,
or the active chat engine is not Browser,
no provider child WebView may remain visible.
```

Verify at both the global shell authority and the provider-surface lifecycle. Test stale in-flight open completion after route departure.

## Child lifecycle checklist

- [ ] open once;
- [ ] update bounds;
- [ ] hide;
- [ ] show again;
- [ ] route away;
- [ ] route back;
- [ ] switch native/browser engine;
- [ ] switch provider;
- [ ] switch account;
- [ ] move and resize main window;
- [ ] maximize and restore;
- [ ] restart app;
- [ ] crash/error fallback;
- [ ] no duplicate child creation;
- [ ] no focus stealing on geometry-only updates.

## Profile checklist

- use a stable account/provider key;
- validate the key in native code;
- hash before filesystem/label use;
- preserve profile across hide/show/restart;
- isolate different VibeSpace accounts;
- never read or copy passwords/cookie databases;
- never claim system-browser profile reuse without official support and evidence.

## Navigation checklist

- HTTPS only;
- provider/identity origins only;
- deny unrelated origins;
- no direct provider access to Tauri commands;
- no injected credential automation;
- no DOM scraping of provider messages.

## Relay checklist

The relay must connect from the global app lifecycle while BrowserChatHub is absent. Verify:

- one singleton client;
- fresh ticket;
- heartbeat;
- bounded reconnect;
- no duplicate heartbeat/client;
- project change updates scope without a duplicate transport;
- sign-out revokes grants and closes authority;
- account change rejects stale work.

## Capability checklist

Snapshot the real advertised catalog, not UI toggles. Distinguish local support, permission, health, provider support, and provider authorization. A socket connection is not proof that the ChatGPT app is authorized. “Implemented” is not “verified.”

Do not expose write, shell, terminal, Git, Playwright, or downstream MCP tools until they route through existing authority with explicit scope, approval policy, cancellation, bounded results, and focused tests.

## Verification levels

1. Immediate: affected unit tests.
2. Slice: Browser Chat/provider/bridge integration tests.
3. Native: actual Tauri child WebView route/move/resize/restart test.
4. Checkpoint: TypeScript, frontend build, Rust check.
5. Final: full required repository gates and independent review.

Do not rerun the entire suite after every CSS or documentation edit, but do not skip final coherent gates.

## Severity

P0:

- provider overlays another route;
- cross-account profile/tool leak;
- provider receives native authority;
- native Chat breaks;
- data corruption or unbounded memory.

P1:

- Browser Chat unusable;
- profile repeatedly lost;
- relay route-bound or duplicated;
- false connected/tool status;
- reconnect broken.

P2:

- secondary polish, copy, or noncritical performance concerns.

Fix P0 and P1 before completion unless externally impossible.

## Truth labels

Use only:

```text
VERIFIED
IMPLEMENTED — NATIVE VERIFICATION REQUIRED
IMPLEMENTED — PROVIDER VERIFICATION REQUIRED
PROVIDER LIMITED
BLOCKED — OWNER ACTION
BLOCKED — ENVIRONMENT
NOT COMPLETE
```

TypeScript passing does not verify native no-overlay behavior. Mock relay success does not verify a real network recovery. Score only demonstrated evidence.
