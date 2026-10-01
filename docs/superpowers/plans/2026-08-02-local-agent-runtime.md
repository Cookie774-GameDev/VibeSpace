# Local Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add truthful Fast/Deep local execution policy and opt-in, disclosed, approval-bound cloud escalation while reusing VibeSpace's existing RAG and action authorities.

**Architecture:** A small local runtime policy module owns persisted preferences, Ollama request shaping, and fail-closed escalation proposals. The Ollama provider and router consume that policy; Local Models exposes the settings. Existing context retrieval, action planning, canonical approvals, and model-switch actions remain authoritative.

**Tech Stack:** TypeScript 5.6, React 18, Zustand-backed existing stores, Vitest, Testing Library, Ollama HTTP API.

## Global Constraints

- Fully Local Chat must never permit cloud escalation or public research.
- Every local-to-cloud move requires explicit canonical approval after a disclosure.
- Destructive tools retain the existing approval mechanism.
- Retrieval remains bounded and no background task manager is added.
- Do not modify active voice/auth/App/native ownership.
- No new dependencies.

---

### Task 1: Local runtime policy

**Files:**
- Create: `app/src/lib/ai/localAgentRuntime.ts`
- Create: `app/src/lib/ai/localAgentRuntime.test.ts`

**Interfaces:**
- Produces: `LocalAgentMode`, `LocalAgentPreferences`, `readLocalAgentPreferences()`, `writeLocalAgentPreferences()`, `localOllamaRequestPolicy()`, `planLocalCloudEscalation()`, and `LocalCloudEscalationRequiredError`.
- Consumes: browser `localStorage`; provider/model identifiers supplied by the caller.

- [ ] **Step 1: Write failing preference and mode-policy tests**

```ts
expect(readLocalAgentPreferences(storage)).toEqual({
  mode: 'fast',
  cloudEscalationEnabled: false,
});
expect(localOllamaRequestPolicy('fast')).toMatchObject({
  think: false,
  numPredict: 512,
});
expect(localOllamaRequestPolicy('deep')).toMatchObject({
  think: true,
  requiresVerification: true,
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm test -- --run src/lib/ai/localAgentRuntime.test.ts`

Expected: FAIL because `localAgentRuntime.ts` and its exports do not exist.

- [ ] **Step 3: Implement bounded persistence and mode policy**

```ts
export type LocalAgentMode = 'fast' | 'deep';
export interface LocalAgentPreferences {
  mode: LocalAgentMode;
  cloudEscalationEnabled: boolean;
}

export function localOllamaRequestPolicy(mode: LocalAgentMode) {
  return mode === 'fast'
    ? Object.freeze({ think: false, numPredict: 512, requiresVerification: false })
    : Object.freeze({ think: true, numPredict: 2048, requiresVerification: true });
}
```

Parse persisted input strictly, default safely, cap serialized input, and emit a same-window preference event only after a successful write.

- [ ] **Step 4: Write failing escalation-policy tests**

```ts
expect(planLocalCloudEscalation({
  offlineMode: true,
  enabled: true,
  failure: 'inference_failed',
  providerId: 'google',
  modelId: 'gemini-3.5-flash',
  data: { messageChars: 120, contextChars: 300, categories: ['prompt', 'local excerpts'] },
})).toEqual({ status: 'refused', reason: 'fully_local' });

expect(planLocalCloudEscalation({
  offlineMode: false,
  enabled: true,
  failure: 'inference_failed',
  providerId: 'google',
  modelId: 'gemini-3.5-flash',
  data: { messageChars: 120, contextChars: 300, categories: ['prompt', 'local excerpts'] },
})).toMatchObject({
  status: 'approval_required',
  providerId: 'google',
  modelId: 'gemini-3.5-flash',
});
```

- [ ] **Step 5: Run RED, implement disclosure, then run GREEN**

Run: `npm test -- --run src/lib/ai/localAgentRuntime.test.ts`

Implement an immutable proposal containing only bounded reason, provider,
model, category names, and approximate character counts. It must never contain
message text, excerpts, credentials, or a dispatch callback.

Run again and expect PASS.

- [ ] **Step 6: Commit the runtime policy**

```powershell
git add -- app/src/lib/ai/localAgentRuntime.ts app/src/lib/ai/localAgentRuntime.test.ts
git commit -m "feat(local-ai): add fast deep and escalation policy"
```

### Task 2: Ollama mode integration and verifier contract

**Files:**
- Modify: `app/src/lib/ai/providers/ollama.ts`
- Modify: `app/src/lib/ai/providers/ollama.test.ts`

**Interfaces:**
- Consumes: `readLocalAgentPreferences()` and `localOllamaRequestPolicy()`.
- Produces: Ollama `/api/chat` request bodies with explicit `think` and bounded mode-specific output options.

- [ ] **Step 1: Write failing request-shaping tests**

```ts
expect(buildOllamaRequestBody(request, 'qwen3.5:4b')).toMatchObject({
  think: false,
  options: { num_predict: 512 },
});
```

Set Deep preferences and assert `think: true`, a bounded larger output budget,
and the unchanged compact history limit.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/lib/ai/providers/ollama.test.ts`

Expected: FAIL because the current request body has no explicit local mode.

- [ ] **Step 3: Implement the mode mapping**

Read preferences once per request. Preserve caller `max_output_tokens` when it
is lower than the mode cap. Keep context, history, timeout, keep-alive, and
streaming limits unchanged.

- [ ] **Step 4: Add and verify verifier-failure coverage**

Use the existing `executeJarvisPlan` test seam to prove a successful action
without evidence ends as `failed`, while verified evidence ends as
`completed`. Do not add another executor.

Run:

```powershell
npm test -- --run src/lib/ai/providers/ollama.test.ts src/lib/jarvis/actions/planner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/lib/ai/providers/ollama.ts app/src/lib/ai/providers/ollama.test.ts
git commit -m "feat(local-ai): apply fast and deep Ollama modes"
```

### Task 3: Router refusal and disclosure boundary

**Files:**
- Modify: `app/src/lib/ai/router.ts`
- Create: `app/src/lib/ai/router.localAgentRuntime.test.ts`

**Interfaces:**
- Consumes: local runtime preferences and `planLocalCloudEscalation()`.
- Produces: `LocalCloudEscalationRequiredError` only after an unstarted local request fails; it never retries or dispatches a cloud provider.

- [ ] **Step 1: Write failing router tests**

Prove:

```ts
await expect(runAgent(localFailureWithFullyLocal)).rejects.not.toBeInstanceOf(
  LocalCloudEscalationRequiredError,
);
await expect(runAgent(localFailureWithEscalationEnabled)).rejects.toMatchObject({
  name: 'LocalCloudEscalationRequiredError',
  proposal: {
    status: 'approval_required',
    providerId: 'google',
    modelId: expect.any(String),
  },
});
expect(cloudProvider.run).not.toHaveBeenCalled();
```

Also prove an aborted request, partially streamed response, disabled
preference, and non-local provider failure never produce an escalation.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/lib/ai/router.localAgentRuntime.test.ts`

- [ ] **Step 3: Implement fail-closed proposal creation**

Classify only connection failure, unavailable local capability, or empty local
inference before any output. Choose a configured cloud candidate using the
existing model-selection inventory, but do not invoke it. Throw the structured
disclosure error whose next action is the existing canonical model-switch
request.

- [ ] **Step 4: Run router tests and preserved taskbar regression**

Run:

```powershell
npm test -- --run src/lib/ai/router.localAgentRuntime.test.ts src/lib/ai/router.taskbarUsage.test.ts src/lib/ai/router.test.ts
```

Expected: PASS and taskbar in-flight accounting remains balanced.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/lib/ai/router.ts app/src/lib/ai/router.localAgentRuntime.test.ts
git commit -m "feat(local-ai): require disclosure before cloud escalation"
```

### Task 4: Local Models mode settings and local-only picker isolation

**Files:**
- Modify: `app/src/features/settings/sections/LocalModels.tsx`
- Create: `app/src/features/settings/sections/LocalModels.runtime.test.tsx`
- Modify: `app/src/lib/ai/useAccessibleChatModels.ts`
- Modify: `app/src/lib/ai/useAccessibleChatModels.test.ts`

**Interfaces:**
- Consumes: local preference read/write APIs.
- Produces: Fast/Deep controls, disabled-by-default cloud escalation switch, and local-only connection groups whenever Fully Local Chat is enabled.

- [ ] **Step 1: Write failing UI and picker tests**

Render Local Models and assert Fast is the default, Deep persists, escalation
defaults off, and its copy states per-task approval. Build accessible groups
with `offlineMode: true` and assert every option has `connection.mode ===
'local'`.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/features/settings/sections/LocalModels.runtime.test.tsx src/lib/ai/useAccessibleChatModels.test.ts
```

- [ ] **Step 3: Implement controls and filtering**

Use the existing `Button`, `Switch`, labels, focus styles, and theme hooks.
Do not add timers. Filter `PROVIDER_CONNECTIONS` before
`buildConnectionPickerGroups` when offline mode is true.

- [ ] **Step 4: Run focused UI/theme checks**

Run:

```powershell
npm test -- --run src/features/settings/sections/LocalModels.runtime.test.tsx src/features/settings/sections/LocalModels.monochromeAppearance.test.tsx src/features/local-models/sakura-local-models.appearance.test.ts src/lib/ai/useAccessibleChatModels.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/settings/sections/LocalModels.tsx app/src/features/settings/sections/LocalModels.runtime.test.tsx app/src/lib/ai/useAccessibleChatModels.ts app/src/lib/ai/useAccessibleChatModels.test.ts
git commit -m "feat(local-ai): expose runtime modes and local isolation"
```

### Task 5: Runtime verification boundary

**Files:**
- Verify only the files changed in Tasks 1-4.

- [ ] **Step 1: Run focused runtime suite**

```powershell
npm test -- --run src/lib/ai/localAgentRuntime.test.ts src/lib/ai/providers/ollama.test.ts src/lib/ai/router.localAgentRuntime.test.ts src/lib/ai/router.taskbarUsage.test.ts src/lib/ai/useAccessibleChatModels.test.ts src/features/settings/sections/LocalModels.runtime.test.tsx src/lib/jarvis/actions/planner.test.ts
```

- [ ] **Step 2: Run TypeScript and hygiene checks**

```powershell
npm run typecheck
npx prettier --check src/lib/ai/localAgentRuntime.ts src/lib/ai/localAgentRuntime.test.ts src/lib/ai/providers/ollama.ts src/lib/ai/providers/ollama.test.ts src/lib/ai/router.ts src/lib/ai/router.localAgentRuntime.test.ts src/lib/ai/useAccessibleChatModels.ts src/lib/ai/useAccessibleChatModels.test.ts src/features/settings/sections/LocalModels.tsx src/features/settings/sections/LocalModels.runtime.test.tsx
git diff --check
```

- [ ] **Step 3: Inspect exact diff**

Confirm there is no cloud provider invocation in the escalation branch, no
new action executor, no active voice/auth/App/native edit, no timer, no secret,
and no unrelated taskbar router change.
