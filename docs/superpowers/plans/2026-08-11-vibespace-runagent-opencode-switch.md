# PR31 Phase 10: Switch runAgent to OpenCode

## Goal

Make the private OpenCode harness the only production transport behind
`runAgent` while preserving the existing `LLMResponse` and stream callback
contracts.

## Design

1. Add a bounded `runAgent`-to-harness adapter that:
   - resolves the exact VibeSpace provider/model selection,
   - creates/reuses a project-scoped OpenCode session,
   - converts text and image content into OpenCode prompt parts,
   - maps normalized assistant/usage/done/error events back to `LLMResponse`,
   - verifies provider/model identity from usage events,
   - honors cancellation and emits one terminal stream chunk,
   - accounts for working-directory scope without accepting relative paths.
2. Extend the typed OpenCode client/harness calls with a consistent
   `directory` context for create, prompt, events, recovery, cancellation, and
   session disposal.
3. Pass stable chat identity from the VibeSpace runtime to `runAgent`; bounded
   non-chat calls use their request identity.
4. Preserve protected-attempt observation/action hooks at the normalized event
   boundary.
5. Keep debug-only kernel smoke seams isolated; no production provider SDK,
   legacy CLI adapter, direct Ollama, Prompt Forge, or Model Foundry chat may
   bypass the harness.

## TDD and verification

- Normal text streaming and final response.
- Exact provider/model and mismatch rejection.
- Cancellation before and during a turn.
- Usage/cost mapping and token ledger update.
- Image attachment conversion and invalid attachment rejection.
- Absolute working-directory propagation and relative-path rejection.
- Session reuse, bounded registry, recovery, and no hidden fallback.
- Existing router/runtime/Prompt Forge contracts.
- Typecheck, scoped formatting, and credential/redaction scans.
