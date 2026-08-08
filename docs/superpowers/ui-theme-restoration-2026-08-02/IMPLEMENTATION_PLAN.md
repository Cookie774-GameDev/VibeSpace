# Single Implementation Plan — VibeSpace UI Theme Restoration

This is the only implementation plan for `VS-PR31-UI-THEME-RESTORATION-20260802`. Do not create additional plans by theme, route, or feature.

## Phase 0 — Fast reconnaissance and reference map

Time-box the planning pass. It should be thorough enough to avoid rework but not become a separate project.

1. Read `AGENTS.md` and every file in this pack.
2. Inventory all local reference folders and the Sakura preview.
3. Identify actual source paths for:
   - theme contract/persistence;
   - global type/spacing utilities;
   - shared UI primitives;
   - shell/settings/dialog/tooltip;
   - chat empty state and assistant stream;
   - token animation;
   - usage setting/window/provider data.
4. Map each reference to current routes/components.
5. Record a compact path list and risk list in working notes.
6. Begin implementation. Do not ask for approval.

Exit condition: every required surface has an identified implementation owner/path and reference.

## Phase 1 — Repair the shared scale at the root

1. Consolidate semantic typography and density variables.
2. Correct `text-page-title`, `text-secondary`, `text-metadata`, `text-ui-strong`, labels, inputs, buttons, tooltips, and section headings.
3. Correct settings/dialog sizing and independent scrolling.
4. Replace fixed excessive card heights/padding with content-driven recipes.
5. Constrain copy line lengths.
6. Ensure terminal-specific font-size controls remain independent.
7. Check the five supplied current-state screenshot routes.

Exit condition: representative pages fit normal desktop viewports and no longer look globally enlarged.

## Phase 2 — Stabilize theme architecture and portals

1. Confirm canonical selectable IDs and persisted migrations.
2. Map Origami/Warm names to existing `vibespace`/`default` IDs without breaking users, or add explicit IDs only when the product contract requires it.
3. Centralize semantic tokens for all shared groups.
4. Ensure `data-theme` reaches portals, dialogs, tooltips, detached windows, and processed assets.
5. Remove broad theme descendant hacks that destroy component geometry.
6. Add explicit art slots and layer/z-index rules.

Exit condition: switching theme updates all open UI surfaces with no leakage or layout jump.

## Phase 3 — MonoChrome restoration

1. Compare against MonoChrome references.
2. Apply compact terminal/editor scale.
3. Correct fonts, radii, borders, shadows, navigation, settings, dialogs, tooltips, popovers, lists, and code surfaces.
4. Remove warm/serif/glass leakage.
5. Check tooltip and settings trouble spots specifically.
6. Visual refine loop across key routes.

Exit condition: MonoChrome matches reference density and material across shared UI.

## Phase 4 — Sakura restoration

1. Analyze Sakura preview CSS/JS/assets and extract palette/material.
2. Build environment layers.
3. Implement performant shell/card/nested glass recipes.
4. Correct typography and hierarchy.
5. Repair petal lifecycle and speed controls.
6. Apply Sakura treatment across shell, chat, Kanban, settings, tooltips, dialogs, and popovers.
7. Verify reduced motion and theme cleanup.
8. Visual refine loop against the preview.

Exit condition: Sakura reads as the same cinematic glass system and all petal speeds visibly work.

## Phase 5 — Origami restoration

1. Extract exact palette, gradients, paper shadows, typography, and compositions from the Origami folder.
2. Implement stable 50/50 boat/flower empty-state selection per new chat.
3. Remove empty art after first message and eliminate generic placeholder copy.
4. Apply paper material to shell, navigation, chat, cards, settings, Schedule, Kanban, and dialogs.
5. Place supplied assets at correct resolution and bounds.
6. Match designated reference screens at the primary viewport.
7. Repeat overlay/side-by-side comparison until major differences are gone.

Exit condition: reference screens are visually near-identical without breaking real content/responsiveness.

## Phase 6 — Warm restoration

1. Extract darker palette and typography from Warm references.
2. Reduce bright/white surfaces and global serif overuse.
3. Establish warm paper/wood material.
4. Replace or correctly place low-quality/flat illustration usage.
5. Create dedicated text-safe art slots.
6. Repair Build Your Own AI overview and wizard scale/composition.
7. Repair Schedule and other illustration-heavy pages.
8. Repair settings surfaces shown in current-state screenshots.
9. Visual refine loop.

Exit condition: Warm is dark, dimensional, sharp, handcrafted, and free of unintended text-over-image.

## Phase 7 — Codex-style inline chat and sidebar animation

1. Remove the incorrect large black assistant-ready panel.
2. Remove `Type your first message` where references omit it.
3. Normalize assistant execution events into inline stream primitives.
4. Render tool/file/command/code/review events on the existing themed canvas.
5. Keep prose readable and code contained.
6. Add thick streaming cursor.
7. Create explicit tiny sidebar animation slot.
8. Process animation for true transparency.
9. Bind theme tint.
10. Bind bounded playback speed to real token/stream rate.
11. Respect reduced motion and cleanup.

Exit condition: chat feels Codex-inspired without becoming a separate terminal panel, and animation placement/speed match the contract.

## Phase 8 — Usage-module repair and theme variants

1. Read the existing production repair document.
2. Trace the setting through persistence, native window lifecycle, placement, provider registry, activity bus, and UI.
3. Make enable/disable truthful and idempotent.
4. Add visible error/retry/reset-position state.
5. Reuse existing provider connections.
6. Implement the 30+ data-driven registry.
7. Emit live local activity.
8. Reconcile aggregate state at least every five seconds.
9. Use provider-safe remote refresh.
10. Render exactly two top-ranked providers normally.
11. Project live theme tokens into the module.
12. Verify MonoChrome/Sakura/Origami/Warm visual variants.

Exit condition: module is visible and live when enabled, fully stops when disabled, and never invents quota.

## Phase 9 — Visual acceptance loop

Use `VISUAL_ACCEPTANCE.md`.

1. Run the required theme × surface matrix.
2. Compare against reference at primary viewport.
3. Fix largest mismatch.
4. Repeat screenshots.
5. Check narrow viewport/zoom.
6. Check hover/focus/scroll/empty/live/error states.
7. Run one bounded native usage-module smoke.
8. Run focused compile/type checks.

Do not stop at “looks better.” Stop when acceptance criteria pass or a documented external limitation remains.

## Phase 10 — Handoff

Report:

- exact changed files;
- reference sources used;
- screenshots/evidence;
- visual acceptance matrix;
- native usage-module evidence;
- focused checks run;
- known limitations;
- no claims beyond evidence.

Do not merge or deploy unless separately authorized.
