# Jarvis Actions and Custom Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and execute inline; subagents are prohibited by the user.

**Goal:** Complete Prompt 25 without weakening the action approval boundary or redesigning Custom Tools.

**Architecture:** Fix navigation within the Jarvis Actions settings section, retain existing action registries and approval engine, and verify their contracts through focused tests.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Testing Library.

## Global Constraints

- No action executes without approval except explicit trusted automation.
- Add no catalog item without a real handler.
- Preserve the Custom Tools page design and all unrelated systems.

---

### Task 1: Settings-to-Tools navigation and polish

**Files:** `JarvisActions.tsx`, `JarvisActions.test.tsx`

- [ ] Write a failing test asserting Settings closes before route changes to `tools`.
- [ ] Run it and confirm RED.
- [ ] Implement the two-step navigation and lightweight reduced-motion-safe interaction polish.
- [ ] Run the focused test and confirm GREEN.

### Task 2: Approval and custom-action contracts

**Files tested:** `ActionApprovalCard.test.tsx`, `runner.test.ts`, `autoApprove.test.ts`, `creatorActions.test.ts`, `toolStore.test.ts`

- [ ] Run proposal, single approval, approve-all, rejection/cancellation, invalid-command, custom creation/resolution, and trusted automation tests.
- [ ] Change production code only if focused RED evidence proves a defect.

### Task 3: Verification

- [ ] Run focused TypeScript/tests, production build, formatting, diff hygiene, and live local navigation where the runtime permits.
