# Focused Visual Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Blend three theme-specific chat illustrations, simplify Kanban, and clarify the Warm Files waterfall.

**Architecture:** Preserve all existing assets and behavior. Use scoped CSS for visual treatment; remove only the Kanban activity-feed dependency and view while allowing the existing flex/grid layout to fill the released height.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library.

## Global Constraints

- Do not add dependencies or regenerate assets.
- Preserve chat prompt actions, file behavior, milestone behavior, and to-do behavior.
- Scope visual changes to the named themes and Warm Files.

---

### Task 1: Theme-aware chat image blending

**Files:**

- Modify: `app/src/features/chat/chat-welcome.css`
- Test: `app/src/features/chat/WarmChatWelcome.test.tsx`

**Interfaces:**

- Consumes: `data-welcome-theme` emitted by `WarmChatWelcome`.
- Produces: theme-scoped art presentation only.

- [ ] Add failing assertions for edge fades and theme-specific image treatment.
- [ ] Run the focused chat welcome test and confirm the new assertions fail.
- [ ] Add theme-scoped masks, opacity, and filter values without changing layout.
- [ ] Run the focused test and confirm it passes.

### Task 2: Kanban milestone expansion

**Files:**

- Modify: `app/src/features/kanban/KanbanPage.tsx`
- Test: `app/src/features/kanban/KanbanPage.addFlow.test.tsx`

**Interfaces:**

- Consumes: the existing milestone store only.
- Produces: the existing checklist grid without the unrelated activity feed.

- [ ] Add a failing assertion that the activity region is absent after adding a milestone.
- [ ] Run the focused Kanban test and confirm it fails.
- [ ] Remove the workspace activity subscription, section, and unused imports.
- [ ] Make the checklist grid stretch through the released height.
- [ ] Run the focused Kanban test and confirm it passes.

### Task 3: Warm Files artwork clarity

**Files:**

- Modify: `app/src/styles/warm-theme.css`
- Test: `app/src/features/appearance/warmTheme.test.ts`

**Interfaces:**

- Consumes: `/assets/themes/warm/final-redo/files-scene-v1.webp`.
- Produces: presentation-only clarity improvements.

- [ ] Add failing CSS contract assertions for the clearer scenic layer.
- [ ] Run the Warm theme test and confirm it fails.
- [ ] Reduce the center wash and raise scene visibility while preserving readable panels.
- [ ] Run focused Warm, chat, and Kanban tests.
- [ ] Run the production Vite bundle and inspect the scoped diff.
