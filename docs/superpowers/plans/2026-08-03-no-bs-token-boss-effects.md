# NO BS and Token Boss Effects Implementation Plan

**Goal:** Reproduce the owner-supplied NO BS and 15-provider Token Boss effects inside their
existing VibeSpace surfaces without changing underlying behavior.

**Architecture:** Keep prompt/model state in the existing stores. Add isolated cinematic
components and a small chat-scoped event controller. The command handler resolves the live model
selection and requests playback; the Chat route owns the single canvas host.

**Tech Stack:** React 18, TypeScript, Vitest, CSS animations, Canvas 2D, Web Audio.

### Task 1: Lock and contracts

- Record exact ownership in the coordination ledger.
- Add failing tests for provider resolution and `/token boss` discovery/aliasing.
- Run the focused tests and confirm they fail because the new contracts are absent.

### Task 2: Provider resolution and command dispatch

- Implement the immutable 15-provider catalog and pure resolver.
- Add the one visible slash command and hidden `/token final boss` alias.
- Consume the command in Composer using the authoritative current chat selection.
- Dispatch a chat-scoped cinematic request without sending a message or mutating usage.
- Run provider, typeahead, and Composer tests.

### Task 3: Token Boss cinematic

- Add a singleton chat-scoped host and deterministic Canvas 2D renderer.
- Port the reference timing, token marks/colors, boss/hammer staging, fracture effects, meter,
  letterbox, and user-gesture audio.
- Add reduced motion, Escape skip, visibility/unmount cleanup, resize/DPR handling, focus restore,
  and accessible status.
- Mount the host once in `ChatView` and run focused lifecycle tests.

### Task 4: NO BS cinematic

- Add failing Agent tests for Off-to-On playback, skip, focus return, and no replay on disable.
- Replace the small confirmation with the isolated reference sequence.
- Preserve the existing prompt-section mutation and save flow.
- Run focused Agent and prompt tests.

### Task 5: Closure

- Run all changed-surface tests once.
- Run scoped TypeScript diagnostics, Prettier check, and `git diff --check`.
- Inspect only the owned diff, record evidence, and release the paths.
