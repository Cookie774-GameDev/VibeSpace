# VibeSpace Cinematic Product Worlds V3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three complete desktop-only cinematic VibeSpace product websites and a comparison gallery using authentic supplied Warm UI assets.

**Architecture:** A dependency-free shared runtime renders a fixed cinematic stage from declarative concept and product-beat data. Each route owns a distinct scene grammar through a body-level concept key, while shared semantic HTML, smoothing, input, loader, accessibility, and product-detail behavior prevent three disconnected demos. Local copied Warm screenshots are the only bitmap imagery.

**Tech Stack:** HTML5, CSS, SVG, modern browser JavaScript modules, Node.js built-in test runner, local static HTTP server.

## Global Constraints

- Desktop only; show an editorial notice below 1100 CSS pixels.
- Do not generate imagery or add a dependency.
- Do not touch V1, V2, `site/**`, `website-next/**`, product source, or external systems.
- Use the same eight-beat truthful VibeSpace product spine in all three directions.
- VibeSpace Access is $20/month after a non-auto-converting introductory 30-day trial; optional feature plans are separate.
- Support keyboard operation, visible focus, reduced motion, and reversible scroll.

---

### Task 1: Freeze content, routes, and authentic assets

**Files:**
- Create: `previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs`
- Create: `previews/cinematic-site-concepts-v3/runtime/content.mjs`
- Create: `previews/cinematic-site-concepts-v3/assets/product/*.png`

**Interfaces:**
- Produces: `PRODUCT_BEATS`, `CONCEPTS`, `PRICING`, and `getConcept(id)` from `runtime/content.mjs`.
- Produces: stable local product asset URLs consumed by the renderer and tested for existence.

- [ ] **Step 1: Write failing structural contracts**

Create Node tests asserting three concept IDs, eight ordered product beats per concept,
six or more distinct product assets per route, required pricing truth, non-generic copy,
four route files, reduced-motion CSS, and interaction affordances.

- [ ] **Step 2: Run the contract and verify RED**

Run: `node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs`
Expected: FAIL because the V3 runtime and routes do not exist.

- [ ] **Step 3: Copy selected authoritative Warm screenshots**

Copy chat, agents, scheduler, Kanban, files, skills, tools, and terminal/project-context
screens from the supplied Warm directory into `assets/product/` with stable semantic
filenames. Record each source basename and SHA-256 in `assets/product/manifest.json`.

- [ ] **Step 4: Implement shared product and concept data**

Export:

```js
export const PRODUCT_BEATS = Object.freeze([
  { id: "arrival", eyebrow: "Your work, in one place", title: "A workspace that thinks beside you." },
  { id: "jarvis", eyebrow: "Jarvis", title: "Begin with a sentence." },
  { id: "agents", eyebrow: "Focused agents", title: "One task. The right mind." },
  { id: "schedule", eyebrow: "Plans that happen", title: "Say when. It schedules itself." },
  { id: "workspace", eyebrow: "Work without the shuffle", title: "Every working surface stays in reach." },
  { id: "skills", eyebrow: "Skills and tools", title: "Teach the workspace your way." },
  { id: "trust", eyebrow: "Local-first control", title: "Your context stays yours." },
  { id: "access", eyebrow: "VibeSpace Access", title: "Make room for your best work." }
]);
```

- [ ] **Step 5: Run focused tests**

Run: `node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs`
Expected: remaining route/runtime assertions fail, but content and asset assertions pass.

### Task 2: Build the shared cinematic runtime

**Files:**
- Create: `previews/cinematic-site-concepts-v3/runtime/world-engine.mjs`
- Create: `previews/cinematic-site-concepts-v3/runtime/loader.mjs`
- Create: `previews/cinematic-site-concepts-v3/runtime/sound.mjs`
- Create: `previews/cinematic-site-concepts-v3/world.css`

**Interfaces:**
- Consumes: `getConcept(id)` and `PRODUCT_BEATS`.
- Produces: `mountWorld(root, conceptId)`.
- Produces: `mountLoader(root, options)` returning `{ enter, skip, destroy }`.
- Produces: `createAmbientScore()` returning `{ unlock, setProgress, toggle, destroy }`.

- [ ] **Step 1: Implement semantic scene construction**

Render a skip link, loader, header/navigation, fixed stage, eight semantic scene articles,
product-window figures, feature-marker buttons, detail drawer, pricing cards, FAQ note,
final CTA, progress rail, sound control, gallery return, and narrow-screen notice.

- [ ] **Step 2: Implement deterministic smooth progression**

Use one rAF loop with clamped target/current progress:

```js
current += (target - current) * (reducedMotion ? 1 : 0.105);
root.style.setProperty("--world-progress", current.toFixed(5));
```

Map normalized scroll to scene index/local progress, update `aria-current`, and expose
concept-specific CSS variables without replacing DOM content.

- [ ] **Step 3: Add input beyond scroll**

Add pointer-derived `--pointer-x`/`--pointer-y`, keyboard Home/End/PageUp/PageDown and
number-key scene navigation, clickable progress rail, feature marker drawer, Escape close,
and an optional gesture-gated procedural ambient score.

- [ ] **Step 4: Implement visual and accessibility foundation**

Add desktop layout, visible focus, high-contrast copy panels, stable authentic image
framing, reduced-motion transforms, loader skip, sound state, drawer semantics, and
below-1100 editorial notice.

- [ ] **Step 5: Run syntax and contracts**

Run:

```powershell
node --check previews/cinematic-site-concepts-v3/runtime/content.mjs
node --check previews/cinematic-site-concepts-v3/runtime/world-engine.mjs
node --check previews/cinematic-site-concepts-v3/runtime/loader.mjs
node --check previews/cinematic-site-concepts-v3/runtime/sound.mjs
node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs
```

Expected: runtime syntax passes; route assertions remain RED.

### Task 3: Author the three complete worlds

**Files:**
- Create: `previews/cinematic-site-concepts-v3/quiet-ascent.html`
- Create: `previews/cinematic-site-concepts-v3/living-desk.html`
- Create: `previews/cinematic-site-concepts-v3/garden-of-work.html`
- Create: `previews/cinematic-site-concepts-v3/concepts.css`

**Interfaces:**
- Consumes: `mountWorld(document.querySelector("#world"), conceptId)`.
- Produces: routes `quiet-ascent.html`, `living-desk.html`, and `garden-of-work.html`.

- [ ] **Step 1: Create the common route shell**

Each route includes semantic metadata, `world.css`, `concepts.css`, one `#world` main, a
noscript explanation, and a module call with its exact concept ID.

- [ ] **Step 2: Author Quiet Ascent**

Implement layered watercolor mountain SVG/CSS planes, a drawing trail, advancing sun,
wildflower waypoints, depth-traveling product windows, field-note feature drawer, and
summit convergence finale.

- [ ] **Step 3: Author Living Desk**

Implement desk grain, paper/vellum layers, registration marks, folding and stacking product
windows, tabbed paper controls, moving lamp light, folio pricing composition, and closing
folio finale.

- [ ] **Step 4: Author Garden of Work**

Implement a growing central branch, agent buds, schedule sun-path, flowering skill/tool
clusters, proximity-bending stems, specimen detail drawer, garden-map pricing, and overhead
bloom finale.

- [ ] **Step 5: Run contracts**

Run: `node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs`
Expected: all world route, content, pricing, asset, reduced-motion, and interaction
contracts pass except gallery assertions.

### Task 4: Build the grading gallery

**Files:**
- Create: `previews/cinematic-site-concepts-v3/index.html`
- Create: `previews/cinematic-site-concepts-v3/gallery.css`
- Create: `previews/cinematic-site-concepts-v3/gallery.mjs`

**Interfaces:**
- Consumes: `CONCEPTS`.
- Produces: an accessible comparison gallery linking to all three worlds.

- [ ] **Step 1: Build the comparison introduction**

State that all three use identical VibeSpace content and authentic Warm assets, list the
shared grading criteria, and clearly label each concept `01`, `02`, and `03`.

- [ ] **Step 2: Build cinematic concept portals**

Each portal includes a CSS/SVG miniature unique to the concept, its emotional arc,
signature motion, interaction grammar, and a direct “Enter world” link.

- [ ] **Step 3: Add keyboard and pointer polish**

Implement roving arrow-key focus, restrained card perspective, visible focus, reduced
motion, and no auto-navigation.

- [ ] **Step 4: Run the complete contract**

Run: `node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs`
Expected: PASS.

### Task 5: Browser QA and handoff

**Files:**
- Modify only if QA finds a defect: `previews/cinematic-site-concepts-v3/**`
- Modify: coordination records

**Interfaces:**
- Consumes: all V3 routes and assets.
- Produces: verified local grading URL and completion evidence.

- [ ] **Step 1: Start a bounded local server**

Run:

```powershell
python -m http.server 4183 --bind 127.0.0.1 --directory previews/cinematic-site-concepts-v3
```

Expected: gallery at `http://127.0.0.1:4183/`.

- [ ] **Step 2: Verify HTTP and asset delivery**

Request the gallery, all three routes, JavaScript modules, stylesheets, manifest, and every
manifest asset. Expected: HTTP 200 for every target.

- [ ] **Step 3: Exercise browser behavior**

For each world verify loader 0–100/skip, sound choice, forward/reverse scroll, progress
rail, pointer response, feature drawer, Escape, keyboard scene navigation, pricing truth,
final CTA, reduced motion, and a clean console.

- [ ] **Step 4: Capture visual evidence**

Capture opening, product midpoint, pricing, and finale screenshots for all three at a
desktop viewport. Review product legibility, copy contrast, continuity, and concept
distinctness.

- [ ] **Step 5: Run final hygiene**

Run:

```powershell
node --test previews/cinematic-site-concepts-v3/tests/cinematic-v3.test.mjs
git diff --check -- previews/cinematic-site-concepts-v3 docs/superpowers/specs/2026-08-03-vibespace-cinematic-product-worlds-v3-design.md docs/superpowers/plans/2026-08-03-vibespace-cinematic-product-worlds-v3.md
```

Then scan added lines for credential-shaped values and review the full scoped diff.

- [ ] **Step 6: Record completion and release**

Record exact evidence and remaining browser/platform caveats in both coordination records,
mark the task locally complete, release the owned preview/spec/plan paths, and leave all
excluded work untouched.
