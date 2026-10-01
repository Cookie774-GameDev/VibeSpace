# Verified Local Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three exact requested local-model labels with verified metadata and complete lifecycle actions that establish Ollama first and prove model readiness.

**Architecture:** The immutable catalog is the source of display/resource truth. The Ollama provider owns local pull, forced repair/update, delete, and bounded chat verification. Local Models renders those capabilities without inventing unsupported pause/resume behavior.

**Tech Stack:** TypeScript 5.6, React 18, Vitest, Testing Library, Ollama `/api/pull`, `/api/delete`, `/api/tags`, and `/api/chat`.

## Global Constraints

- Preserve exact labels: `Qwen3.6 35B-A3B`, `GPT-OSS 20B`, `Qwen3.5 4B`.
- Use only official verified Ollama tags and truthful metadata.
- Do not mark any new requested model recommended.
- Establish a healthy Ollama connection before every lifecycle action.
- Pause is unavailable because Ollama pull is not resumable; cancellation must be real.
- Prompt 11 remains authoritative for consent-based Ollama installation.
- No new dependencies or unrelated UI/backend changes.

---

### Task 1: Structured verified catalog metadata

**Files:**
- Modify: `app/src/lib/ai/localModelCatalog.ts`
- Create: `app/src/lib/ai/localModelCatalog.test.ts`

**Interfaces:**
- Extends `LocalCatalogModel` with `downloadBytes`, `contextTokens`,
  `license`, `quantization`, `ramGuidance`, `vramGuidance`, `speedClass`,
  `cpuPractical`, `capabilities`, and `sourceUrl`.

- [ ] **Step 1: Write failing exact-metadata tests**

```ts
expect(requested.map(({ displayName, name }) => ({ displayName, name }))).toEqual([
  { displayName: 'Qwen3.6 35B-A3B', name: 'qwen3.6:35b-a3b' },
  { displayName: 'GPT-OSS 20B', name: 'gpt-oss:20b' },
  { displayName: 'Qwen3.5 4B', name: 'qwen3.5:4b' },
]);
expect(requested.every((model) => model.recommended !== true)).toBe(true);
expect(requested.every((model) => model.sourceUrl.startsWith('https://ollama.com/library/'))).toBe(true);
```

Assert the exact Q4_K_M/MXFP4 formats, 24/14/3.4 GB downloads,
256K/128K/256K context, Apache-2.0 licenses, and nonempty resource guidance.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/lib/ai/localModelCatalog.test.ts`

- [ ] **Step 3: Implement immutable metadata**

Preserve every existing entry and the inherited `Balanced` label correction.
Add the requested entries without `recommended`. Use bytes for disk
comparisons and formatted strings only for presentation.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test -- --run src/lib/ai/localModelCatalog.test.ts
git add -- app/src/lib/ai/localModelCatalog.ts app/src/lib/ai/localModelCatalog.test.ts
git commit -m "feat(local-models): add verified requested catalog"
```

### Task 2: Complete Ollama model lifecycle primitives

**Files:**
- Modify: `app/src/lib/ai/providers/ollama.ts`
- Modify: `app/src/lib/ai/providers/ollama.test.ts`

**Interfaces:**
- Produces: `pullOllamaModel(name, onProgress, signal, { force })`,
  `removeOllamaModel(name, signal)`, and
  `verifyOllamaModelChat(name, signal)`.

- [ ] **Step 1: Write failing lifecycle tests**

Prove a normal pull skips an installed model, a forced pull invokes `/api/pull`,
remove invokes `DELETE /api/delete` with the exact validated name, and chat
verification invokes `/api/chat` with:

```ts
{
  model: 'qwen3.5:4b',
  messages: [{ role: 'user', content: 'Reply with READY.' }],
  stream: false,
  think: false,
  keep_alive: 0,
  options: { num_predict: 8, temperature: 0 },
}
```

Reject empty output, mismatched/absent installed tag, abort, oversized
response, and non-loopback endpoints.

- [ ] **Step 2: Run RED**

Run: `npm test -- --run src/lib/ai/providers/ollama.test.ts`

- [ ] **Step 3: Implement minimal lifecycle primitives**

Reuse model-name validation, loopback URL validation, bounded native fetch,
abort signals, and tag normalization. Export the existing best-effort delete
logic as a throwing user action while retaining a private no-throw cleanup
wrapper for failed pulls.

- [ ] **Step 4: Run GREEN and commit**

```powershell
npm test -- --run src/lib/ai/providers/ollama.test.ts
git add -- app/src/lib/ai/providers/ollama.ts app/src/lib/ai/providers/ollama.test.ts
git commit -m "feat(local-models): add repair remove and launch verification"
```

### Task 3: Catalog resource guidance and actions

**Files:**
- Modify: `app/src/features/settings/sections/LocalModels.tsx`
- Modify: `app/src/features/settings/sections/LocalModels.runtime.test.tsx`
- Modify: `app/src/features/settings/sections/LocalModels.monochromeAppearance.test.tsx`

**Interfaces:**
- Consumes: structured catalog metadata and Ollama lifecycle primitives.
- Produces: accessible Download/Cancel/Retry/Repair/Update/Remove controls and resource disclosure.

- [ ] **Step 1: Write failing real-flow component tests**

Prove:

- each exact label and resource guidance appears;
- no requested card says Recommended;
- Download calls connection establishment before pull;
- success requires tag verification and chat verification before selection;
- Cancel aborts the real request;
- Update/Repair force pull;
- Remove asks for confirmation and calls delete only after confirmation;
- Pause is described as unsupported and no fake Pause control exists;
- low storage blocks download when available bytes are below model bytes plus
  bounded safety headroom.

- [ ] **Step 2: Run RED**

Run:

```powershell
npm test -- --run src/features/settings/sections/LocalModels.runtime.test.tsx
```

- [ ] **Step 3: Implement resource cards and actions**

Keep the existing compact card layout and theming. Add a semantic details
region for storage, RAM/VRAM, context, quantization, speed, CPU practicality,
license, and official source. Use one in-flight lifecycle action at a time.
After pull, run tag verification and bounded chat verification before
`connectLocalModelToChat`.

- [ ] **Step 4: Run focused UI and theme checks**

```powershell
npm test -- --run src/features/settings/sections/LocalModels.runtime.test.tsx src/features/settings/sections/LocalModels.monochromeAppearance.test.tsx src/features/local-models/sakura-local-models.appearance.test.ts
```

- [ ] **Step 5: Commit**

```powershell
git add -- app/src/features/settings/sections/LocalModels.tsx app/src/features/settings/sections/LocalModels.runtime.test.tsx app/src/features/settings/sections/LocalModels.monochromeAppearance.test.tsx
git commit -m "feat(local-models): complete catalog lifecycle UI"
```

### Task 4: Catalog verification boundary

**Files:**
- Verify only files changed in Tasks 1-3.

- [ ] **Step 1: Run focused suite**

```powershell
npm test -- --run src/lib/ai/localModelCatalog.test.ts src/lib/ai/providers/ollama.test.ts src/features/settings/sections/LocalModels.runtime.test.tsx src/features/settings/sections/LocalModels.monochromeAppearance.test.tsx src/features/local-models/sakura-local-models.appearance.test.ts
```

- [ ] **Step 2: Run TypeScript and hygiene**

```powershell
npm run typecheck
npx prettier --check src/lib/ai/localModelCatalog.ts src/lib/ai/localModelCatalog.test.ts src/lib/ai/providers/ollama.ts src/lib/ai/providers/ollama.test.ts src/features/settings/sections/LocalModels.tsx src/features/settings/sections/LocalModels.runtime.test.tsx
git diff --check
```

- [ ] **Step 3: Perform bounded installed-runtime flow**

Call Ollama status and `/api/tags`. If a model is already installed, run the
bounded verification completion against it and record the exact model and
response status. Do not download 3.4–24 GB merely to manufacture evidence
when storage or runtime prerequisites are unavailable; report that exact
external/resource blocker.
