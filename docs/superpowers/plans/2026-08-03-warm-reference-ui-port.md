# Warm Reference UI Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the partial Warm appearance with a high-fidelity, production-safe port of the supplied Warm reference.

**Architecture:** Keep production behavior intact and bind a centralized Warm token/primitives layer to existing semantic route and surface markers. Extract the reference artwork byte-for-byte and render it only through inert, state-aware decorative hosts.

**Tech Stack:** React 18, TypeScript, CSS custom properties, Vitest, Testing Library, Vite, Tauri WebView.

## Global Constraints

- Production behavior and data flow are authoritative.
- `index(12).html` and supplied screenshots are authoritative for appearance.
- Do not change backend, state, API, Tauri, terminal, file, agent, scheduler, billing, authentication, or account behavior.
- Preserve labels, handlers, accessibility semantics, test IDs, focus order, deep links, and native window behavior.
- Keep Default, Monochrome, and Jarvis unchanged.
- Decorative assets use `pointer-events: none` and never cover live content.
- Motion is 140–220ms and respects `prefers-reduced-motion`.
- No new dependencies.

---

### Task 1: Exact reference asset library

**Files:**
- Create: `scripts/warm-reference/extract-assets.ps1`
- Create: `app/public/assets/themes/warm/reference/*`
- Modify: `app/public/assets/themes/warm/manifest.json`
- Test: `app/src/features/appearance/warmTheme.test.ts`

**Interfaces:**
- Consumes: the eleven `data:image/*;base64` payloads in the supplied HTML.
- Produces: stable files and SHA-256 entries consumed by route styling.

- [ ] **Step 1: Write the failing asset contract**

```ts
expect(referenceAssets).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ id: 'chat-notebook', sha256: '305213ee…' }),
    expect.objectContaining({ id: 'files-stationery', sha256: '9121cb53…' }),
  ]),
);
```

- [ ] **Step 2: Run the contract and verify it fails**

Run: `npx vitest run src/features/appearance/warmTheme.test.ts`

- [ ] **Step 3: Extract the exact payloads**

The extraction script maps payloads by their surrounding reference element:
brand, chat, files, scheduler center, scheduler landscape, skills corner,
skills landscape, tools corner, tools landscape, Kanban checklist, and Kanban
milestone. It writes decoded bytes without image recompression and records
length plus SHA-256.

- [ ] **Step 4: Run the contract and verify it passes**

Run: `npx vitest run src/features/appearance/warmTheme.test.ts`

### Task 2: Shared Warm shell and primitive parity

**Files:**
- Modify: `app/src/styles/warm-theme.css`
- Test: `app/src/features/appearance/warmTheme.test.ts`
- Test: `app/src/components/layout/AppShell.sakura.test.tsx`
- Test: `app/src/components/layout/TabStrip.test.tsx`

**Interfaces:**
- Consumes: existing shell semantic markers.
- Produces: exact scoped tokens, shell geometry, grain, paper cards, fields,
  buttons, chips, focus, scrolling, responsive behavior, and reduced motion.

- [ ] **Step 1: Add RED assertions for reference tokens and isolation**

```ts
expect(css).toContain('--warm-sidebar-w: 320px');
expect(css).toContain('--warm-top-h: 65px');
expect(css).toContain('--warm-tabs-h: 50px');
expect(css).toMatch(/html\[data-theme='warm'\].*data-nav-pane/s);
expect(css).not.toMatch(/data-theme='(?:monochrome|jarvis|default)'/);
```

- [ ] **Step 2: Implement scoped shell and primitive CSS**

Use the exact palette and material recipes from the master prompt. Preserve
production geometry where native chrome requires a bounded adaptation.

- [ ] **Step 3: Run shell and appearance tests**

Run: `npx vitest run src/features/appearance/warmTheme.test.ts src/components/layout/AppShell.sakura.test.tsx src/components/layout/TabStrip.test.tsx`

### Task 3: Referenced route parity

**Files:**
- Modify: `app/src/styles/warm-theme.css`
- Modify only if required for state markers: `app/src/features/chat/OrigamiChatDecor.tsx`
- Modify only if required for state markers: `app/src/features/files/FilesPage.tsx`
- Modify only if required for state markers: `app/src/features/kanban/KanbanPage.tsx`
- Modify only if required for state markers: `app/src/features/schedule/SchedulePage.tsx`
- Modify only if required for state markers: `app/src/features/skills/SkillsPage.tsx`
- Modify only if required for state markers: `app/src/features/tools/ToolsPage.tsx`
- Test: route-specific existing tests plus `warmTheme.test.ts`

**Interfaces:**
- Consumes: exact extracted artwork and real route state.
- Produces: reference-aligned Chat, Files, Kanban, Scheduler, Skills, and Tools
  surfaces without mock data or duplicate controls.

- [ ] **Step 1: Add RED route/state contracts**

Assert each route owns its designated assets, art hosts are `aria-hidden`,
populated-state selectors suppress conflicting artwork, and no route selector
targets message payload or terminal row content.

- [ ] **Step 2: Implement route-specific compositions**

Apply the reference geometry and hierarchy through existing markers. Add only
truthful `data-*` state markers where CSS cannot infer empty/populated state.

- [ ] **Step 3: Run affected functional regressions**

Run focused Chat, Files, Kanban, Schedule, Skills, and Tools tests.

### Task 4: Non-reference route extension

**Files:**
- Modify: `app/src/styles/warm-theme.css`
- Test: `app/src/features/appearance/warmTheme.test.ts`

**Interfaces:**
- Consumes: existing route/surface markers for Settings, Workbench, Terminals,
  Benchmarks, History, Agents, profile/account, inspectors, dialogs, and
  remaining routes.
- Produces: one coherent Warm design grammar without behavior changes.

- [ ] **Step 1: Add RED coverage assertions**

```ts
for (const route of ['settings', 'workbench', 'terminal', 'benchmarks', 'history', 'agents']) {
  expect(css).toContain(`data-monochrome-route='${route}'`);
}
```

- [ ] **Step 2: Add pattern-specific scoped styling**

Dense data uses paper panels and thin dividers; editors retain split panes;
timelines use Scheduler grammar; code and terminal payloads remain dark and
unfiltered inside Warm chrome.

- [ ] **Step 3: Run route and accessibility regressions**

Run existing focused tests for Settings, Workbench, Terminals, Benchmarks,
History, Agents, dialogs, and shared shell keyboard behavior.

### Task 5: Visual and production verification

**Files:**
- Create: `artifacts/warm-reference/<route>/<viewport>.png`
- Create: `artifacts/warm-reference/<route>/<viewport>-diff.png` where possible
- Modify: coordination records only

**Interfaces:**
- Consumes: the running PR31 application and rendered reference.
- Produces: honest screenshot evidence and a route/control preservation report.

- [ ] **Step 1: Run TypeScript and production build**

Run: `npm run typecheck`

Run: `npm run build`

- [ ] **Step 2: Capture reference and production screenshots**

Capture Chat, Files, Kanban, Scheduler, Skills, and Tools at 1672×941, then all
routes at 1440×900, 1280×800, and one supported narrow viewport.

- [ ] **Step 3: Perform three visual correction passes**

Correct geometry, typography, color/material, assets, then fine spacing in that
order. Do not report visual parity without saved evidence.

- [ ] **Step 4: Verify live production behaviors**

Check route navigation, sidebar collapse, tab controls, keyboard focus,
dialogs, chat controls, terminal focus/input, file flow, scheduler, Kanban,
skills, tools, agents, settings, native window controls, and console errors.

- [ ] **Step 5: Final hygiene**

Run scoped Prettier, `git diff --check`, focused tests, TypeScript, build, and
an added-line secret scan. Record limitations honestly.
