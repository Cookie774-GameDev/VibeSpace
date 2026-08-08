# Warm / Default Design Specification

## Goal

Restore the Warm appearance to the supplied darker, crafted, dimensional reference direction. The current implementation is too bright, too white, too flat, too text-heavy over imagery, and uses illustrations that look like low-resolution PNGs rather than integrated scenes.

## Reference source

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Warm
```

Inspect all images at original resolution and identify each image's role before implementation.

## Identity

- warm dark cream, cocoa, walnut, muted terracotta, honey, sage, and parchment;
- darker overall luminance than the current bright implementation;
- hand-drawn/sketched or illustrated quality;
- dimensional scenes with clear foreground/midground/background;
- soft warm shadows;
- controlled paper/wood texture;
- cozy without becoming muddy;
- polished desktop-app density.

The target is not a solid brown theme. It must have tonal depth and purposeful art direction.

## Palette

Derive colors from the target images. Establish:

- deep environment/background;
- navigation/shell;
- base paper panel;
- elevated paper;
- inset/input;
- primary cream ink;
- secondary warm gray;
- terracotta accent;
- honey accent;
- sage success;
- warning/danger;
- illustration shadow/highlight.

Lower the overall value of the current base where references are darker. Preserve readable contrast.

## Illustration treatment

### Placement

Every illustration gets an explicit layout role:

- hero/header scene;
- card-side scene;
- page corner object;
- empty-state art;
- background environment.

Do not set a page illustration as an undifferentiated stretched background and then place arbitrary text over it.

### Text safety

- reserve a text-safe region;
- use grid columns or a dedicated art slot;
- if the exact reference overlays text, reproduce the reference's contrast treatment;
- otherwise, no text on top of the image;
- avoid accidental selection/highlight-looking blocks.

### Dimensional quality

A valid scene should show:

- sharp source resolution;
- clear light direction;
- layered shadows;
- believable depth;
- controlled perspective;
- integration with the panel;
- no white rectangular background around a supposedly transparent asset.

### Asset resolution

- prefer supplied high-resolution transparent assets;
- use `image-set`/high-density raster where useful;
- do not enlarge a 720p crop to fill a large desktop panel;
- do not blur the whole image to hide low quality;
- use object-fit and crop deliberately;
- preserve alpha.

## Build Your Own AI

The current-state screenshots show current scale problems. The repaired Warm version should:

- keep the page darker and calmer;
- use a compact, refined title and support copy;
- make the blueprint sequence scan horizontally without giant cards;
- keep hardware/status rail compact;
- prevent mascot overlap;
- fit primary content in a normal desktop viewport;
- use illustration only where it adds comprehension;
- separate RAG from weight training truthfully without walls of copy.

### Wizard

- polished framed dialog;
- compact stage navigation;
- concise method cards;
- readable disabled state;
- stable footer;
- no huge uninterrupted brown field;
- no clipped bottom controls;
- art/header composition matches the Warm reference.

## Schedule and other illustration-heavy pages

The Schedule image is specifically reported as poor quality. Repair by:

- locating the correct supplied asset;
- using the original/highest-resolution file;
- placing it in the correct scene slot;
- matching reference crop and depth;
- eliminating the pasted-PNG look;
- keeping data and controls separate from the art;
- testing at 100%, 125%, and 150% scale.

## Settings

- warm desktop utility, not a long-form article;
- smaller headings;
- compact rows and cards;
- concise visible copy;
- secondary explanations behind disclosure;
- selected/provider states do not look like browser text selection;
- mascot never covers settings navigation;
- modal uses a dark warm scrim and refined shadow.

## Typography

Use the Warm reference font pairing. A display serif may be used for one page/dialog title or key card title, but:

- not every settings subsection;
- not metadata;
- not buttons;
- not dense provider/model lists.

Recommended:

- body `13–14px`;
- metadata `11–12px`;
- section `15–17px`;
- dialog title `20–24px`;
- page title `25–32px`.

## Texture

Texture should be subtle and local:

- low-opacity paper grain or wood tonal variation;
- no noisy overlay reducing readability;
- no large bitmap repeated visibly;
- disable or simplify under forced colors;
- ensure performance remains stable.

## Acceptance criteria

- [ ] Overall theme is visibly darker and closer to reference luminance.
- [ ] Illustrations are sharp, dimensional, and correctly integrated.
- [ ] No unintended text overlays an image.
- [ ] Settings and Build Your Own AI use desktop-app scale.
- [ ] Schedule no longer looks like a low-resolution pasted PNG.
- [ ] No bright white slabs dominate the theme.
- [ ] Serif is used selectively rather than globally.
- [ ] The theme remains cozy, readable, and polished without muddy contrast.
