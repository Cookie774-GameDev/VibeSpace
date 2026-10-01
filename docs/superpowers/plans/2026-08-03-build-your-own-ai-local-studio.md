# Build Your Own AI Local Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a dedicated, polished, local-only Build Your Own AI page with truthful hardware-aware training and media-preparation contracts.

**Architecture:** Preserve the verified Model Foundry domain and native RAG runtime. Add a page shell and route, replace hardcoded training availability with attested capability plans, then connect an isolated native worker boundary without allowing cloud upload or simulated training.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Tauri 2, Rust, existing Ollama and local media/runtime adapters.

## Global Constraints

- No cloud GPU execution or source upload.
- Never modify original user sources.
- Preserve existing verified knowledge artifacts and Agent/Chat integration.
- Add no dependency without provenance review and explicit scope expansion.
- Write and verify a failing focused test before each behavior change.

---

### Task 1: Route and application entry

**Files:**

- Modify: `app/src/stores/ui.ts`
- Modify: `app/src/components/layout/PageRouter.tsx`
- Modify: `app/src/components/layout/TopBar.tsx`
- Test: `app/src/components/layout/PageRouter.modelFoundry.test.tsx`
- Test: `app/src/components/layout/TopBar.modelFoundry.test.tsx`

- [x] Write failing tests proving the `model-foundry` route renders its page and both top-bar layouts expose an accessible Build Your Own AI action.
- [x] Run the focused tests and verify failure occurs because the route and controls do not exist.
- [x] Add the route, lazy page mapping, BrainCircuit button, and compact overflow row.
- [x] Run the focused tests and verify they pass.

### Task 2: Dedicated studio page

**Files:**

- Create: `app/src/features/model-foundry/BuildYourOwnAIPage.tsx`
- Create: `app/src/features/model-foundry/BuildYourOwnAIPage.test.tsx`
- Modify: `app/src/features/model-foundry/index.ts`

- [x] Write failing tests for the six workflow destinations, measured hardware summary, local-only disclosure, model blueprint, and existing-job library.
- [x] Run the focused test and verify the page is missing.
- [x] Implement the responsive three-region page using existing primitives and theme tokens.
- [x] Run the focused page and existing hub tests.

### Task 3: Capability-driven training plans

**Files:**

- Modify: `app/src/features/model-foundry/modelHub.ts`
- Modify: `app/src/features/model-foundry/modelHub.test.ts`

- [x] Write failing tests for attested worker requirements, hardware-fit explanations, QLoRA/LoRA/full-weight distinctions, and no silent downgrade.
- [x] Verify the hardcoded unavailable implementation fails those tests.
- [x] Add typed capability and training-plan contracts with conservative local estimates.
- [x] Run domain tests and verify existing RAG behavior remains green.

### Task 4: Local media-preparation plans

**Files:**

- Create: `app/src/features/model-foundry/mediaPreparation.ts`
- Create: `app/src/features/model-foundry/mediaPreparation.test.ts`
- Modify: `app/src/features/model-foundry/modelHub.ts`

- [x] Write failing tests for image, video, audio, PDF, DOCX, structured-data, malformed, oversized, and unsupported source plans.
- [x] Verify failures are caused by missing preparation contracts.
- [x] Implement bounded local preparation manifests without reading, modifying, or uploading source bytes in the renderer.
- [x] Run media and Model Foundry tests.

### Task 5: Native worker boundary

**Files:**

- Modify only after a lock expansion: `app/src-tauri/src/model_foundry.rs`
- Create only after a lock expansion: `app/src-tauri/src/model_foundry_training.rs`
- Test: native module tests colocated with the implementation.

- [x] Write failing native tests for worker attestation, local-only protocol preflight, and tamper rejection. Existing Model Foundry tests cover knowledge-job cancellation, restart recovery, and verified artifact metadata.
- [x] Implement the smallest isolated command boundary supported by existing packaged runtimes.
- [x] Keep methods unavailable when a real worker is absent or hardware does not fit.
- [x] Run bounded Rust tests and formatting.

### Task 6: Integration and closure

- [ ] Run all Model Foundry frontend/native focused tests.
- [ ] Run app TypeScript, production build, scoped formatting, secret scan, and diff checks.
- [ ] Inspect normal and compact top-bar behavior plus responsive page states with Browser when its transport is available.
- [x] Update `docs/model-foundry.md` with exact supported and unavailable environments.
- [ ] Review the complete scoped diff, release locks, and report unverified hardware honestly.
