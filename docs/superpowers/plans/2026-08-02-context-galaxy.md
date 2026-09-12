# Context Galaxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Context Map presentation with a performant pannable 3D galaxy and embed a compact live instance beneath the expanded voice transcript.

**Architecture:** Extract deterministic 3D layout/camera/LOD logic into a pure module and render it through a reusable WebGL2 `ContextGalaxy`. ContextPage remains the data owner; VoiceModal consumes a bounded shared projection. The existing 2D renderer remains the unsupported-hardware, reduced-motion and forced-mode fallback.

**Tech Stack:** React 18, TypeScript, WebGL2, existing Context cooperative worker/performance index, Vitest, Testing Library, Tailwind tokens.

## Global Constraints

- Preserve existing Context Map data and Obsidian-vault-like second-brain behavior.
- Add no dependency and no continuous heavy background task.
- Animate only nodes named by real retrieval/activity events.
- Preserve reduced motion, keyboard use, forced colors, narrow windows and a usable 2D fallback.
- Do not modify unrelated Context, Voice, persistence, cloud or native systems.

---

### Task 1: Deterministic galaxy domain

**Files:**

- Create: `app/src/features/context/contextGalaxyLayout.ts`
- Test: `app/src/features/context/contextGalaxyLayout.test.ts`

**Interfaces:**

- Consumes: stable `{ id, parentId, depth, order, radius, groupId }` graph nodes and edges.
- Produces: `buildGalaxyLayout`, `projectGalaxyPoint`, `selectGalaxyLod`, and camera reducers.

- [ ] Write RED tests proving deterministic sector/shell placement, finite matrices, camera clamps, stable clusters, selected-node retention and strict LOD limits.
- [ ] Run `npm test -- --run src/features/context/contextGalaxyLayout.test.ts` and confirm the named expectations fail.
- [ ] Implement pure bounded layout, camera and LOD helpers with no DOM or storage dependency.
- [ ] Rerun the focused test and require PASS.

### Task 2: Reusable WebGL2 galaxy

**Files:**

- Create: `app/src/features/context/ContextGalaxy.tsx`
- Test: `app/src/features/context/ContextGalaxy.test.tsx`

**Interfaces:**

- Consumes: layout nodes/edges, selected/highlighted IDs, real activity IDs, mode and selection callback.
- Produces: full/compact interactive graph with HTML labels/details and accessible list fallback.

- [ ] Write RED component tests for 3D controls, keyboard selection, activity-only pulse flags, compact limits, reduced-motion fallback and WebGL failure fallback.
- [ ] Run the new component test and confirm failures.
- [ ] Implement demand-driven WebGL buffers, orbit/pan/zoom, context-loss cleanup, label projection, details, semantic controls and the list/2D fallback.
- [ ] Rerun the component test and require PASS.

### Task 3: ContextPage replacement without data changes

**Files:**

- Modify: `app/src/features/context/ContextPage.tsx`
- Modify: `app/src/features/context/jarvisGraphActivity.ts`
- Test: existing ContextPage and graph-activity focused tests.

**Interfaces:**

- Consumes: existing tree/layout, selection, highlighted retrieval IDs and performance index.
- Produces: `ContextGalaxy` inputs and a bounded current-map snapshot for the voice embed.

- [ ] Add RED tests that the Context graph renders 3D by default, retains selection/details, exposes 2D fallback and pulses only real activity.
- [ ] Run the affected Context tests and confirm the new expectations fail.
- [ ] Replace only the presentation layer, preserve map/category/data actions, and publish a bounded account/project-scoped voice snapshot.
- [ ] Rerun the affected Context tests and require PASS.

### Task 4: Compact galaxy under voice transcript

**Files:**

- Modify: `app/src/features/voice/VoiceModal.tsx`
- Modify: `app/src/features/voice/VoiceModal.turn.test.tsx`

**Interfaces:**

- Consumes: the current scoped galaxy snapshot and VoiceModal session account/project identity.
- Produces: compact live graph between transcript and Command Center or an accessible unavailable state.

- [ ] Add RED tests for exact placement, hairline separation, identity matching, compact mode, keyboard fallback and no-map state.
- [ ] Run the focused VoiceModal tests and confirm the new expectations fail.
- [ ] Integrate the compact renderer without changing transcript, STT/TTS, Command Center or voice lifecycle behavior.
- [ ] Rerun VoiceModal tests and require PASS.

### Task 5: Closure

**Files:**

- Review only the exact files listed above.

- [ ] Run focused layout/component/activity/ContextPage/VoiceModal tests.
- [ ] Run scoped TypeScript diagnostics and exact-file Prettier/diff checks.
- [ ] Run the production build if focused gates pass; report protected unrelated failures separately.
- [ ] Manually verify 3D orbit/pan/zoom, selection, real activity, compact voice layout, reduced motion, 2D fallback, forced colors, narrow layout and 200% zoom where the environment permits.
- [ ] Review the exact diff for scope, secrets, accidental persistence changes and unrelated churn; update coordination evidence and release only Prompt 40 locks.
