# Visual Acceptance and Internal Refinement Loop

## Primary principle

Browser visualization is the main test for this UI goal. Automated checks are supporting safeguards, not the center of the work.

## Primary viewports

Capture at minimum:

- `1920 × 1080`;
- `1600 × 900`;
- `1366 × 768`;
- one narrow desktop window around `1024 × 768`.

Where a target reference has a different aspect ratio, also capture the closest matching viewport.

## Required matrix

### Shared scale

For each of the four target themes:

- Settings → Phone & Voice;
- Settings → Local Models;
- Settings → Accessibility;
- Build Your Own AI overview;
- Build Your Own AI wizard;
- one tooltip;
- one popover/dropdown;
- one long scrolling list.

### MonoChrome

- chat empty state;
- chat with assistant stream;
- settings;
- tooltip;
- dialog;
- terminal/code surface;
- Kanban or another card-heavy route.

### Sakura

- shell/chat;
- Kanban reference route;
- settings dialog;
- tooltip/popover;
- petal `off`;
- petal `slow`;
- petal `normal`;
- petal `fast`;
- reduced motion;
- theme switch away/back.

### Origami

- boat empty state;
- flower empty state;
- first message removes art;
- inline assistant stream;
- settings;
- Schedule;
- Kanban;
- one designated pixel-reference screen at matching viewport.

### Warm

- shell/chat;
- Build Your Own AI overview;
- wizard;
- Schedule;
- settings pages from the supplied current-state screenshots;
- any supplied image-heavy card/page;
- narrow viewport.

### Usage module

- setting disabled;
- starting;
- running with two providers;
- no providers;
- quota unavailable;
- stale/offline;
- window error;
- each target theme;
- enable/disable repeatedly;
- one native taskbar placement smoke.

## Comparison rubric

Score each target from 0–3:

| Category | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| geometry | broken | major mismatch | close | reference-aligned |
| typography | wrong/overflow | inconsistent | mostly correct | exact hierarchy |
| palette | wrong theme | approximate | close | reference-aligned |
| material | flat/wrong | partial | convincing | polished and consistent |
| art placement | missing/broken | inaccurate | close | reference-aligned |
| interaction state | broken | incomplete | works | polished |
| responsive/zoom | broken | clips | usable | stable |

A screen may not pass with any `0`, and reference-critical screens should average at least `2.7`.

## Overlay method

For reference-critical screens:

1. capture implementation;
2. resize reference and capture to common canvas without distortion;
3. compare side by side;
4. use a 50% opacity overlay or difference view;
5. inspect major boundaries:
   - shell;
   - navigation;
   - title baseline;
   - card edges;
   - composer;
   - illustration box;
   - footer/dialog;
6. correct major offsets before color micro-tuning.

Do not commit generated comparison artifacts unless they are useful evidence and contain no secrets.

## Interaction checks

- hover does not shift layout;
- focus visible;
- Escape closes dialogs/popovers;
- scrollbars remain reachable;
- decorative art does not intercept pointer input;
- theme switch updates open portal surfaces;
- no duplicate petal/animation loops;
- no flash of wrong theme;
- no content hidden behind mascot;
- empty-state art disappears exactly when required;
- streaming does not jump scroll unexpectedly;
- usage setting does not lie.

## Performance observation

Use browser performance tools only as needed. Watch for:

- repeated style/layout work from petals;
- large repaints from backdrop blur;
- rerender storm from token animation;
- image decode stutter;
- duplicate five-second timers;
- work continuing when feature/theme is inactive.

Fix obvious issues; do not turn this goal into a full performance rewrite.

## Focused checks

Run the cheapest relevant checks after coherent batches:

- TypeScript/typecheck for changed package;
- focused tests for theme contract/persistence;
- focused test for empty-state stable selection;
- focused test for usage enable/disable and timer cleanup;
- build if assets/CSS pipeline changed materially.

Avoid broad unrelated tests unless a focused check reveals a wider failure.

## Stop conditions

Do not stop because:

- the app is “better than before”;
- one theme looks good while another leaks;
- the primary screenshot passes but dialogs/tooltips remain oversized;
- petals render but speed controls do nothing;
- usage toggle saves but no window appears;
- the animation moves but is in the wrong location;
- the output is terminal-like only because it is inside a black box.

Stop when the required matrix passes, or when a specific external limitation is documented with evidence and the remaining in-repo work is complete.
