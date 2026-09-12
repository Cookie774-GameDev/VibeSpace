# Origami / VibeSpace Design Specification

## Goal

Make the Origami appearance match the supplied reference images as closely as the app's real content allows. This is the strictest visual-match theme in the goal. Color gradients, paper forms, shadows, typography, composition, empty states, and chat treatment must be reference-led rather than improvised.

## Reference source

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\Origami
```

The relevant source-request images are the ninth through thirteenth reference images. Inspect them at original size.

## Identity

- light, airy, pastel environment;
- folded-paper forms with believable depth;
- soft blue, lavender, blush, mint, and cream gradients as shown;
- gentle directional shadows;
- quiet, clean typography;
- illustration integrated into composition;
- rounded shapes only where the paper design uses them;
- no dark terminal plate as the default assistant response;
- no generic flat SVG look.

The design should feel like a crafted interactive paper world, not a flat pastel dashboard.

## Pixel-match policy

For the designated reference screens:

- reproduce major geometry, ordering, spacing, alignment, gradients, and wording when the wording corresponds to the same screen/function;
- reproduce illustration placement and scale;
- reproduce empty-state composition;
- preserve VibeSpace functionality and accessibility even where an image is purely visual;
- small proportional differences are acceptable when source images use different aspect ratios;
- do not force distorted dimensions or broken responsive behavior merely to hit one screenshot.

At the primary comparison viewport, target a visually near-identical result. If a visible difference is not required by actual app content, refine it.

## New-chat empty state

Two empty-state variants are required:

- folded paper boat;
- folded paper flower.

### Selection

- choose 50/50 when a new chat session is created;
- select once and store the choice for that chat so rerenders do not flicker between variants;
- do not re-randomize on every mount;
- opening the same untouched chat restores its chosen variant;
- a deterministic seeded choice by chat ID is acceptable and preferable for stability.

### Lifecycle

- display the selected art only when the chat has no user or assistant messages;
- remove it as soon as the first real message is submitted;
- the first message occupies the composition naturally;
- do not leave `Type your first message`, `No messages yet`, or another placeholder unless the exact reference includes it;
- do not reserve a permanent blank hole after art disappears.

### Accessibility

- decorative art is `aria-hidden`;
- the composer remains keyboard reachable;
- no art intercepts clicks;
- reduced motion removes any floating/bobbing animation but keeps the static illustration.

## Paper material system

### Base surfaces

- tinted near-white/pastel paper;
- subtle vertical or diagonal gradient;
- fine edge line;
- soft directional shadow;
- optional fold highlight.

### Elevated paper

- slightly brighter top edge;
- slightly deeper shadow;
- no glass blur;
- no neon glow.

### Folded art

Use supplied transparent assets or reproduce as scalable SVG/CSS only when the source asset is unavailable. Preserve sharp edges and high resolution. Do not use a blurry screenshot crop.

## Gradients

Extract exact stops from the reference where possible. Gradients should:

- be soft and low contrast;
- support depth rather than look like generic UI gradients;
- maintain text contrast;
- remain stable across cards instead of using random colors;
- align with the reference's lighting direction.

## Typography

Use the reference font(s). Keep the scale within the shared contract:

- body `13–14px`;
- metadata `11–12px`;
- section `15–17px`;
- page title `24–32px`;
- empty-state title may be larger only if present in reference.

Do not apply the Warm serif system to Origami unless the references clearly show it.

## Chat

- canvas/background remains visible;
- user input and user messages match the paper composition;
- assistant execution output is inline per `DESIGN_CODEX_CHAT.md`;
- code blocks may use a light paper/code inset with sufficient contrast;
- no oversized black assistant panel;
- status lines and tool rows remain compact;
- art disappears after first message.

## Navigation and chrome

- soft paper/pastel shell;
- selected state follows reference;
- icons use coherent line weight;
- divider and shadow direction match the material;
- no heavy dark left rail unless reference shows it;
- mascot/animation is placed in its designated tiny sidebar slot only.

## Cards and pages

For Kanban, Schedule, Settings, Build Your Own AI, and other routes:

- keep the same material hierarchy;
- avoid turning every region into an independent rounded white card;
- use paper layers, separators, and illustration slots;
- keep data-heavy content compact;
- remove or recompose decorative art when it would cover real data;
- text never unintentionally overlays a folded illustration.

## Acceptance criteria

- [ ] Primary reference screens are visually near-identical at the chosen comparison viewport.
- [ ] Exact palette and gradient direction are derived from reference assets.
- [ ] Paper depth reads through edge light and directional shadow.
- [ ] Boat and flower variants are selected 50/50 per new chat.
- [ ] The chosen variant is stable for that chat.
- [ ] Empty art disappears after first message with no placeholder residue.
- [ ] Chat output remains inline and theme-compatible.
- [ ] No flat generic pastel cards, glass blur, brown Warm styling, or giant dark panel remains.
- [ ] Asset edges remain sharp at 100% and 125% display scale.
