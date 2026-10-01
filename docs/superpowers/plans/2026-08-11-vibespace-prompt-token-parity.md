# Prompt Forge and Token Optimizer Parity Plan

## Task 1: Fail closed Prompt Forge tools

**Files**

- Modify `app/src/features/prompt-forge/promptForgeExecutor.test.ts`
- Modify `app/src/features/prompt-forge/promptForgeExecutor.ts`

1. Add a failing assertion that every Tool Gateway capability is explicitly
   disabled on the Prompt Forge `runAgent` request.
2. Build one frozen deny policy from the canonical semantic tool catalog.
3. Preserve all existing prompt, identity, secret, image, and validation
   behavior.
4. Run focused Prompt Forge tests and commit only these files.

## Task 2: Prove all token modes enter OpenCode

**Files**

- Create `app/src/lib/ai/tokenModeOpenCodeParity.test.ts`

1. Build Token Saver, Normal, and Final Boss requests with the real reasoning
   policy resolver.
2. Send each through the real OpenCode `runAgent` adapter and a bounded fake
   harness.
3. Assert exact model selection, mode instructions, output limits/options, and
   one OpenCode send per mode.
4. Commit only the new parity test.

## Task 3: Verify and release

**Files**

- Modify `C:\Users\viper\VibeSpace\AGENT_COORDINATION.md`
- Modify `.agent-coordination.lock/owner.txt`

1. Run Prompt Forge, preservation/source/secret/model selection, Token
   Optimizer, reasoning bridge/control, runtime, router, and OpenCode adapter
   suites.
2. Run typecheck, production build, Prettier, `git diff --check`, tool-policy
   scan, and exact-model/no-fallback scan.
3. Record pre/post contract evidence, mark the lock released, and commit only
   the release record.
