# VibeSpace Cinematic Product Worlds V3 — Design Specification

**Status:** Owner-authorized implementation
**Platform:** Desktop only
**Task:** `VS-ROOT-20260803T211613Z-CINEMATIC-V3`

## Purpose

Build three complete grading references for a future VibeSpace marketing site. Each
reference must feel like an authored cinematic product film while remaining unmistakably
and truthfully about VibeSpace. The visitor must encounter real Warm-theme VibeSpace
surfaces, understand what the product does, reach pricing and a final call to action, and
have meaningful interactions beyond merely scrolling.

The previous V2 concepts are rejected evidence. They used atmospheric plates as the
subject, reduced the product to copy, and treated scroll as the whole experience. V3
reverses that hierarchy: the product is the subject; cinematic motion is the storytelling
language.

## Source authority

Visual and product truth comes from:

1. `C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Warm`
2. `C:\Users\viper\Videos\Screen Recordings\Screen Recording 2026-08-03 153527.mp4`
3. Existing read-only VibeSpace website/product copy and pricing in `site/**` and
   `docs/SUBSCRIPTION_PLANS_REFERENCE.md`
4. Active Theory as a quality and interaction reference, not a layout to clone

No new generated imagery is allowed. Landscape, flowers, light, paper, and spatial
transitions must be built from the supplied Warm artwork, CSS, SVG geometry, typography,
and authored motion.

## Shared product narrative

All three worlds use the same eight-beat product spine so the owner can grade the cinematic
direction instead of comparing different product claims.

1. **Arrival:** “A workspace that thinks beside you.”
2. **Jarvis chat:** begin with a sentence; delegate in plain language.
3. **Focused agents:** a small team of specialized agents instead of one anonymous model.
4. **Plans that happen:** Jarvis turns natural language into schedules and tasks.
5. **Work in one place:** files, terminal, projects, and Kanban remain in the workspace.
6. **Skills and tools:** teach the workspace repeatable ways of working and author actions.
7. **Local-first trust:** work and context remain under the user’s control.
8. **Access and finale:** truthful VibeSpace Access pricing and a decisive download CTA.

The pages may shorten supporting copy, but must not invent capabilities. Every major
feature beat must be paired with an authentic supplied VibeSpace UI image.

## Shared experience requirements

- A real `0–100` readiness loader with authored states, skip control, and no fake network
  claims.
- A sound/silent entrance choice, with audio remaining optional and gesture-gated.
- A fixed cinematic stage with reversible scroll-scrub progression and rAF smoothing.
- Pointer parallax and product-window depth; the product images must move as spatial
  objects rather than crossfade as full-screen plates.
- Clickable feature markers or controls that reveal additional product information.
- Keyboard operation for entrance, scene rail, feature reveals, gallery return, and CTA.
- A persistent compact navigation system showing current act and total progress.
- Real page completeness: hero, feature story, product index, pricing, FAQ/trust note,
  final CTA, and footer-level legal/product links.
- A visible reduced-motion mode that replaces continuous transforms with stable section
  transitions and never blocks access to content.
- A desktop editorial notice below 1100 CSS pixels; no mobile-specific implementation.
- No new dependency, framework, remote runtime, generated bitmap, autoplay audio, or
  production mutation.

## Direction 01 — The Quiet Ascent

### Premise

VibeSpace is a calm climb from a scattered day to a clear view. The camera travels through
one continuous watercolor mountain valley. Each authentic product surface is a physical
waystation on the trail: Jarvis at the trailhead, agents along a ridge, scheduling at the
river crossing, tools near the observatory, and the complete workspace at the summit.

### Signature motion

- A sunrise loader draws the trail from 0 to 100.
- Layered CSS/SVG mountain planes move at different rates for real parallax.
- Product windows arrive from depth, follow curved flight paths, and settle into readable
  hero compositions.
- The trail line, sun position, flower growth, and sky temperature advance continuously.
- Clicking a waystation opens a compact field-note panel with feature detail.
- The finale pulls all prior product surfaces into one composed workspace constellation.

### Emotional arc

Stillness → first step → companionship → momentum → clarity → summit.

## Direction 02 — The Living Desk

### Premise

VibeSpace begins as a quiet physical desk at dawn. A notebook opens, paper layers unfold,
and the real application grows out of the work itself. Product screens behave like
carefully art-directed sheets, windows, index cards, and translucent vellum rather than
floating SaaS rectangles.

### Signature motion

- A mechanical paper-count loader advances with deckled-edge masks and registration marks.
- The camera alternates between macro tabletop depth and overhead compositions without a
  cut.
- Scroll unfolds paper architecture; product windows hinge, stack, slide under one another,
  and assemble into a complete desktop.
- Pointer movement produces restrained lens and shadow response.
- Clickable paper tabs switch truthful secondary views within the current product beat.
- The finale closes the scattered pages into one VibeSpace folio, then opens it as the CTA.

### Emotional arc

Blank page → first thought → structure → craft → a body of work → home.

## Direction 03 — The Garden of Work

### Premise

VibeSpace is a living system rather than a machine dashboard. A seed of intent becomes a
garden of focused agents, scheduled rhythms, skills, tools, and connected work. Botanical
forms are navigation and information architecture, not decoration.

### Signature motion

- A seed-to-bloom readiness loader advances from 0 to 100.
- A central branching SVG grows through all acts; each branch terminates in a real product
  surface.
- Agents appear as named buds around the main Jarvis branch; schedules follow the sun;
  skills and tools flower into reusable action clusters.
- Pointer proximity bends stems and changes depth; clicks open labeled botanical specimen
  cards containing real feature details.
- Daylight moves from dawn to late-afternoon warmth, preserving the Warm palette.
- The finale reveals the full product ecosystem as one garden viewed from above.

### Emotional arc

Seed → root → growth → rhythm → bloom → belonging.

## Visual system

### Palette

- Espresso `#2b211b`
- Warm ivory `#f6eddd`
- Paper `#fffaf0`
- Terracotta `#c96f4a`
- Copper `#9d5739`
- Sage `#80906f`
- Dusty lavender `#aa8da8`
- Petal `#d99986`
- Sun `#efb960`

Each direction may rebalance these values but must remain recognizably Warm. Black/cyan
sci-fi styling, neon gradients, generic purple AI glows, glass-dashboard grids, and
unrelated palettes are prohibited.

### Type

- Editorial serif display stack: Georgia, “Times New Roman”, serif.
- Restrained humanist sans stack: “Segoe UI”, Arial, sans-serif.
- Sentence case only. Avoid giant slogan fragments, faux terminal copy, excessive pills,
  and generic “AI-powered” language.

### Product imagery

Use selected original 1672×941 Warm UI screenshots as local assets. Preserve their aspect
ratio and legibility. Crop only through intentional object framing; never recolor, replace
the UI, or imply that decorative illustration is a functioning control.

## Pricing truth

The access scene must state:

> VibeSpace Access is $20/month after the introductory 30-day access trial. Optional
> AI, voice, and cloud plans are billed separately.

The compact plan comparison may show:

- Spark: $0 optional feature plan
- Orbit: $10/month
- Nova: $50/month
- Singularity: $100/month

These feature-plan prices are separate from VibeSpace Access. The page must not imply that
the trial auto-converts or collects payment automatically.

## Acceptance criteria

1. Three independent HTML routes and one comparison gallery load without a build step.
2. Each route contains all eight product beats and at least six authentic Warm UI assets.
3. Each direction has a unique loader, spatial grammar, progress/navigation treatment,
   opening, midpoint, pricing scene, and finale.
4. Scroll progression is smoothed, reversible, and deterministic.
5. Pointer, click, and keyboard interactions materially affect the experience.
6. Copy and pricing pass structural truth contracts.
7. Reduced-motion and desktop-width fallbacks expose every product beat.
8. All local assets resolve, JavaScript parses, routes return HTTP 200, and no console error
   is produced in browser QA.
9. V1, V2, production site, product source, dependencies, and external systems remain
   untouched.

## Rollback

Remove `previews/cinematic-site-concepts-v3/**` and the two V3 spec/plan documents, then
remove the V3 coordination addendum. No product or production state requires reversal.
