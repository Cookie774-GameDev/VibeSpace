# Chat Reasoning Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship truthful provider-aware `/effort` and `/mode` controls that
preserve the selected model and affect supported requests.

**Architecture:** A pure capability resolver owns the normalized reasoning
scale, model-specific support, snapping, and provider serialization. A bounded
per-chat store owns durable user policy. Composer projects both through the
existing option picker and captures an immutable snapshot; runtime revalidates
that snapshot against the final routed model before dispatch.

**Tech Stack:** TypeScript, React, Zustand-adjacent bounded local persistence,
Vitest, existing LLM router/provider adapters, existing CLI bridge.

## Global Constraints

- Never change the selected model.
- Never send unsupported or arbitrary provider parameters.
- Keep Qwen outside the adjustable effort scale.
- Preserve existing slash-picker keyboard and theme behavior.
- Do not add dependencies or mutate external systems.
- Broader `/mode` retrieval/planning behavior is documented future work, not
  simulated in this slice.

---

### Task 1: Capability resolver and snapping

**Files:**

- Create: `app/src/lib/ai/reasoningControls.ts`
- Create: `app/src/lib/ai/reasoningControls.test.ts`

**Interfaces:**

- Produces `ReasoningEffort`, `ReasoningMode`, `ReasoningPreference`,
  `getReasoningCapabilities`, `resolveReasoningPolicy`, and
  `providerOptionsForReasoning`.

- [ ] Write literal table tests for OpenAI/Codex, Anthropic, Gemini, Groq
      GPT-OSS, Ollama GPT-OSS, xAI, GPT-4, Qwen, and unsupported providers.
- [ ] Run the focused test and confirm missing-module/behavior failures.
- [ ] Implement normalized capability lists, deterministic snapping, mode
      resolution, output ceilings, and allowlisted provider serialization.
- [ ] Run the focused test and confirm all capability cases pass.

### Task 2: Per-chat durable policy

**Files:**

- Create: `app/src/features/chat/reasoningSlashStore.ts`
- Create: `app/src/features/chat/reasoningSlashStore.test.ts`

**Interfaces:**

- Consumes `ReasoningPreference`.
- Produces `readChatReasoningPreference`, `writeChatReasoningMode`,
  `writeChatReasoningEffort`, and `clearChatReasoningPreferences`.

- [ ] Write failing tests for defaults, per-chat isolation, malformed-state
      recovery, mode-clears-override, effort override, and bounded persistence.
- [ ] Run the focused test and confirm the expected missing behavior.
- [ ] Implement versioned local persistence with normalization and bounded chat
      count.
- [ ] Run the focused test and confirm all persistence cases pass.

### Task 3: Slash commands and picker integration

**Files:**

- Modify: `app/src/features/chat/SlashCommandTypeahead.tsx`
- Modify: `app/src/features/chat/SlashCommandTypeahead.test.ts`
- Modify: `app/src/features/chat/Composer.tsx`
- Create: `app/src/features/chat/Composer.reasoningCommands.test.tsx`

**Interfaces:**

- Consumes the capability resolver and per-chat store.
- Produces `/effort` and `/mode` picker/manual-command behavior plus the
  immutable send snapshot.

- [ ] Add failing command discovery and Composer interaction tests.
- [ ] Run the focused tests and confirm the commands/options are absent.
- [ ] Add both definitions, structured-picker routing, option selection,
      manual parsing/help, focus restoration, unsupported-state messaging, and
      send-detail snapshot.
- [ ] Run the focused chat tests and confirm keyboard/manual flows pass.

### Task 4: Runtime and transport propagation

**Files:**

- Modify: `app/src/lib/ai/runtime.ts`
- Create: `app/src/lib/ai/runtime.reasoningControls.test.ts`
- Modify: `app/src/lib/ai/router.ts`
- Modify: `app/src/lib/ai/router.test.ts`
- Modify: `app/src/lib/ai/adapters/types.ts`
- Modify: `app/src/lib/ai/adapters/cliBridge.ts`
- Modify: `app/src/lib/ai/adapters/codex.ts`
- Modify: `app/src/lib/ai/adapters/catalog.test.ts`

**Interfaces:**

- Consumes the captured `ReasoningPreference`.
- Produces revalidated `provider_options`, bounded `max_output_tokens`, and a
  validated Codex config argument.

- [ ] Add failing runtime/router/Codex tests for final-model revalidation,
      unsupported omission, and shell-free argv.
- [ ] Run focused tests and confirm the snapshot is not yet propagated.
- [ ] Thread typed reasoning state through runtime/router and the CLI request.
- [ ] Run focused tests and confirm no prompt/model mutation occurs.

### Task 5: Native provider serialization

**Files:**

- Modify and test: `app/src/lib/ai/providers/openai.ts`
- Modify and test: `app/src/lib/ai/providers/google.ts`
- Modify and test: `app/src/lib/ai/providers/anthropic.ts`
- Modify and test: `app/src/lib/ai/providers/groq.ts`
- Modify and test: `app/src/lib/ai/providers/openai-compatible.ts`
- Modify and test: `app/src/lib/ai/providers/ollama.ts`

**Interfaces:**

- Consumes only allowlisted `provider_options`.
- Produces exact provider request-body fields or omits them.

- [ ] Add failing request-body tests with literal expected provider schemas.
- [ ] Run focused tests and confirm reasoning fields are absent.
- [ ] Serialize OpenAI, Claude, Gemini, Groq, xAI-compatible, and Ollama fields
      without spreading arbitrary options.
- [ ] Run all affected provider tests and confirm unsupported fields are absent.

### Task 6: Closure

**Files:**

- Modify: `C:\Users\viper\VibeSpace\.agent-coordination.lock\owner.txt`
- Modify: `C:\Users\viper\VibeSpace\AGENT_COORDINATION.md`
- Modify: `C:\Users\viper\VibeSpace\docs\orchestration\ACTIVE_STATE.md`

- [ ] Run affected chat, runtime, router, adapter, and provider tests.
- [ ] Run `npm --prefix app run typecheck`.
- [ ] Run scoped Prettier, `git diff --check`, and added-line secret scan.
- [ ] Inspect exact scoped diff, record evidence/limits, and release ownership.
