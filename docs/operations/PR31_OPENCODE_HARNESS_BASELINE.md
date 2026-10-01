# PR31 OpenCode Harness Baseline

Recorded: 2026-08-11

Task: `VS-PR31-OPENCODE-HARNESS-PHASE1-20260811`

Starting HEAD: `9bfe4bde3e77a75029c188230bbf862deec639ab`

## Authority

- Master goal:
  `VIBESPACE_PR31_OPENCODE_ONLY_HARNESS_GOAL.md`
- Goal SHA-256:
  `21CE0D454BBB0BF152B78C1904ED9556C92503484D32148372B5BD8032267FAD`
- Target branch: `agent/pr30-fixes-and-updates`
- Production deployment, merge, push, release, installer changes, and
  production Supabase/Stripe mutation remain prohibited.
- The implementation is sequential and uses no subagents.

## Current architecture

- `app/src/lib/ai/index.ts` exports the public `runAgent` seam.
- `app/src/lib/ai/router.ts` still dispatches normal production calls to
  direct provider implementations and external CLI adapters.
- `app/src/lib/ai/adapters/opencode.ts` uses one-process-per-prompt
  `opencode run`; it is not a persistent server transport.
- `app/src/lib/harness/` does not exist at this baseline.
- `cohere`, `perplexity`, `fireworks`, `replicate`, `hyperbolic`, `novita`,
  `lambda`, `azure`, `cerebras`, `huggingface`, and `bedrock` currently map to
  `mockProvider` in the router.
- No production invariant currently proves that Chat, Prompt Forge, and agent
  turns terminate at OpenCode.

## Existing foundations

- The native CLI bridge allowlists `opencode`, canonicalizes executable paths,
  fingerprints trusted binaries, rejects replacement after discovery, blocks
  Windows script shims, validates working directories, bounds output and
  timeouts, and supports cancellation.
- `app/src-tauri/src/cli_bridge.rs` contains 36 native tests.
- Existing focused test inventory:
  - Router: 5 test files.
  - Prompt Forge: 18 test files.
  - Token Optimizer: 12 test files.
  - Slash commands: 2 test files.
  - Subscription Bridge: 1 test file.

## Focused baseline verification

Command:

```powershell
npm test -- --run src/lib/ai/router.test.ts src/lib/ai/router.connection.test.ts src/lib/ai/router.localAgentRuntime.test.ts src/lib/ai/router.smoke.test.ts src/lib/ai/providers/ollama.test.ts src/features/chat/SlashCommandTypeahead.test.ts src/features/settings/SubscriptionCliBridge.test.tsx src/features/prompt-forge/promptForgeExecutor.test.ts src/features/token-optimizer/chatRuntimeBridge.test.ts
```

Result: PASS — 9 files, 95 tests.

## OpenCode runtime evidence

- Official pinned release: `v1.18.16`, published 2026-08-10.
- Windows x64 core asset: `opencode-windows-x64.zip`.
- Asset size: `60,501,625` bytes.
- Asset SHA-256:
  `a60bf4d8019982b81dc0c3b91b6e226442cf2b73aca817599b68779ac053e3ff`.
- The installed `opencode` command resolves first to the rejected npm
  PowerShell shim:
  `C:\Users\viper\AppData\Roaming\npm\opencode.ps1`.
- The safely resolved underlying native executable is version `1.18.14` at:
  `C:\Users\viper\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`.
- Native executable SHA-256:
  `F37CB2773654449B4E20DD5DCF47CFDD55FE569628CAE9081F480BAEEA9A80DD`.
- No auth state, token, cookie, or provider secret was inspected or recorded.

## Phase 1 exit criteria

Phase 1 adds only stable TypeScript contracts, safe typed errors, exact
provider/model resolution, and bounded event normalization. It does not switch
production routing. Each behavior must be introduced by a test that first
fails for the intended missing behavior.
