# OpenCode-Only Production Routes Plan

## Task 1: Lock the architecture with failing tests

**Files**

- Create `app/src/lib/ai/openCodeOnlyArchitecture.test.ts`
- Modify `app/src/lib/ai/router.test.ts`
- Modify `app/src/lib/actions/registryModelSelection.test.ts`

1. Assert the router imports no ordinary native provider or external CLI
   executor.
2. Assert the router exports no generic external connection runner.
3. Assert an `external-cli` connection ID cannot reach the OpenCode adapter.
4. Assert model-switch candidates exclude external CLI connections.

## Task 2: Remove dead production dispatch surfaces

**Files**

- Modify `app/src/lib/ai/router.ts`
- Delete `app/src/lib/ai/router.connection.test.ts`
- Delete `app/src/lib/ai/router.taskbarUsage.test.ts`
- Modify `app/src/lib/actions/registryModelSelection.ts`

1. Remove ordinary native provider and external CLI adapter imports/maps.
2. Remove public generic external execution and ordinary provider resolution.
3. Narrow the private external helper to exact kernel smoke authority.
4. Reject external CLI connection IDs in ordinary OpenCode selection.
5. Filter external CLI connections from action-driven model switching.

## Task 3: Verify and release

1. Run focused architecture/router/smoke/model/runtime/Prompt Forge/Model
   Foundry/adapter/harness suites.
2. Run typecheck, production build, Prettier, `git diff --check`, ownership
   checks, direct-provider import scans, external-CLI reachability scans, and
   one-dispatch scans.
3. Record evidence, release the Phase 16 lock, and commit only owned paths.
