# Skill — Reference-Driven UI Restoration

## Purpose

Use this skill for the entire goal. It defines how one agent should inspect references, edit shared UI systems, process assets, and run a visual comparison loop without spending most of the task on planning or broad automated testing.

## Operating sequence

1. Read `AGENTS.md` and this documentation pack.
2. Inventory references.
3. Inspect the existing theme contract, global styles, shared primitives, portals, settings shell, chat renderer, animation source, and usage-module setting/window code.
4. Confirm the single plan in `IMPLEMENTATION_PLAN.md` against real paths.
5. Implement shared scale first.
6. Implement each theme and feature in the plan order.
7. Run browser compare/refine loops continuously.
8. Run only focused, inexpensive checks required to catch broken rendering/types.
9. Produce visual evidence and an honest handoff.

Do not create sub-agents, parallel worktrees, or extra implementation plans.

## Repository reconnaissance

Locate, at minimum:

- theme ID/type contract and persistence migration;
- document `data-theme` application;
- global CSS and typography utilities;
- settings dialog shell and navigation;
- portal roots for tooltips/popovers/dialogs;
- page routes represented in screenshots;
- chat empty-state and assistant-message components;
- stream event model and token/usage events;
- mascot/token animation source and placement;
- usage-module preference;
- Tauri window creation/placement code;
- provider connection registry and request activity bus.

Search by behavior and rendered copy, not only guessed filenames.

## Windows reference inspection

Use PowerShell or equivalent to inventory assets:

```powershell
Get-ChildItem -LiteralPath "C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Origami" -File -Recurse |
  Select-Object FullName, Length, Extension

Get-ChildItem -LiteralPath "C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Warm" -File -Recurse |
  Select-Object FullName, Length, Extension
```

For images, inspect original dimensions. For Sakura, open `index.html` and inspect linked files and computed styles.

## Reference analysis method

For every target screen, record:

- viewport/aspect ratio;
- bounding regions;
- dominant colors;
- font family/weight/size;
- line height;
- panel opacity;
- blur radius;
- border/highlight;
- shadow direction;
- radius;
- padding/gaps;
- illustration bounds;
- empty-state lifecycle;
- motion;
- responsive behavior.

Use a quick overlay or side-by-side comparison. Do not rely on memory.

## Asset processing

### Rules

- work on copies;
- preserve original alpha;
- preserve or convert to sRGB consistently;
- use nearest appropriate format;
- keep SVG when vector;
- use WebP/PNG for transparency as supported;
- do not upscale low-resolution source and call it repaired;
- avoid new heavy runtime dependencies for one preprocessing task.

### Transparent animation

When a sprite/animation has a solid background:

1. determine whether the source contains true alpha;
2. use the original source if a transparent variant exists;
3. otherwise remove only the known background range;
4. feather/defringe carefully;
5. inspect on all four theme backgrounds;
6. export a transparent processed asset;
7. preserve frame timing.

Do not use destructive chroma removal that erases highlights in the subject.

## Shared-style editing

Prefer:

- semantic CSS variables;
- Tailwind theme utilities backed by variables;
- shared component variants;
- data attributes for narrow theme differences;
- stable class names for reference-specific regions;
- pseudo-elements for environment layers.

Avoid:

- global descendant `*` theme selectors;
- mass `!important`;
- duplicated component trees;
- fixed-position decoration without a containing block;
- page-wide `transform: scale`;
- hardcoded screenshot dimensions;
- inline raw color proliferation.

## Browser workflow

Primary URL:

```text
http://localhost:5173
```

Start the development app using repository instructions. Use browser control/visualization to:

- switch appearances;
- open each route;
- open settings sections and dialogs;
- hover tooltips;
- open popovers;
- start a new chat;
- send a test message through an available safe local/mock path;
- observe inline stream;
- switch theme while open;
- exercise Sakura petal speeds;
- exercise density;
- enable/disable usage-module browser shell/status;
- resize viewport;
- capture screenshots.

For native-only module window creation, use a bounded Tauri smoke only when needed to prove the setting is not decorative. The broad validation effort remains browser visual.

## Visual comparison loop

For each target:

1. capture current implementation at reference-like viewport;
2. place target and capture side by side or overlay at partial opacity;
3. compare:
   - outer geometry;
   - type scale;
   - spacing;
   - palette;
   - material;
   - art placement;
   - states;
4. fix the largest mismatch first;
5. repeat;
6. stop only when remaining differences are required by real content, accessibility, or responsive constraints.

Do not claim “pixel perfect” without a comparison. Do not waste time chasing invisible one-pixel differences before scale, palette, and composition match.

## Internal quality loop

Use this order:

1. structure and dimensions;
2. global typography/density;
3. surface material;
4. color/contrast;
5. illustration and motion;
6. interaction states;
7. responsive/zoom;
8. final polish.

This prevents polishing a composition that is still fundamentally wrong.

## Focused code checks

The user does not want a long testing campaign. Use only:

- formatter on changed files;
- TypeScript/typecheck for affected package when practical;
- focused existing tests around modified theme contracts or usage lifecycle;
- production build only if needed to ensure CSS/assets compile;
- one native smoke for native-only usage window behavior.

Do not run a massive unrelated suite after every visual edit. Browser visualization is the main gate.

## Evidence

Capture a final matrix with:

- theme;
- route/surface;
- viewport;
- reference ID;
- screenshot path;
- status;
- known justified difference.

Report failures honestly. Do not say a native window, provider quota, or token-rate path was verified unless it was exercised.
