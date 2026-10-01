# VibeSpace Cinematic Concepts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build five isolated three-scene cinematic VibeSpace website direction proofs and one browser comparison hub without changing the existing production website.

**Architecture:** A dependency-free preview package owns a shared concept catalog, a scroll-to-scene engine, and one Canvas renderer with five deliberately different visual grammars. Five thin HTML entrypoints identify the selected world; the comparison hub switches between them in an iframe and exposes direct links.

**Tech Stack:** Semantic HTML, modern CSS, Canvas 2D, ES modules, Node's built-in test runner, connected Edge browser.

## Global Constraints

- Do not modify `site/**`, production hosting, or the current domain.
- Do not add dependencies or change a lockfile.
- Build exactly five worlds: Aperture OS, Infinite Desk, Context Cosmos, Agent Foundry, and Living Archive.
- Every world has exactly three chapters: awakening, orchestration, and release.
- Make Download VibeSpace the final action.
- Respect keyboard navigation, narrow screens, and `prefers-reduced-motion`.
- Defer `website-next/**`, `DESIGN.md`, and the personal skill until the user selects a world.

---

### Task 1: Contract and comparison shell

**Files:**
- Create: `previews/cinematic-site-concepts/tests/concepts.test.mjs`
- Create: `previews/cinematic-site-concepts/concepts.mjs`
- Create: `previews/cinematic-site-concepts/index.html`
- Create: `previews/cinematic-site-concepts/hub.mjs`

**Interfaces:**
- Produces: `CONCEPTS`, `CONCEPT_ORDER`, and `getConcept(id)` from `concepts.mjs`.
- Produces: comparison buttons using `data-concept-target` and iframe `#concept-frame`.

- [ ] **Step 1: Write the failing catalog and hub tests**

```js
test('exports five unique three-scene worlds', async () => {
  const { CONCEPT_ORDER, CONCEPTS } = await import('../concepts.mjs');
  assert.equal(CONCEPT_ORDER.length, 5);
  for (const id of CONCEPT_ORDER) assert.equal(CONCEPTS[id].scenes.length, 3);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: FAIL because `concepts.mjs` and the hub do not exist.

- [ ] **Step 3: Implement the catalog and accessible comparison shell**

Define exact concept IDs `aperture`, `desk`, `cosmos`, `foundry`, and `archive`. Give every concept its own palette, type treatment, material vocabulary, signature, and three-scene copy. Make the hub's five buttons update the iframe, selected state, direct-open link, concept summary, and URL hash.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: PASS.

### Task 2: Shared cinematic runtime

**Files:**
- Create: `previews/cinematic-site-concepts/cinematic.mjs`
- Create: `previews/cinematic-site-concepts/concept.css`
- Modify: `previews/cinematic-site-concepts/tests/concepts.test.mjs`

**Interfaces:**
- Produces: `clamp(value, min, max)`, `resolveJourney(scrollY, viewportHeight, pageHeight)`, and `resolveScene(progress, count)`.
- Consumes: `getConcept(document.body.dataset.concept)`.

- [ ] **Step 1: Add failing scroll-mapping and fallback tests**

Test clamping, start/end progress, three-scene boundaries, reduced-motion CSS, and the presence of one fixed Canvas stage plus semantic chapter content.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: FAIL because the runtime and stylesheet do not exist.

- [ ] **Step 3: Implement the runtime**

Map native document scroll to normalized progress through `requestAnimationFrame`. Render decorative Canvas frames at capped DPR, update CSS variables for stage transforms, expose the current scene through `data-scene`, pause when hidden, and render a static midpoint frame when reduced motion is active.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: PASS.

### Task 3: Five world entrypoints and visual grammars

**Files:**
- Create: `previews/cinematic-site-concepts/aperture.html`
- Create: `previews/cinematic-site-concepts/infinite-desk.html`
- Create: `previews/cinematic-site-concepts/context-cosmos.html`
- Create: `previews/cinematic-site-concepts/agent-foundry.html`
- Create: `previews/cinematic-site-concepts/living-archive.html`
- Modify: `previews/cinematic-site-concepts/cinematic.mjs`
- Modify: `previews/cinematic-site-concepts/concept.css`
- Modify: `previews/cinematic-site-concepts/tests/concepts.test.mjs`

**Interfaces:**
- Each entrypoint sets one valid `data-concept`, provides `.cinematic-stage`, `#world-canvas`, three `.journey-copy` chapters, and loads the shared runtime.
- The renderer dispatches to five bounded functions keyed by concept ID.

- [ ] **Step 1: Add failing entrypoint-contract tests**

Assert all five files exist, identify the correct concept, contain exactly three semantic chapters, expose a final Download VibeSpace link, and load the shared runtime.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: FAIL because the entrypoints and renderer dispatch do not exist.

- [ ] **Step 3: Implement the five worlds**

Render:

- Aperture: nested portals, architectural window planes, copper horizon.
- Infinite Desk: perspective desk grid, tactile tools, expanding workspace.
- Context Cosmos: constellation nodes, orbit paths, UI-node dive.
- Agent Foundry: production rails, agent cores, completed artifact.
- Living Archive: branching fibers, memory seeds, illuminated recall canopy.

Keep DOM copy crisp and use Canvas only for decorative spatial imagery.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test previews/cinematic-site-concepts/tests/concepts.test.mjs`

Expected: PASS.

### Task 4: Browser acceptance and handoff

**Files:**
- Modify only if RED evidence requires it: `previews/cinematic-site-concepts/**`

**Interfaces:**
- Serves the preview package at `http://127.0.0.1:4179/`.
- Leaves one comparison-hub tab open as a deliverable.

- [ ] **Step 1: Run static and diff verification**

Run:

```powershell
node --test previews/cinematic-site-concepts/tests/concepts.test.mjs
git diff --check -- previews/cinematic-site-concepts docs/superpowers/plans/2026-08-02-vibespace-cinematic-concepts.md
```

- [ ] **Step 2: Start a bounded local static server**

Use the repository's available Node runtime on port `4179`, with the process rooted at `previews/cinematic-site-concepts`.

- [ ] **Step 3: Inspect the hub and every world in Edge**

Verify desktop and narrow layouts, all concept switches, scroll-driven scene changes, direct links, keyboard focus, reduced-motion fallback, and zero console errors. Capture screenshots for visual self-critique.

- [ ] **Step 4: Hand off the browser tab**

Keep the comparison hub as a deliverable tab. Stop the local server only after the user has finished choosing a concept or explicitly asks to close it.
