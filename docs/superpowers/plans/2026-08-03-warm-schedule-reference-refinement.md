# Warm Schedule Reference Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the approved Warm Schedule reference without changing Schedule behavior or other themes.

**Architecture:** Keep the existing Schedule component tree and data flow. Add only stable semantic markers needed to target the Warm empty timeline and primary save action, then compose the center and footer artwork as separate CSS layers with native aspect ratios and bounded responsive sizes.

**Tech Stack:** React, TypeScript, Tailwind utility classes, scoped CSS, Vitest, Vite.

## Global Constraints

- Preserve all scheduling controls, values, handlers, persistence, and responsive structure.
- Limit implementation to Warm Schedule styling and its focused contract.
- Do not add dependencies or remote image requests.
- Keep artwork bundled, responsive, uncropped, and inert.

---

### Task 1: Warm Schedule contract

**Files:**

- Modify: `app/src/features/appearance/warmTheme.test.ts`

**Interfaces:**

- Consumes: `SchedulePage.tsx`, `warm-theme.css`, bundled Schedule assets.
- Produces: a regression contract for the two-layer composition and primary action treatment.

- [ ] **Step 1: Write the failing test**

Assert that the empty timeline exposes a Warm semantic hook; the center and
footer images are separate, native-ratio background layers; the empty copy has
reference-aligned spacing; and the event save action uses a solid terracotta
Warm treatment.

- [ ] **Step 2: Run the focused test**

Run:

```powershell
npx vitest run src/features/appearance/warmTheme.test.ts
```

Expected: failure because the new Schedule contract is not yet implemented.

### Task 2: Schedule-only implementation

**Files:**

- Modify: `app/src/features/schedule/SchedulePage.tsx`
- Modify: `app/src/styles/warm-theme.css`
- Modify only if resolution evidence requires it:
  - `app/public/assets/themes/warm/reference/scheduler-center.png`
  - `app/public/assets/themes/warm/reference/scheduler-landscape.jpg`

**Interfaces:**

- Consumes: existing Schedule timeline empty state and event-save button.
- Produces: Warm-only semantic targeting and the reference-aligned two-layer composition.

- [ ] **Step 1: Add bounded semantic markers**

Mark only the empty timeline content and the existing event save button. Do not
change hierarchy, handlers, copy, or control behavior.

- [ ] **Step 2: Implement Warm paint**

Use `scheduler-center.png` beneath the calendar icon and
`scheduler-landscape.jpg` as the bottom footer. Preserve their aspect ratios,
avoid clipping, blend both into the shared ivory surface, and override the
existing event save gradient with a solid terracotta action.

- [ ] **Step 3: Run the focused contract**

Run:

```powershell
npx vitest run src/features/appearance/warmTheme.test.ts
```

Expected: pass.

### Task 3: Regression and visual evidence

**Files:**

- Verify only the files listed above.

**Interfaces:**

- Consumes: the completed Warm Schedule implementation.
- Produces: test, build, and live visual evidence.

- [ ] **Step 1: Run focused regressions**

Run the Warm appearance and Schedule test files only.

- [ ] **Step 2: Run the production build**

Run:

```powershell
npx vite build
```

- [ ] **Step 3: Compare the live app**

Open Warm → Schedule in the local browser, capture the active desktop viewport,
and compare illustration placement, clipping, copy spacing, surface blending,
and action color against the approved reference.
