# Master Goal — Restore VibeSpace Themes and Visual Systems

**Goal ID:** `VS-PR31-UI-THEME-RESTORATION-20260802`  
**Priority:** Quality-first visual restoration  
**Agent model:** GPT-5.6 Sol or the strongest available coding model  
**Agent count:** exactly one; sub-agents are forbidden  
**Planning:** one short reconnaissance and one plan at the beginning only  
**Validation:** browser visualization is the primary acceptance method  
**Approval policy:** no questions and no approval pauses for in-scope, non-destructive repository work

## Mission

Restore the visual quality, scale, hierarchy, effects, and theme fidelity of VibeSpace so that:

- MonoChrome no longer has oversized text, oversized boxes, or theme-wide density breakage.
- Sakura matches the supplied `index.html` reference in palette, translucent glass, blur, polish, depth, and working petal motion.
- Origami matches the supplied reference images as closely as the existing app content permits, including the 50/50 boat-or-flower new-chat state.
- Warm/Default matches the darker, illustrated, dimensional, hand-crafted reference direction instead of looking bright, flat, generic, or like low-resolution PNGs placed behind text.
- Chat keeps the existing workspace canvas and displays Codex-style execution output inline, not inside a new black assistant panel.
- The small token-throughput animation is transparent, theme-aware, positioned in the left chat list/inspector area, and driven by real streaming activity.
- The taskbar AI usage module actually appears when enabled, uses real provider state, updates efficiently, adapts to every theme, and never fabricates quota.
- Every changed surface remains functional, accessible, responsive, and visually coherent.

## Authoritative references

Use the exact local assets and preview files listed in `REFERENCE_MANIFEST.md`. Inspect them before touching implementation. The reference material outranks personal design preference.

For current-state regressions, inspect the screenshots supplied with the source request. They show representative failures on Build Your Own AI and Settings surfaces; the same root problems may exist elsewhere.

## Scope

### Included

- theme tokens, fonts, type scale, spacing, radii, borders, shadows, background layers, glass, paper, illustration placement, empty states, overlays, and motion;
- shell, chat, settings, tooltips, dialogs, dropdowns, cards, Kanban, Schedule, Build Your Own AI, Local Models, Accessibility, Phone & Voice, and other surfaces affected by shared primitives;
- theme-specific assets already provided in the reference folders;
- Codex-style assistant stream presentation and themed new-chat states;
- sidebar token animation placement and speed binding;
- usage-module visibility, theme projection, live state, provider registry, efficient refresh behavior, and truthful empty/error states;
- focused cleanup needed to remove the incorrect black chat panel and the `Type your first message` placeholder.

### Excluded

- unrelated product redesign;
- unrelated backend, billing, authentication, telephony, model-training, provider, or database changes;
- rewriting application copy that is not part of a supplied pixel-reference screen;
- broad architecture migration;
- new cloud services;
- release publication, deployment, merge, destructive data changes, or secret handling;
- sub-agents or parallel autonomous workers.

The usage module is the one bounded functional exception: wire the existing setting, window lifecycle, provider state, and usage pipeline end to end because a visible toggle that does nothing is not a UI-complete feature. Do not expand that exception into unrelated provider/backend work.

## Autonomy contract

For all in-scope repository edits, local asset processing, browser navigation, screenshot capture, and non-destructive checks:

- proceed without asking;
- make the smallest coherent change that fixes the root cause;
- preserve working behavior;
- do not stop after a partial visual improvement;
- continue the compare → refine loop until the acceptance criteria pass.

Stop only for a genuinely destructive action, missing repository access, or an impossible external dependency. A missing optional reference asset does not justify stopping: use the remaining supplied references, record the missing item, and continue.

## Root-cause rule

Do not patch every page with one-off font sizes or arbitrary width overrides. First repair the shared scale and component primitives, then add narrowly scoped theme treatment. Page-specific CSS is allowed only when the page has a genuinely unique composition.

Bad examples:

- dozens of `!important` size overrides;
- scaling the entire app with CSS `transform`;
- hardcoding a fixed desktop screenshot size;
- duplicating each component per theme;
- adding a new black panel because Codex uses a dark terminal;
- placing raster art as a stretched background with text on top;
- inventing usage percentages.

Good examples:

- semantic type/spacing tokens;
- shared density-aware primitives;
- theme data attributes and semantic tokens;
- reusable glass/paper/ink surface recipes;
- page-level illustration slots;
- inline stream rows;
- a data-driven provider adapter registry;
- stable theme projection into a compact native companion window.

## Quality bar

The result must look intentionally art-directed, not “theme-colored.” Each theme must have its own material language:

- **MonoChrome:** dense terminal/editor precision.
- **Sakura:** cinematic dusk glass with living petals.
- **Origami:** soft, dimensional folded-paper illustration.
- **Warm:** darker handcrafted paper/wood warmth with dimensional sketched scenes.

The app must remain unmistakably VibeSpace across all themes through stable structure, interaction patterns, and accessibility.

## Completion definition

The goal is complete only when all of the following are true:

1. Global scale defects are fixed at shared primitives and no representative screenshot surface remains oversized or cramped.
2. Each theme passes its dedicated design specification.
3. Sakura petals visibly respond to every supported speed setting and stop under reduced motion.
4. Origami new chats use the correct 50/50 boat/flower empty state and remove it after the first message.
5. Chat output appears inline over the existing canvas; the incorrect black assistant panel and `Type your first message` text are gone.
6. The small animation is in the left chat list/inspector position, has no visible rectangle, adapts to the active theme, and changes speed with actual token throughput.
7. Warm illustrations are sharp, dimensional, correctly placed, and never obscured by unintended text.
8. Enabling the usage module yields a visible module or an actionable error; disabling it removes the module and stops its work.
9. Real local activity is live, aggregate state reconciles at least every five seconds, and unsupported quota is labeled unavailable.
10. Browser screenshots at the required viewports show no clipping, overlap, unintended scrollbars, washed-out contrast, or theme leakage.
11. The final handoff includes changed paths, visual evidence, remaining limitations, and no unsupported claims.
