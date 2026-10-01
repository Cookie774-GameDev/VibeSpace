# Shared UI Foundations

## Architectural intent

VibeSpace has one component system with multiple material themes. Do not fork the product into separate theme implementations. Shared structure and behavior remain stable; semantic tokens, selected art slots, and narrow theme-specific recipes produce the different appearances.

## Theme contract

The current repository maps selectable theme IDs to document themes. Extend or correct the canonical theme contract rather than scattering string comparisons.

The desired conceptual appearances are:

- `monochrome`;
- `sakura`;
- `origami` / current VibeSpace appearance;
- `warm` / current Default appearance;
- any existing Jarvis/Core appearance outside this goal remains intact.

If the current public IDs are `vibespace` and `default`, preserve persisted compatibility and map their document values deliberately. Do not silently break existing stored preferences.

## Semantic token groups

Every theme must define the same semantic groups:

### Surface

- app background;
- chrome/side navigation;
- base panel;
- elevated panel;
- inset panel;
- input;
- overlay/dialog;
- tooltip;
- selection;
- scrim.

### Text

- primary;
- secondary;
- muted;
- disabled;
- inverse;
- accent;
- code/mono;
- link.

### Border/elevation

- subtle border;
- strong border;
- focus ring;
- separator;
- soft shadow;
- lifted shadow;
- modal shadow;
- inner highlight.

### Status

- success;
- warning;
- danger;
- info;
- active/live;
- stale/offline.

### Geometry and motion

- small/medium/large radius;
- control height;
- compact/cozy density;
- fast/normal/slow duration;
- standard easing;
- spring/eased entrance where allowed.

Components consume semantic tokens. They must not depend on theme-specific raw colors except for documented illustration or provider-brand accents.

## Layer model

Use a consistent z-index and pointer-event model:

1. environment/background artwork;
2. ambient particles/petals;
3. shell surfaces;
4. page decorative art;
5. content;
6. inline assistant stream;
7. popovers/tooltips;
8. dialogs;
9. toasts/focus-mode exits.

Decorative assets must use `pointer-events: none` and must never intercept chat, settings, scrolling, or drag operations.

## Shared shell rules

- Top bar, nav, page body, inspector, and modal frame use a stable grid.
- Mascot/pet art may not overlap navigation labels, tabs, close buttons, or scrollbars.
- Theme art is placed into explicit slots rather than absolutely positioned relative to the viewport without bounds.
- Shell dimensions do not jump when switching themes.
- Theme switching updates tokens and art without reloading the app.
- Existing focus mode/fullscreen behavior is preserved.

## Material recipes

### Glass recipe

Used mainly by Sakura:

```css
background: color-mix(in srgb, var(--surface) 62%, transparent);
backdrop-filter: blur(18px) saturate(125%);
border: 1px solid color-mix(in srgb, var(--border-highlight) 58%, transparent);
box-shadow:
  inset 0 1px 0 rgba(255,255,255,.18),
  0 18px 45px rgba(38,23,61,.22);
```

Tune to the reference. Do not make every nested row glass; nested rows may use lighter translucent fills.

### Paper recipe

Used by Origami:

- opaque or near-opaque tinted paper;
- subtle warm edge;
- directional soft shadow;
- occasional fold highlight;
- gentle gradient, not glass blur;
- no glossy neon outlines.

### Warm illustrated recipe

Used by Warm:

- darker cream/brown base;
- paper/wood tonal variation;
- crisp illustrated scene in a dedicated slot;
- shallow inner highlight and warm shadow;
- restrained texture;
- no flat white slab.

### Terminal recipe

Used by MonoChrome and inline Codex events:

- sharp or small-radius geometry;
- mono type for machine output;
- high-contrast ink;
- thin separators;
- compact rows;
- optional scanline/grid texture only when subtle and reference-supported.

## Component behavior

### Buttons

- consistent heights from the scale contract;
- icon and label alignment;
- no theme-specific text size inflation;
- active/hover/focus/disabled states distinct;
- primary actions do not rely only on glow.

### Inputs

- labels outside or clearly associated;
- placeholders muted, not confused with values;
- no bright white default browser fills;
- theme-correct caret and selection;
- stable height and padding.

### Cards

- use material recipe appropriate to the theme;
- content hierarchy, not border quantity, creates structure;
- avoid cards inside cards inside cards;
- illustration cards reserve an art region;
- no text unintentionally over art.

### Lists/catalogs

- compact row summary;
- aligned metadata columns;
- concise status;
- one obvious action;
- details through expansion or secondary panel.

### Dialogs/settings

- use the sizing contract;
- body scroll only;
- predictable close/escape/focus behavior;
- theme art kept out of controls;
- no washed-out disabled text.

### Tooltips/popovers

- consume shared scale;
- theme-specific surface but stable geometry;
- no full-page blur;
- no text selection styling that looks permanently active.

## Accessibility

- preserve semantic roles and labels;
- visible focus in every theme;
- minimum contrast for text and controls;
- color is not the only state cue;
- reduced motion disables petals, nonessential token animation, and decorative entrances;
- forced colors removes decorative backgrounds and exposes clear system borders;
- zoom and OS scaling do not clip dialog controls;
- animated art has `aria-hidden="true"` unless it conveys status.

## Performance

- use CSS variables and shared classes rather than rerendering the tree on every animation frame;
- animate transforms/opacity, not layout;
- cap particle count;
- pause decorative animation when window/document is hidden;
- use one token-rate subscription and one animation loop;
- lazy-load large reference art;
- decode images before revealing when possible;
- do not add per-component polling timers;
- clear observers/listeners on unmount.

## Theme leakage checks

For each theme switch, verify:

- no previous theme background remains;
- no wrong-theme font remains on newly opened dialogs;
- portal-based popovers inherit current theme;
- detached/companion windows receive current semantic tokens;
- code blocks and tooltips update;
- petal/empty-state art updates or disappears correctly;
- no hardcoded blue, orange, black, or white panel violates the active appearance.
