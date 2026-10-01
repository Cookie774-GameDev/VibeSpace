# PR31 Model Foundry, autosave, and publication plan

## Acceptance

1. Warm landscape markup never participates in layout outside the Warm theme.
2. MonoChrome Model Foundry preserves the intended navigation, primary, and
   hardware columns without Warm imagery.
3. Canvas changes begin a coalesced recovery/save cycle immediately, while
   preserving transactional revision and recovery behavior.
4. Unfinished Schedule form fields survive renderer/app termination and clear
   only after a successful event save or explicit reset.
5. Existing Benchmarks dataset, refresh configuration, and audit persistence
   remain verified without editing concurrently owned Benchmarks files.
6. Every uncommitted PR31 file is reviewed for ownership, generated junk,
   secrets, and test/build health before one non-force commit and push.

## Implementation

- Add a fail-closed hidden presentation state to the Warm-only Model Foundry
  decoration and reveal it only under `data-theme='warm'`.
- Change Canvas autosave's default delay to immediate coalesced draining. Keep
  the optional bounded delay for tests/special callers.
- Add a versioned, validated, workspace-scoped Schedule draft codec backed by
  synchronous local storage. Restore on mount, update on field changes, and
  clear only after successful creation/reset.
- Do not alter Benchmarks while its current owner is active; run its persistence
  tests after the handoff.

## Verification and rollback

- RED/GREEN focused tests for each behavior and an actual MonoChrome render.
- Full TypeScript, test, production build, diff, secret, and Git review before
  publication.
- Revert the final commit to roll back. No schema or external data migration is
  introduced.
