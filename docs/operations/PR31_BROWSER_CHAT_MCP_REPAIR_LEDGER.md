# PR31 Browser Chat + MCP Repair Ledger

## Run metadata

- Repository: `Cookie774-GameDev/VibeSpace`
- Pull request: `#31`
- Branch: `agent/pr30-fixes-and-updates`
- Start HEAD: `7bfb98866ba406155b323a796ea57e7a28778302`
- First implementation commit: `2f514b56d221563bbeef8581ea417f5915166561`
- Scope: Browser Chat child WebView, route isolation, account-scoped profile, navigation security, focused tests, and documentation
- Protected systems: normal Chat, RLM, models, agents, voice, drones, billing, Stripe, production Supabase, installers

## Baseline findings

### Finding 1 — route visibility relied on component lifecycle

Observed:

- `BrowserProviderSurface` hid on DOM invisibility/unmount, but did not read the immediate app route or active chat engine.
- `PageRouter` intentionally uses a deferred route value, so native provider visibility could outlive the authoritative route for a render window.
- A pending native open could resolve while the old Browser Chat React tree remained mounted.

Expected:

- Immediate route/engine authority must hide all provider child WebViews before another route becomes interactive.

Root cause:

- Native child visibility was derived from host geometry and React teardown rather than the non-deferred route plus Browser/native engine state.

### Finding 2 — provider profile was not VibeSpace-account-scoped

Observed:

- Native profile directory was `browser-chat/<provider>`.
- Native WebView labels were static per provider.

Expected:

- Stable, persistent profile per VibeSpace account/provider with no raw account ID in native paths.

Root cause:

- The native open command did not receive an account profile key, and the native profile manager had no account namespace.

### Finding 3 — provider navigation lacked an explicit allowlist

Observed:

- Provider start URLs were registry-owned, but subsequent top-level navigation had no native provider/identity-origin policy.

Expected:

- HTTPS provider and recognized identity origins only; unrelated origins denied.

### Finding 4 — relay ownership already global

Observed:

- `useBridgeLifecycle` mounts the Browser Chat relay globally.
- Existing tests prove the global subscriber keeps one relay alive while a route observer unmounts.

Decision:

- Do not create a second relay manager. Preserve the existing singleton supervisor.

## Slice 1 — Immediate route and engine visibility authority

Goal:

- Ensure a provider child can be visible only on the Chat route with the Browser engine selected.

Implementation:

- Added `BrowserChatSurfaceGuard` at the application shell.
- The guard reads the immediate UI route, active-chat engine, and VibeSpace account.
- It hides all provider children on route departure, native-engine switch, account switch, and shell teardown.
- Detached Workbench windows do not receive the main-only Browser Chat guard.
- `BrowserProviderSurface` independently reads the same authority and re-hides stale in-flight opens.
- Normal hide calls are deduplicated; a stale completed open forces a final hide.

Focused tests:

- route/engine visibility derivation;
- immediate route-leave hide;
- native-engine hide;
- account-change hide;
- stale-open re-hide;
- geometry burst coalescing.

Status: `IMPLEMENTED — NATIVE VERIFICATION REQUIRED`

## Slice 2 — Account-scoped persistent provider profile

Goal:

- Isolate provider sessions by VibeSpace account while retaining persistent sign-in for the same account/provider.

Implementation:

- Renderer passes a validated account-scoped profile key only through the trusted native command.
- Native code validates and SHA-256 hashes the key.
- The digest namespaces both child labels and profile directories.
- Raw account IDs are not used in filesystem paths.
- Account changes hide the old child before opening the new profile.

Focused tests:

- account profile argument reaches native command;
- different accounts produce different stable native labels/digests;
- malformed keys rejected;
- account switch hides and reopens with a new profile key.

Status: `IMPLEMENTED — NATIVE VERIFICATION REQUIRED`

## Slice 3 — Serialized native operations and navigation allowlist

Goal:

- Prevent overlapping native operations and untrusted provider-WebView navigation.

Implementation:

- Provider controller serializes managed open and hide operations.
- Native state tracks dynamically labeled account/provider children.
- Native navigation permits HTTPS provider/static/recognized identity origins and denies unrelated/HTTP origins.
- Main-webview caller enforcement and no-provider-Tauri-authority boundary remain intact.

Focused tests:

- concurrent opens create one child;
- hide waits behind an in-flight open;
- provider and OAuth origins accepted;
- attacker and HTTP origins rejected.

Status: `IMPLEMENTED — NATIVE VERIFICATION REQUIRED`

## Files changed

- `app/src/components/layout/AppShell.tsx`
- `app/src/features/browser-chat/BrowserChatSurfaceGuard.tsx`
- `app/src/features/browser-chat/BrowserChatSurfaceGuard.test.tsx`
- `app/src/features/browser-chat/BrowserProviderSurface.tsx`
- `app/src/features/browser-chat/BrowserProviderSurface.test.tsx`
- `app/src/features/browser-chat/providerSurface.ts`
- `app/src/features/browser-chat/providerSurface.test.ts`
- `app/src-tauri/src/browser_chat_surface.rs`
- Browser Chat repair prompt/design/skill/ledger Markdown files

## Verification evidence

- TypeScript/TSX syntax transpilation for all seven changed TypeScript files: PASS in the implementation workspace.
- GitHub CI run `31852357080`: queued/pending when this ledger was written.
- GitHub AI-boundary run `31852357066`: queued when this ledger was written.
- Repository TypeScript typecheck: pending GitHub CI.
- Browser Chat focused Vitest: pending GitHub CI.
- Frontend production build: pending GitHub CI.
- Rust `cargo check`: pending GitHub CI.
- Actual Tauri Windows route/move/resize/restart smoke: `BLOCKED — ENVIRONMENT` in this connector session; required before `VERIFIED` no-overlay status.
- Provider sign-in persistence/OAuth: `IMPLEMENTED — PROVIDER VERIFICATION REQUIRED`.

## Protected-system review

- No normal Chat file changed.
- No RLM/model/agent/voice/drone/billing/Stripe/Supabase/installer implementation changed.
- Shared edit is limited to mounting a null-rendering Browser Chat visibility guard in `AppShell`.
- Existing global relay ownership remains unchanged; no duplicate relay manager was added.

## Rollback

Revert the Browser Chat route/profile security commits. Existing provider profile directories remain local data and are not deleted automatically.
