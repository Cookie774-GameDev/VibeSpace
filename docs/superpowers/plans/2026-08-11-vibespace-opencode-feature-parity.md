# OpenCode Feature Parity Plan

## Task 1: Prove and repair the plugin bridge

**Files**

- Modify `app/src/lib/harness/toolGatewayProduction.test.ts`
- Modify `app/src/lib/harness/toolGatewayProduction.ts`
- Modify `app/src/lib/jarvis/jarvisSecurityRuntime.test.ts`
- Modify `app/src/lib/jarvis/jarvisSecurityRuntime.ts`
- Modify `app/src/App.toolGateway.test.tsx`
- Modify `app/src/App.tsx`

1. Add failing tests for exact registered read-only plugin execution.
2. Add a revocable Tool Gateway read port.
3. Resolve and validate one canonical registered plugin action in the trusted
   security runtime.
4. Reject writes, ambiguity, missing authority, and account changes.
5. Install/revoke the port with the active kernel security runtime.

## Task 2: Prove every feature uses OpenCode

**Files**

- Create `app/src/lib/ai/featureOpenCodeParity.test.ts`
- Modify `app/src/lib/ai/runtime.test.ts` only if a missing runtime contract is
  discovered.

1. Assert the runtime compiles plugin, skill, context, file, All About Me, and
   learning inputs before its single `runAgent` call.
2. Assert All About Me, files, nightly context, and Model Foundry model turns
   call the shared router.
3. Assert the router has one production OpenCode dispatch and no feature
   direct-provider fallback.

## Task 3: Verify and release

1. Run focused plugins/MCP/skills/context/profile/learning/files/Model Foundry,
   runtime, gateway, router, adapter, and harness suites.
2. Run typecheck, production build, Prettier, `git diff --check`, semantic
   catalog scans, private-store scans, and direct-route scans.
3. Record evidence, release the lock, and commit only owned paths.
