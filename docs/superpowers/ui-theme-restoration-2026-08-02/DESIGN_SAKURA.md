# Sakura Design Specification

## Goal

Rebuild Sakura from the supplied preview so it feels like polished cinematic dusk glass, not a recolored brown app. Match the reference palette, translucent depth, blur, border lighting, petal field, and overall refinement throughout the app.

## Authoritative preview

```text
C:\Users\viper\Downloads\VibeSpace-Sakura-UI-Preview (1)\VibeSpace-Sakura-UI-Preview\index.html
```

Open the page and inspect all linked assets/code. Compare computed styles, not only screenshots.

## Visual identity

- dusk sky / deep indigo or plum environment;
- Sakura pink, coral, blush, lavender, and moonlit neutrals;
- translucent glass panels with visible environment behind them;
- polished highlight edges;
- layered depth;
- soft cinematic light;
- controlled bloom;
- animated petals/leaves moving through the scene;
- refined readable type.

The target is clear glass with depth. It is not:

- opaque brown cards;
- a flat pink tint;
- heavy blur that makes text fuzzy;
- frosted white slabs;
- random particle confetti;
- a static background image with no environmental response.

## Palette extraction

During reconnaissance, sample the preview and define semantic colors for:

- environment top/mid/bottom;
- glass base;
- glass hover/elevated;
- border highlight;
- primary/secondary/muted text;
- Sakura accent;
- live/success/warning/danger;
- selection;
- shadow tint;
- bloom tint.

Use a small set of semantic tokens. Do not paste dozens of one-off hex values into page components.

## Environment layers

Recommended order:

1. deep dusk gradient;
2. moon/cloud/tree/landscape art from reference, if present;
3. low-opacity color bloom;
4. petal field;
5. shell glass;
6. content.

Background art should cover gracefully without stretching. Use anchored layers and object positioning that preserve the reference focal point.

## Glass system

Use at least three controlled glass levels:

### Shell glass

- medium transparency;
- strong enough blur to separate shell;
- subtle saturation;
- thin highlight border;
- broad soft shadow.

### Card glass

- slightly more opaque than the shell;
- smaller blur;
- restrained inner highlight;
- clear hover/selected state.

### Nested row/input

- minimal blur or none;
- translucent fill;
- clear border and caret;
- readable without stacking blur indefinitely.

Do not put `backdrop-filter` on hundreds of nested elements if it hurts performance. Use shared layers and pseudo-elements.

## Petal system

The current system is reported as nonfunctional. Repair it end to end.

### Required controls

Every existing speed option must have a visible, measurable effect. Normalize the implementation to clear states such as:

- `off`;
- `slow`;
- `normal`;
- `fast`.

If the UI exposes a continuous slider, map it to stable bounds.

### Behavior

- petals visibly fall/drift across the full workspace, not only one page;
- speed changes apply immediately;
- density and speed are separate when the existing settings distinguish them;
- particles vary subtly in size, rotation, depth, and horizontal drift;
- paths feel organic but not chaotic;
- petals pass behind primary content or at a safe low-opacity foreground layer according to the reference;
- `pointer-events: none`;
- pause when document/window is hidden;
- cap particle count;
- reduced motion forces `off` or an effectively static decorative state;
- switching away from Sakura removes the animation and clears timers/RAF;
- returning restores the saved preference without duplicate loops.

### Implementation choice

Prefer CSS/Web Animations or one small canvas/RAF system. Do not mount one React state update per petal per frame.

## Typography and scale

Use cozy density within the shared limits:

- body `13–14px`;
- metadata `11–12px`;
- section `15–17px`;
- page title `24–30px`.

Use the preview's font stack. Avoid large serif headings on every settings card. Glass does not justify oversized text.

## Components

### Navigation

- translucent vertical shell;
- active item uses Sakura accent and depth;
- labels remain crisp;
- icons are not washed out;
- pet/motif does not cover items.

### Settings/dialogs

- full dialog frame reads as layered glass;
- content remains readable over background;
- body rows are compact;
- selected/connected states use accent plus icon/text, not color alone;
- scrollbars fit the theme.

### Kanban

The Kanban reference is a key target:

- preserve board readability;
- columns and cards use correctly tiered glass;
- background remains visible;
- drag affordances and card separators are polished;
- do not make every card equally opaque;
- petal motion never interferes with dragging.

### Tooltips/popovers

- small glass surface;
- strong text contrast;
- enough opacity to read;
- highlight border;
- no huge blur halo.

## Performance budget

- no continuous layout reads;
- one petal loop;
- prefer transform/opacity;
- conservative blur radii on large surfaces;
- avoid dozens of independently blurred nested cards;
- pause hidden animations;
- no visible jank while dragging Kanban or streaming chat.

## Acceptance criteria

- [ ] The app palette is visually close to the preview, not merely “pink.”
- [ ] Background environment remains visible through shell/cards.
- [ ] Glass has edge light, depth, and readable contrast.
- [ ] All petal speed states work immediately.
- [ ] Reduced motion disables nonessential movement.
- [ ] Petals do not block pointer input.
- [ ] Kanban, settings, chat, dialogs, tooltips, and popovers share the same Sakura material language.
- [ ] No opaque brown/white panels or wrong-theme fonts remain.
- [ ] Theme switching cleans up and restores effects without duplicates.
