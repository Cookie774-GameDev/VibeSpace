# OpenCode Child-Session Product Parity Plan

## Task 1: Define the failing child-session contract

**Files**

- Modify `app/src/lib/ai/openCodeRunAgent.test.ts`
- Modify `app/src/lib/ai/router.test.ts`
- Modify `app/src/lib/harness/openCodeHarness.test.ts`
- Modify `app/src/lib/ai/runtime.test.ts`

1. Assert VibeSpace child scopes create OpenCode sessions with the mapped
   parent session ID.
2. Assert child-before-parent launches create and later reuse a dormant parent.
3. Assert exact selected model metadata and normalized session bindings cross
   the router/runtime boundary.
4. Assert invalid self-parent and directory mismatch fail closed.

## Task 2: Implement bounded session mapping

**Files**

- Modify `app/src/lib/ai/router.ts`
- Modify `app/src/lib/ai/openCodeRunAgent.ts`
- Modify `app/src/lib/harness/types.ts`
- Modify `app/src/lib/harness/openCodeHarness.ts`

1. Add optional parent scope and normalized binding callbacks.
2. Resolve or create the parent session inside the adapter.
3. Create the child with `parentSessionId`, protect the parent during bounded
   eviction, and preserve replacement/clear semantics.
4. Keep OpenCode shapes behind the harness interface.

## Task 3: Preserve the existing VibeSpace product UI

**Files**

- Modify `app/src/lib/ai/runtime.ts`
- Modify `app/src/features/jarvis-interaction/types.ts`
- Modify `app/src/features/jarvis-interaction/sessionStore.ts`
- Modify `app/src/features/jarvis-interaction/sessionStore.test.ts`
- Modify `app/src/features/jarvis-interaction/agents.test.ts`

1. Read the parent chat only from validated multitask/subagents structured
   context.
2. Persist opaque child/parent harness IDs on the existing agent card.
3. Preserve exact model selection and all existing status transitions.
4. Prove existing `/multitask` and `/subagents` launch behavior remains green.

## Task 4: Verify and release

1. Run the child-agent, session-store, runtime, router, adapter, client, harness,
   slash-command, and action-registry suites.
2. Run typecheck, production build, Prettier, `git diff --check`, exact-model
   scans, and a child-parent mapping scan.
3. Record evidence, release the coordination lock, and commit only owned
   paths.
