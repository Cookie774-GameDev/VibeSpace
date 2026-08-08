# VibeSpace Cinematic Worlds V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three desktop-only, seven-act cinematic VibeSpace website
proofs—First Contact, The Memory Forest, and The Machine Opera—with cohesive
generated art, real loading progress, continuous scroll-camera motion, pointer
physics, optional procedural sound, and a curatorial comparison gallery.

**Architecture:** A static, dependency-free site uses one shared declarative
world catalog and one shared cinematic runtime. Pure modules own loader
progress, timeline mapping, spring motion, and act resolution; the browser
runtime owns a single animation loop, DOM composition, plate transitions,
Canvas effects, pointer input, and Web Audio. Each world supplies its own seven
acts, palette, asset manifest, copy, motion grammar, and renderer theme.

**Tech Stack:** Semantic HTML, modern CSS, native ES modules, Canvas 2D with
CSS 3D plate compositing, Web Audio, Node's built-in test runner, generated
project-owned WebP/PNG assets, connected Edge browser.

## Global Constraints

- Build only under `previews/cinematic-site-concepts-v2/**`.
- Preserve `previews/cinematic-site-concepts/**`, `site/**`, and
  `website-next/**` unchanged.
- Do not add npm dependencies or modify lockfiles.
- Deliver desktop cinema for viewports at or above 1100 CSS pixels.
- Narrow screens receive the reduced-motion editorial fallback.
- Every world has exactly seven acts over at least ten viewport-heights.
- The loader is asset-driven and cannot report 100 before critical assets are
  decoded and fonts/rendering are ready.
- Sound starts only after an explicit visitor gesture.
- Use one bounded animation-frame loop per open world and stop it when hidden.
- Final `DESIGN.md` and personal `SKILL.md` remain gated on user grading.
- Do not deploy, publish, push, or mutate the production domain.

---

## File Structure

```text
previews/cinematic-site-concepts-v2/
  index.html                     Curatorial gallery shell
  gallery.css                    Gallery-only visual system
  gallery.mjs                    Gallery rendering and navigation
  first-contact.html             First Contact entrypoint
  memory-forest.html             Memory Forest entrypoint
  machine-opera.html             Machine Opera entrypoint
  experience.css                 Shared full-screen cinematic layout
  worlds.mjs                     Declarative catalog and seven-act manifests
  runtime/
    math.mjs                     Clamp, interpolation, easing, act mapping
    preload.mjs                  Asset/font readiness progress
    timeline.mjs                 Spring scroll state and deterministic frames
    renderer.mjs                 Canvas atmosphere and plate composition state
    sound.mjs                    Gesture-gated procedural score
    experience.mjs              DOM lifecycle and one-loop orchestration
  assets/
    first-contact/               Seven plates, poster, texture
    memory-forest/               Seven plates, poster, texture
    machine-opera/               Seven plates, poster, texture
  tests/
    cinematic-v2.test.mjs       Catalog, routes, runtime, and asset contracts
```

### Interfaces

```js
// worlds.mjs
export const WORLD_ORDER;
export const WORLDS;
export function getWorld(id);

// runtime/math.mjs
export function clamp(value, min, max);
export function lerp(from, to, amount);
export function smoothstep(edge0, edge1, value);
export function resolveAct(progress, count);

// runtime/preload.mjs
export function createProgressTracker(total);
export async function preloadCritical({ images, fonts, onProgress });

// runtime/timeline.mjs
export function createSpringState(initial);
export function stepSpring(state, target, deltaSeconds, options);
export function computeTimelineFrame(progress, world);

// runtime/renderer.mjs
export function createWorldRenderer({ canvas, world, plates });

// runtime/sound.mjs
export function createWorldScore(worldId);
```

---

### Task 1: Declarative World Contract and Static Entrypoints

**Files:**

- Create: `previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs`
- Create: `previews/cinematic-site-concepts-v2/worlds.mjs`
- Create: `previews/cinematic-site-concepts-v2/index.html`
- Create: `previews/cinematic-site-concepts-v2/first-contact.html`
- Create: `previews/cinematic-site-concepts-v2/memory-forest.html`
- Create: `previews/cinematic-site-concepts-v2/machine-opera.html`

**Interfaces:**

- Produces `WORLD_ORDER`, `WORLDS`, and `getWorld(id)` for every later task.
- Produces the exact IDs `first-contact`, `memory-forest`, and
  `machine-opera`.

- [ ] **Step 1: Write the failing catalog and entrypoint tests**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../', import.meta.url);
const ENTRIES = {
  'first-contact': 'first-contact.html',
  'memory-forest': 'memory-forest.html',
  'machine-opera': 'machine-opera.html',
};

test('catalog defines three visually independent seven-act worlds', async () => {
  const { WORLD_ORDER, WORLDS, getWorld } = await import('../worlds.mjs');
  assert.deepEqual(WORLD_ORDER, Object.keys(ENTRIES));
  assert.equal(Object.keys(WORLDS).length, 3);
  assert.equal(new Set(WORLD_ORDER.map((id) => WORLDS[id].signature)).size, 3);
  assert.equal(new Set(WORLD_ORDER.map((id) => WORLDS[id].displayFont)).size, 3);
  for (const id of WORLD_ORDER) {
    assert.equal(getWorld(id), WORLDS[id]);
    assert.equal(WORLDS[id].acts.length, 7);
    assert.equal(WORLDS[id].assets.plates.length, 7);
    assert.match(WORLDS[id].downloadUrl, /releases\/latest$/);
  }
});

test('every full-screen entrypoint exposes the cinematic lifecycle', async () => {
  for (const [id, file] of Object.entries(ENTRIES)) {
    const html = await readFile(new URL(file, ROOT), 'utf8');
    assert.match(html, new RegExp(`<body[^>]+data-world="${id}"`));
    assert.match(html, /data-loader-progress>000%/);
    assert.match(html, /Enter with sound/);
    assert.match(html, /Enter silently/);
    assert.match(html, /id="world-canvas"/);
    assert.match(html, /runtime\/experience\.mjs/);
  }
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```powershell
node --test previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs
```

Expected: FAIL because `worlds.mjs` and the four HTML entrypoints do not exist.

- [ ] **Step 3: Implement the minimal catalog and semantic shells**

Define all three manifests with exact palette, typography, loader vocabulary,
seven acts, seven asset paths, progress instrument, renderer theme, score theme,
and download URL. Build one gallery shell and three entrypoints that contain:

```html
<div class="loader" data-loader>
  <span data-loader-label>Acquiring transmission</span>
  <output data-loader-progress>000%</output>
</div>
<div class="entry-gate" data-entry-gate hidden>
  <button type="button" data-enter-sound>Enter with sound</button>
  <button type="button" data-enter-silent>Enter silently</button>
</div>
<main class="experience" data-experience aria-live="polite">
  <canvas id="world-canvas" aria-hidden="true"></canvas>
  <div class="plate-stack" data-plate-stack aria-hidden="true"></div>
  <div class="act-copy" data-act-copy></div>
</main>
```

- [ ] **Step 4: Run the tests and confirm GREEN**

Run:

```powershell
node --test previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit the contract and shells**

```powershell
git add -- previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs previews/cinematic-site-concepts-v2/worlds.mjs previews/cinematic-site-concepts-v2/index.html previews/cinematic-site-concepts-v2/first-contact.html previews/cinematic-site-concepts-v2/memory-forest.html previews/cinematic-site-concepts-v2/machine-opera.html
git commit -m "feat: define three cinematic v2 worlds"
```

---

### Task 2: Pure Cinematic Math, Loader, and Timeline

**Files:**

- Modify: `previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/math.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/preload.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/timeline.mjs`

**Interfaces:**

- Consumes the world manifest shape from Task 1.
- Produces deterministic progress and frame state for the browser runtime.

- [ ] **Step 1: Add failing math, progress, and spring tests**

```js
test('act resolution preserves endpoints and reversible local progress', async () => {
  const { resolveAct } = await import('../runtime/math.mjs');
  assert.deepEqual(resolveAct(0, 7), { index: 0, local: 0 });
  assert.deepEqual(resolveAct(0.5, 7), { index: 3, local: 0.5 });
  assert.deepEqual(resolveAct(1, 7), { index: 6, local: 1 });
  assert.deepEqual(resolveAct(0.5, 7), resolveAct(0.5, 7));
});

test('progress tracker reaches 100 only after every critical item settles', async () => {
  const { createProgressTracker } = await import('../runtime/preload.mjs');
  const tracker = createProgressTracker(3);
  assert.equal(tracker.percent(), 0);
  tracker.complete('plate-1');
  tracker.complete('plate-1');
  assert.equal(tracker.percent(), 33);
  tracker.complete('plate-2');
  assert.equal(tracker.percent(), 67);
  tracker.complete('renderer');
  assert.equal(tracker.percent(), 100);
});

test('spring state converges without overshooting bounded progress', async () => {
  const { createSpringState, stepSpring } = await import('../runtime/timeline.mjs');
  let state = createSpringState(0);
  for (let frame = 0; frame < 180; frame += 1) {
    state = stepSpring(state, 1, 1 / 60, { stiffness: 115, damping: 22 });
    assert.ok(state.value >= 0 && state.value <= 1);
  }
  assert.ok(Math.abs(state.value - 1) < 0.001);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Expected: FAIL with module-not-found errors for `runtime/math.mjs`,
`runtime/preload.mjs`, and `runtime/timeline.mjs`.

- [ ] **Step 3: Implement deterministic pure modules**

Implement endpoint-safe act mapping, duplicate-resistant progress tracking, a
critically damped spring with clamped progress, and `computeTimelineFrame()`:

```js
export function computeTimelineFrame(progress, world) {
  const act = resolveAct(progress, world.acts.length);
  return {
    progress: clamp(progress, 0, 1),
    actIndex: act.index,
    local: act.local,
    plateA: act.index,
    plateB: Math.min(act.index + 1, world.acts.length - 1),
    blend: smoothstep(0.62, 0.94, act.local),
  };
}
```

- [ ] **Step 4: Run the full test file and confirm GREEN**

Expected: 5 tests pass.

- [ ] **Step 5: Commit the pure runtime**

```powershell
git add -- previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs previews/cinematic-site-concepts-v2/runtime/math.mjs previews/cinematic-site-concepts-v2/runtime/preload.mjs previews/cinematic-site-concepts-v2/runtime/timeline.mjs
git commit -m "feat: add cinematic loader and timeline physics"
```

---

### Task 3: Generate and Encode the Three Cohesive Art Systems

**Files:**

- Create: `previews/cinematic-site-concepts-v2/assets/first-contact/**`
- Create: `previews/cinematic-site-concepts-v2/assets/memory-forest/**`
- Create: `previews/cinematic-site-concepts-v2/assets/machine-opera/**`
- Modify: `previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs`

**Interfaces:**

- Consumes exact asset paths from `worlds.mjs`.
- Produces seven encoded scene plates and one texture per world.

- [ ] **Step 1: Add a failing asset-manifest integrity test**

```js
test('every declared cinematic asset exists and is browser-sized', async () => {
  const { stat } = await import('node:fs/promises');
  const { WORLDS } = await import('../worlds.mjs');
  for (const world of Object.values(WORLDS)) {
    for (const relativePath of [...world.assets.plates, world.assets.texture]) {
      const info = await stat(new URL(`../${relativePath}`, import.meta.url));
      assert.ok(info.size > 50_000, `${relativePath} is not a final visual asset`);
      assert.ok(info.size < 2_500_000, `${relativePath} exceeds the delivery budget`);
    }
  }
});
```

- [ ] **Step 2: Run the asset test and confirm RED**

Expected: FAIL with `ENOENT` for the first declared plate.

- [ ] **Step 3: Generate one approved master image per world**

Use the built-in image-generation tool with the exact art-direction preambles
from the design specification. Save the selected masters into each world's
asset directory as `scene-01-master.png`. Inspect each output before continuing.

- [ ] **Step 4: Generate six consistent derivatives per world**

Use the corresponding master as a visual reference for acts 2–7. Repeat the
world's material, lens, lighting, recurring-object, and negative constraints in
every edit request. Do not accept images containing pseudo-text, watermarks,
unrelated machinery, generic UI panels, or drift from the master object.

- [ ] **Step 5: Encode browser delivery assets**

Encode each approved plate to WebP without resizing below 1920×1080:

```powershell
magick input.png -resize "2560x1440>" -quality 82 output.webp
```

If ImageMagick is unavailable, use Pillow with `quality=82`, `method=6`, and
preserve the 16:9 crop. Keep the final encoded file under 2.5 MB.

- [ ] **Step 6: Create one world texture from each master**

Use a cropped, blurred, monochrome detail from the approved master, encoded as
`texture.webp`. It must remain above 50 KB and below 2.5 MB.

- [ ] **Step 7: Run the asset test and visually inspect all 21 plates**

Expected: the asset integrity test passes and each world's seven plates read as
one material and lens system.

- [ ] **Step 8: Commit project-owned art**

```powershell
git add -- previews/cinematic-site-concepts-v2/assets previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs
git commit -m "feat: add cinematic world art systems"
```

---

### Task 4: Renderer, Experience Lifecycle, and Full Visual Systems

**Files:**

- Modify: `previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/renderer.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/experience.mjs`
- Create: `previews/cinematic-site-concepts-v2/experience.css`
- Modify: the three world entrypoint HTML files

**Interfaces:**

- Consumes Tasks 1–3.
- Produces the loader-to-gate-to-scroll-world lifecycle.

- [ ] **Step 1: Add failing renderer and lifecycle behavior contracts**

Assert that starting the same lifecycle twice still owns one scheduled frame,
that hiding cancels it, and that resuming schedules one new frame:

```js
test('loop controller never owns more than one animation frame', async () => {
  const { createLoopController } = await import('../runtime/experience.mjs');
  let nextId = 0;
  const pending = new Set();
  const loop = createLoopController({
    requestFrame(callback) {
      const id = ++nextId;
      pending.add(id);
      return id;
    },
    cancelFrame(id) {
      pending.delete(id);
    },
    onFrame() {},
  });

  loop.start();
  loop.start();
  assert.equal(pending.size, 1);
  loop.pause();
  assert.equal(pending.size, 0);
  loop.resume();
  assert.equal(pending.size, 1);
  loop.destroy();
  assert.equal(pending.size, 0);
});
```

The three HTML entrypoint behavior test from Task 1 remains responsible for
proving that the runtime and stylesheet are actually consumed.

- [ ] **Step 2: Run the tests and confirm RED**

Expected: FAIL because renderer, lifecycle, and CSS files do not exist.

- [ ] **Step 3: Implement the shared plate and atmosphere renderer**

`createWorldRenderer()` must:

- cap device pixel ratio at 1.5;
- composite only the current and neighboring plate;
- update plate transform, opacity, clip, blur, and color state;
- draw world-specific atmosphere on Canvas;
- accept `{ frame, pointer, velocity, time }`;
- expose `resize()`, `render()`, and `destroy()`;
- never schedule its own animation frame.

- [ ] **Step 4: Implement the experience lifecycle**

The lifecycle must:

- preload the seven plates and fonts;
- render `000%`–`100%` from real tracker progress;
- expose the sound/silent gate only after preload;
- mount semantic seven-act copy;
- map native scroll to the spring timeline;
- own exactly one animation frame ID;
- pause while hidden and resume without a progress jump;
- update `data-active-act`, progress instrument, and copy;
- destroy all listeners and audio on page exit.

- [ ] **Step 5: Implement the three visual systems in CSS**

Use world-scoped tokens and layouts. First Contact uses large void and radial
gravity compositions. Memory Forest uses specimen labels, deep vertical
layers, and growth masks. Machine Opera uses a bright gallery, stage notation,
and strong horizontal causal travel. Do not reuse the same title position,
progress instrument placement, or plate border treatment across worlds.

- [ ] **Step 6: Run the full tests and confirm GREEN**

Expected: all source and runtime tests pass.

- [ ] **Step 7: Commit renderer and visual systems**

```powershell
git add -- previews/cinematic-site-concepts-v2/runtime previews/cinematic-site-concepts-v2/experience.css previews/cinematic-site-concepts-v2/*.html previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs
git commit -m "feat: build cinematic scroll experience runtime"
```

---

### Task 5: Gesture-Gated Scores and Curatorial Gallery

**Files:**

- Modify: `previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs`
- Create: `previews/cinematic-site-concepts-v2/runtime/sound.mjs`
- Create: `previews/cinematic-site-concepts-v2/gallery.css`
- Create: `previews/cinematic-site-concepts-v2/gallery.mjs`
- Modify: `previews/cinematic-site-concepts-v2/index.html`
- Modify: `previews/cinematic-site-concepts-v2/runtime/experience.mjs`

**Interfaces:**

- Adds sound to the shared lifecycle without changing pure timeline behavior.
- Produces the grading handoff route.

- [ ] **Step 1: Add failing sound and gallery behavior tests**

```js
test('procedural score remains gesture-gated and destroyable', async () => {
  const { createWorldScore } = await import('../runtime/sound.mjs');
  let contextsCreated = 0;
  const fakeContext = {
    currentTime: 0,
    destination: {},
    createGain() {
      return {
        gain: {
          value: 0,
          cancelScheduledValues() {},
          linearRampToValueAtTime() {},
          setValueAtTime() {},
        },
        connect() {},
      };
    },
    createDynamicsCompressor() { return { connect() {} }; },
    createOscillator() {
      return {
        type: 'sine',
        frequency: { value: 0 },
        detune: { value: 0 },
        connect() {},
        start() {},
        stop() {},
      };
    },
    async resume() {},
    async close() {},
  };
  const score = createWorldScore('first-contact', {
    createContext() {
      contextsCreated += 1;
      return fakeContext;
    },
  });

  assert.equal(contextsCreated, 0);
  await score.start();
  assert.equal(contextsCreated, 1);
  score.setMuted(true);
  await score.destroy();
});

test('gallery links directly to the three full-screen worlds', async () => {
  const html = await readFile(new URL('../index.html', ROOT), 'utf8');
  for (const file of Object.values(ENTRIES)) {
    assert.match(html, new RegExp(`href="${file}"`));
  }
  assert.equal((html.match(/class="world-portal"/g) || []).length, 3);
  assert.doesNotMatch(html, /iframe/);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Expected: FAIL because `sound.mjs`, gallery behavior, and direct portal markup
are missing.

- [ ] **Step 3: Implement three procedural scores**

Create one lazy `AudioContext` only in `start()`. Use a master gain, compressor,
and world-specific oscillator/noise graph. Expose progress and velocity update
methods so sound follows the same timeline without controlling it. `setMuted`
must ramp the gain and `destroy()` must stop nodes and close the context.

- [ ] **Step 4: Implement the quiet comparison gallery**

Render three full-width portals with generated poster art, exact thesis,
material specimen, and direct **Enter world** link. Use world-specific hover
camera responses but no autonomous particle canvas and no embedded iframes.

- [ ] **Step 5: Run all tests and confirm GREEN**

Expected: all catalog, entrypoint, runtime, asset, sound, and gallery tests pass.

- [ ] **Step 6: Commit sound and gallery**

```powershell
git add -- previews/cinematic-site-concepts-v2
git commit -m "feat: add cinematic scores and grading gallery"
```

---

### Task 6: Browser QA, Performance, and Handoff

**Files:**

- Modify only owned V2 files for defects reproduced during QA.
- Update:
  `C:\Users\viper\VibeSpace\.worktrees\pr30-fixes-updates-20260802\.agent-coordination.lock\owner.txt`
- Update:
  `C:\Users\viper\VibeSpace\docs\orchestration\ACTIVE_STATE.md`

**Interfaces:**

- Consumes the complete static gallery.
- Produces verified local grading state and coordination handoff.

- [ ] **Step 1: Start a hidden local static server**

Serve `previews/cinematic-site-concepts-v2` on an unused loopback port. Confirm
the gallery, three entrypoints, all JavaScript modules, CSS, and every asset
return HTTP 200.

- [ ] **Step 2: Exercise every loader in connected Edge**

Reload each world from an empty page state. Observe a non-decreasing visual
counter beginning at `000%`, reaching `100%`, and revealing the entry gate only
after all critical resources settle.

- [ ] **Step 3: Exercise forward and reverse scroll**

For each world:

- enter silently;
- capture acts 1, 4, and 7;
- perform a fast forward scroll and a slow reverse scroll;
- confirm act state, plate blend, camera, and progress instrument agree;
- confirm no white flash, broken plate, or duplicate-frame-loop symptom.

Write a failing test before repairing any defect found.

- [ ] **Step 4: Exercise pointer and sound**

Confirm pointer travel creates bounded depth without moving controls outside
their hit areas. Reload, choose **Enter with sound**, confirm the score begins
only after the click, toggle mute twice, and leave the page without an audio or
console error.

- [ ] **Step 5: Exercise fallback paths**

Check keyboard scrolling, visible focus, the download link, reduced motion,
1099-pixel editorial mode, and Canvas fallback behavior. Reset temporary
viewport and motion overrides before handoff.

- [ ] **Step 6: Run final static verification**

```powershell
node --test previews/cinematic-site-concepts-v2/tests/cinematic-v2.test.mjs
Get-ChildItem previews/cinematic-site-concepts-v2 -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName }
git diff --check -- previews/cinematic-site-concepts-v2 docs/superpowers/plans/2026-08-02-vibespace-cinematic-worlds-v2.md
```

Expected: zero failing tests, syntax errors, or diff-hygiene findings.

- [ ] **Step 7: Leave the gallery open for grading**

Finalize the connected Edge tab with the V2 gallery as the deliverable. Do not
create the selected-world `DESIGN.md` or personal `SKILL.md`.

- [ ] **Step 8: Record the local handoff**

Mark the task `AWAITING_USER_GRADING`, record fresh test/route/browser evidence,
release the owned paths as protected uncommitted state, and explicitly note that
production, deployment, V1, `website-next`, final `DESIGN.md`, and personal
`SKILL.md` were untouched.
