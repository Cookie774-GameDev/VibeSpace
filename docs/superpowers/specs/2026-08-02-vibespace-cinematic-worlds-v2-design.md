# VibeSpace Cinematic Worlds V2 Design

**Status:** Approved creative direction; implementation specification pending user review
**Date:** 2026-08-02
**Task:** `VS-PR31-CINEMATIC-V2-20260802T163211Z-ROOT`

## Objective

Create three independent, desktop-only VibeSpace website experiences that feel
like authored cinematic art pieces rather than decorated landing pages:

1. **First Contact**
2. **The Memory Forest**
3. **The Machine Opera**

Each experience must tell the same underlying product story through a different
physical world, camera grammar, material system, typography system, and motion
language. The visitor should remember the experience before they remember an
individual feature card.

The work lives beside the rejected V1 proofs. It does not modify the current
website, product application, production domain, or final `website-next`
implementation.

## Reference Study: What Active Theory Gets Right

The Active Theory reference was inspected in motion, including its loader,
pointer behavior, scroll travel, portfolio stage, persistent navigation, and
scene transitions. The transferable principles are:

- The loader is the first scene. It establishes anticipation and gives the
  world time to become ready.
- The viewport behaves as a camera, not as a document window.
- Scrolling changes position, scale, light, material, and spatial relationships
  continuously instead of triggering disconnected entrance animations.
- Pointer movement adds subtle lens response, parallax, and highlight travel.
  It never turns the experience into a cursor toy.
- Interface chrome stays quiet while the rendered world carries the spectacle.
- Text appears as part of the scene's composition, not as a repeated
  heading-plus-card template.
- Audio is optional and visitor-activated, but the visual rhythm is composed so
  it can support sound.
- The same world persists across the full journey; it does not reset at every
  section.

The V2 concepts adopt those principles without copying Active Theory's imagery,
portfolio structure, logo, project cards, typography, or particle sculpture.

## Audience and Single Job

The audience is a technically ambitious creator who regularly moves between
conversations, files, terminals, models, tools, agents, and approvals.

The website's single job is to make that person feel that VibeSpace is not
another tool window: it is the environment that turns scattered intent into
finished, reviewable work. The primary conversion is **Download VibeSpace**.

## Shared Experience Contract

Every world must include all of the following:

- A real `000%` to `100%` loader driven by asset readiness, with an authored
  transition from loader to world.
- Seven acts over at least ten viewport-heights of scroll travel.
- One continuous camera timeline with no ordinary full-page section cuts.
- Six or seven project-owned, visually consistent cinematic scene plates.
- A world-specific WebGL or Canvas effects pass that responds to scroll and
  pointer movement.
- Velocity-aware scroll smoothing with one bounded animation-frame loop.
- Pointer parallax, highlight travel, and depth response with restrained limits.
- An optional **Enter with sound** path and a silent path. Sound must begin only
  after a user gesture.
- Sparse product copy that names recognizable outcomes rather than technical
  implementation.
- A persistent progress instrument that belongs to the fiction of that world.
- A final download act with the GitHub releases URL:
  `https://github.com/Cookie774-GameDev/VibeSpace/releases/latest`.
- Keyboard access, visible focus, semantic chapter content, and a complete
  `prefers-reduced-motion` presentation.
- Desktop-first rendering for viewports at or above 1100 CSS pixels. Narrow
  screens receive a composed poster-and-copy fallback, not a second cinematic
  implementation.

## Shared Narrative Spine

The product truth stays stable across all three worlds:

1. **Silence** — establish the world before explaining it.
2. **Fragmentation** — show the cost of scattered tools and lost context.
3. **Arrival** — VibeSpace creates one project-aware environment.
4. **Awakening** — Jarvis understands the active work and approved context.
5. **Orchestration** — agents, terminals, models, and tools work together.
6. **Proof** — results, commands, sources, and approvals remain visible.
7. **Release** — the finished work leaves the system without losing its history.

The shared spine is not represented with the same layout or choreography in
each concept.

## World 1: First Contact

### Thesis

VibeSpace is an impossible object that arrives in a world of disconnected
tools and changes the gravity around them.

### Material and Type System

- **Void:** `#020305`
- **Ion white:** `#EAF7F3`
- **Spectral cyan:** `#6CE7DF`
- **Ultraviolet:** `#6657FF`
- **Solar flare:** `#FF542D`
- **Display:** Syne, 700–800
- **Body:** Manrope, 400–500
- **Telemetry:** Sometype Mono, 400–500

Generated imagery must feel like large-format science-fiction cinematography:
practical haze, deep blacks, controlled lens bloom, precise metallic materials,
and photographic scale. Avoid starship concept-art clutter, random neon
geometry, floating dashboard panels, cyberpunk skylines, and generic glowing
orbs.

### Signature

The **gravity lens** bends the world toward scroll velocity and pointer
position. Type, dust, light, and distant objects respond at different depths.
The effect grows near the monolith and resolves to perfect stillness in the
release act.

### Seven Acts

1. **Transmission** — a real asset counter appears as a distant intercepted
   signal. At 100%, its digits compress into a thin line of light.
2. **Atmosphere** — the camera follows an unknown object through black cloud
   layers. Copy: “Something has entered the workflow.”
3. **Debris Field** — isolated windows, terminals, files, and messages drift as
   dark wreckage. Copy: “Your work was never meant to live this far apart.”
4. **The Monolith** — VibeSpace arrests the debris and reorganizes its orbits.
   Copy: “One living space changes the gravity.”
5. **Awakening** — the camera crosses the monolith surface; Jarvis appears as a
   travelling intelligence, not a face or chatbot bubble. Copy: “Ask once. The
   whole project answers.”
6. **Assembly** — coordinated agents and terminals construct a luminous
   deliverable while evidence remains attached. Copy: “Build in parallel.
   Review in one place.”
7. **Daybreak** — the camera exits above Earth as the completed object opens
   into the VibeSpace mark and download control. Copy: “Think. Build. Keep
   moving.”

The world progress instrument is a small orbital trajectory, not a numbered
website rail.

## World 2: The Memory Forest

### Thesis

Context is not a database or a pile of saved messages. It is a living ecology
that grows relationships around the work.

### Material and Type System

- **Carbon soil:** `#03110D`
- **Moon ivory:** `#F1F0E7`
- **Chlorophyll:** `#72E5A3`
- **Pollen:** `#E5CD71`
- **Deep violet:** `#62537E`
- **Display:** Newsreader, 500 with selective italic forms
- **Body:** Instrument Sans, 400–500
- **Specimen labels:** IBM Plex Mono, 400

Generated imagery must resemble premium macro nature cinematography crossed
with a museum specimen archive: wet bark, translucent fibers, mineral dust,
vellum fragments, moonlit fog, shallow depth of field, and restrained
bioluminescence. Avoid fantasy-game forests, magical glowing mushrooms,
fairies, generic data trees, holographic UI panels, and botanical wallpaper.

### Signature

The **growth memory** makes scroll physically cultivate the scene. Threads find
one another, roots branch, specimen layers unfold, and light travels through
the resulting network. Reversing the scroll precisely unwinds the same growth.

### Seven Acts

1. **Germination** — the loader is a dormant seed. Each loaded asset grows a
   measured root; at 100%, the roots split the black field.
2. **Falling Memory** — fragments of conversations, files, and decisions fall
   like dark seeds. Copy: “Nothing important should disappear.”
3. **First Root** — one project creates a path among the fragments. Copy:
   “VibeSpace notices what belongs together.”
4. **The Archive** — the camera enters a colossal translucent trunk whose rings
   hold project history. Copy: “Context becomes somewhere you can return to.”
5. **Living Recall** — Jarvis follows one luminous thread from a question to
   its exact source, terminal, file, and decision. Copy: “Ask the work. Keep
   the evidence.”
6. **Cultivation** — agents grow a complete structure from approved history
   while rejected branches visibly wither. Copy: “Agents move faster when the
   memory is real.”
7. **Canopy** — dawn reaches the completed project suspended in the canopy.
   Copy: “The next move remembers the last.”

The world progress instrument is a seven-ring growth section cut from the
archive trunk.

## World 3: The Machine Opera

### Thesis

AI work should not vanish into a black box. VibeSpace turns intent,
coordination, execution, and approval into a legible physical performance.

### Material and Type System

- **Gallery bone:** `#EFECE4`
- **Pitch:** `#12110F`
- **Nickel:** `#B7B0A5`
- **Oxidized blue:** `#23515B`
- **Signal red:** `#DF351F`
- **Display:** League Gothic, 400
- **Body:** IBM Plex Sans, 400–500
- **Machine notation:** Azeret Mono, 400–500

Generated imagery must look like photographed production design in an enormous
modernist museum: physical steel, porcelain, cable, paper, glass tubing,
hard-edged stage lighting, human-scale wear, and exact mechanical assemblies.
Avoid steampunk, brass gears as decoration, generic robot arms, factory stock
photography, floating interface glass, black-and-orange gamer styling, and
random industrial pipes.

### Signature

The **causal machine** gives every scroll movement a physical consequence.
One cable tension opens the next room; one pneumatic pulse moves context; one
approval stamp releases the finished object. Motion is directional, legible,
and timed like choreography rather than ambient decoration.

### Seven Acts

1. **Tuning** — the loader assembles 100 components of a mechanical score. At
   completion, a red conductor line draws across the screen and raises the
   gallery curtain.
2. **The Wire** — rough intent enters as one vibrating cable. Copy: “Start with
   the thought before it is tidy.”
3. **The Press** — messages, files, and voice are pressed into one continuous
   physical ribbon. Copy: “Bring the source with you.”
4. **The Ensemble** — several specialized machines engage in exact sequence,
   representing agents, tools, models, and terminals. Copy: “Every specialist
   enters on cue.”
5. **The Organ** — terminals become a monumental pipe instrument; commands
   travel visibly and outputs return through glass tubes. Copy: “Execution
   stays visible.”
6. **The Review Gate** — evidence, diffs, and approvals converge in a quiet
   inspection chamber. Copy: “Nothing ships from a black box.”
7. **Finale** — the complete machine performs once, then folds into a compact
   VibeSpace instrument beside the download control. Copy: “Make the whole
   system move.”

The world progress instrument is an animated score with seven measures.

## Visual Asset Production

Use the built-in image-generation path. Assets are project-bound and must be
copied into:

```text
previews/cinematic-site-concepts-v2/assets/
  first-contact/
  memory-forest/
  machine-opera/
```

Each world receives:

- one master visual used to lock material, lens, lighting, and recurring object
  design;
- six derived cinematic plates generated or edited using the approved master
  as a reference;
- one lightweight poster encode per plate;
- one subtle texture plate for grain or material breakup.

Every prompt in one world repeats a verbatim style preamble. Derived images
must preserve the recurring monolith, archive structure, or machine vocabulary.
Images may not contain generated text, logos, UI labels, watermarks, or
unreadable pseudo-typography.

The final browser copy and interface text remain HTML so they are crisp,
accessible, searchable, and art-directable.

## Motion and Rendering Architecture

### Loader

The loader tracks successful image decode, font readiness, and initialization
of the world renderer. It may interpolate visually between readiness updates,
but it must not reach 100 until all critical assets are available. A recoverable
error state offers **Retry transmission**, **Regrow**, or **Retune** according
to the world.

### Timeline

Each world owns a declarative seven-act timeline. Native scroll provides the
accessible source position. A critically damped spring produces the rendered
camera position. Scroll velocity is separately smoothed and feeds restrained
lens distortion, particle direction, and transitional blur.

The mapping preserves exact endpoints:

- progress `0` is the first frame;
- progress `1` is the final download frame;
- chapter boundaries do not jump;
- reverse scrolling follows the same continuous timeline backward.

### Renderer

A shared renderer provides:

- plate compositing;
- perspective camera transforms;
- scroll and pointer parallax;
- displacement and chromatic-lens passes;
- atmosphere particles specific to each world;
- world-specific transition masks;
- one bounded `requestAnimationFrame` loop;
- pause on hidden documents;
- device-pixel-ratio cap;
- Canvas fallback if WebGL initialization fails.

World modules provide visual grammar and timeline data; they do not fork the
loader, input, accessibility, or lifecycle logic.

### Sound

Sound is off by default. The entry gate offers **Enter with sound** and
**Enter silently**. The sound path uses a small procedural Web Audio score:

- First Contact: sub-bass drone, filtered signal pulses, and arrival swell.
- Memory Forest: filtered noise, wooden resonance, and glass harmonics.
- Machine Opera: mechanical ticks, pressure releases, and a final tonal chord.

No sound begins before a visitor gesture. The persistent mute control has an
explicit accessible name and remembers its state within the session.

## Comparison Gallery

The gallery is quiet and curatorial. It provides:

- three full-width concept portals with a still image, title, one-sentence
  thesis, palette specimen, and **Enter world** action;
- direct full-screen routes for grading;
- no embedded iframe stage;
- no miniature side rail;
- no competing animation while a world is open.

Returning from a world restores the gallery without replaying another world's
loader.

## Accessibility and Fallbacks

- Semantic headings and chapter content remain in DOM order.
- The experience is usable with keyboard scrolling and visible focus.
- A skip control reaches the narrative copy.
- `prefers-reduced-motion` replaces scrub motion with seven editorial,
  full-bleed scenes and immediate readable copy.
- Renderer failure preserves the plates, copy, navigation, and download action.
- At widths below 1100 pixels, the site shows the reduced-motion editorial
  composition and explains that the full cinematic experience is desktop
  optimized.
- Contrast for essential copy and controls meets WCAG AA.

## Performance Budget

- Critical loader shell: under 120 KB uncompressed HTML, CSS, and JavaScript.
- Initial poster: under 700 KB.
- Individual full plates: target under 1.8 MB after encoding.
- No more than two neighboring full plates retained as hot decoded surfaces.
- Device pixel ratio capped at 1.5 for the world renderer.
- One animation loop per open world.
- Hidden tabs stop rendering.
- No runtime dependency or package-lock change.

The 4K source art remains available in the project, but browser delivery uses
appropriately encoded desktop assets rather than raw generation output.

## Verification and Acceptance

The revision is ready for grading only when:

1. The three loaders visibly travel from `000%` to `100%` and do not complete
   before critical assets decode.
2. Each experience contains seven acts and a continuous reversible timeline.
3. Screenshots from all three worlds are unmistakably different without
   reading their titles.
4. The generated imagery within one world preserves its core object, material,
   lens, and lighting vocabulary.
5. A fast scroll does not create duplicate animation loops or leave a world in
   a partially transitioned state.
6. Pointer movement produces bounded depth response without obscuring controls.
7. Sound never starts without a gesture and can always be muted.
8. Reduced motion, keyboard navigation, renderer fallback, and the final
   download action all work.
9. Every local route and asset returns HTTP 200.
10. The connected Edge console contains no runtime errors during loader,
    forward scroll, reverse scroll, sound toggle, and world switching.
11. The comparison gallery is opened automatically for user grading.

## Explicit Non-Goals

- Do not modify or replace the current live website.
- Do not implement `website-next` before the user selects a world.
- Do not create the final selected-world `DESIGN.md` or personal `SKILL.md`
  before the user grades the completed three.
- Do not publish, deploy, push, or mutate the production domain.
- Do not add npm dependencies or modify lockfiles.
- Do not reuse the rejected V1 canvas backgrounds as production visuals.
