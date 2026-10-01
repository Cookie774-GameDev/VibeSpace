# Reference Manifest and Precedence

## Reference precedence

When sources disagree, use this order:

1. The target image/reference file for the exact theme and screen.
2. The theme's reference folder as a whole.
3. The Sakura `index.html` implementation for Sakura material/effect behavior.
4. The written theme specification in this documentation pack.
5. Existing VibeSpace interaction and accessibility behavior.
6. Existing implementation styling.

Do not preserve an existing visual defect merely because it is already implemented.

## Required local reference sources

The execution agent must inspect these exact Windows paths before editing:

### MonoChrome

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\MonoChrome
```

Use every relevant image in the folder. Build a quick visual inventory covering:

- shell and navigation;
- chat and empty states;
- settings/dialogs;
- tooltips/popovers;
- cards and data-heavy pages;
- terminal/code output;
- typography and density.

### Warm

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Warm
```

Inspect images at original resolution. Do not judge them from Windows thumbnail previews. Identify whether an illustration is a page background, a card illustration, a header scene, or a decorative side object before placing it.

### Origami

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Origami
```

The ninth through thirteenth images described in the source request belong to this theme. Treat the relevant chat screens as pixel-reference targets. The boat and flower empty states are both valid and must be implemented.

### Sakura preview

```text
C:\Users\viper\Downloads\VibeSpace-Sakura-UI-Preview (1)\VibeSpace-Sakura-UI-Preview\index.html
```

Open the preview in a browser, not only in a text editor. Inspect:

- computed colors;
- background artwork/layers;
- glass opacity and blur;
- border highlights;
- shadow composition;
- petal DOM/canvas implementation;
- petal speed controls;
- z-index and pointer-event behavior;
- typography and spacing;
- responsive behavior.

Read linked CSS, JavaScript, images, fonts, and SVG files. Reuse only assets and implementation ideas that are safe and compatible with the app; do not blindly paste a standalone preview into production.

## Current-state evidence from the source request

The source request included representative current-state screenshots. They are not design targets; the observations below transcribe the regressions that must be eliminated. Inspect the original attached screenshots when they are available in the execution environment.

### Attached screenshot — Build Your Own AI overview

Observed problems to investigate:

- mascot/sprite overlaps top shell and page content;
- serif headings and body type are too large for the information density;
- cards consume excessive height;
- step cards and right rail feel heavy rather than refined;
- page does not maintain a clear scale hierarchy;
- bottom content is clipped in a normal desktop viewport.

### Attached screenshot — Build Your Own AI wizard

Observed problems:

- modal nearly fills the viewport without enough composition discipline;
- tabs, fields, and training method cards are oversized;
- large empty/flat brown areas reduce hierarchy;
- content scroll and bottom controls compete;
- close control, header, tabs, and body do not form a polished dialog frame.

### Attached screenshot — Phone & Voice settings

Observed problems:

- selected/highlighted-looking text and inconsistent surfaces make the page appear broken;
- very long copy blocks dominate the panel;
- cards and line lengths are too large;
- mascot overlaps settings navigation;
- hierarchy is weak between title, provider status, form, and explanation.

### Attached screenshot — Local Models settings

Observed problems:

- model rows are too tall and copy-heavy;
- badges and metadata do not scan quickly;
- action areas are visually detached;
- the list does not feel like a compact model catalog;
- internal scrolling and viewport use are inefficient.

### Attached screenshot — Accessibility settings

Observed problems:

- cards are oversized for the amount of content;
- large serif headings conflict with dense settings usage;
- copy line length is excessive;
- the navigation and body lack a crisp shared scale;
- the modal feels like a web article rather than a desktop settings surface.

## Reference inventory procedure

At the start of execution:

1. List filenames, dimensions, and file types for each reference folder.
2. Create a temporary inventory table containing:
   - reference ID;
   - theme;
   - route/surface;
   - resolution/aspect ratio;
   - primary palette;
   - typography;
   - surface material;
   - illustration role;
   - unique interaction/motion;
   - implementation notes.
3. Keep that table in working notes; do not create a second implementation plan.
4. Match each target route to one or more reference IDs before editing it.
5. Do not use screenshots from unrelated themes to fill missing details.

## Asset rules

- Preserve original assets; write processed copies to the app asset directory.
- Never overwrite the reference source files.
- Prefer supplied SVG/PNG/WebP assets over low-quality screenshots.
- Preserve alpha and color profile when processing.
- Use high-density assets; avoid upscaling a small raster until it looks blurred.
- Crop intentionally; do not stretch.
- Remove a background only when the reference clearly treats the object as transparent.
- Do not put text over an illustration unless the exact reference does so.
- Do not add invented AI-generated art when a supplied reference asset exists.
