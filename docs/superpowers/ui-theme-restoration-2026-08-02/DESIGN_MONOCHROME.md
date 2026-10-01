# MonoChrome Design Specification

## Goal

Make MonoChrome feel like a refined developer console/editor: precise, dense, crisp, readable, and intentionally monochromatic. The current defect is not merely one settings screen; typography and container scale are wrong across tooltips, settings, dialogs, cards, and other routes.

## Reference source

```text
C:\Users\viper\VibeSpaceOs\VibeSpace-IDEAS!\VibeSpace UI Themes\MonoChrome
```

Inspect all images before choosing values. Reference measurements outrank the approximate values below.

## Visual identity

- black, graphite, charcoal, off-white, and controlled gray;
- optional single neutral accent or inverted selection treatment only when shown by reference;
- editor/terminal density;
- thin, confident borders;
- minimal radius;
- almost no decorative glow;
- monospace used deliberately;
- clean hover and focus states;
- no warm brown, Sakura coral, or generic blue leakage.

## Typography

Preferred roles:

- UI body/navigation: compact sans or mono according to the exact reference;
- terminal/tool output: JetBrains Mono/Cascadia Code;
- headings: no oversized decorative serif;
- metadata: mono/tabular where it improves alignment.

Default density should behave like compact:

- body around `12.5–13px`;
- metadata `10.5–11.5px`;
- navigation `12–13px`;
- section heading `14–16px`;
- dialog title `18–22px`;
- page title usually `22–28px`;
- tooltip `11–12px`.

Fix the semantic utilities globally. Do not apply `font-size` to every MonoChrome descendant with a broad selector that breaks code editors or terminals.

## Geometry

- radius: `0–6px` depending on reference;
- borders: `1px`, sharp, visible;
- controls: `28–34px`;
- cards: compact and content-driven;
- dividers: frequent but subtle;
- shadow: minimal; use border contrast first;
- selected nav/chat: inverse or restrained fill, not a rounded warm pill.

## Settings

- left navigation is compact and vertically efficient;
- section content reads like a settings utility, not a marketing page;
- descriptions are concise and limited in width;
- rows align labels, state, and controls;
- large explanatory blocks use disclosure;
- no oversized bordered panels for simple one-control settings;
- tooltip and keyboard shortcut sizing must be tested.

## Dialogs and popovers

- crisp frame;
- small corner radius;
- no brown-tinted backdrop;
- no giant padding;
- title bar and footer align with editor-style rhythm;
- scrollbars are narrow and visible;
- focus ring is high contrast.

## Chat and code output

MonoChrome is the clearest expression of the inline Codex stream:

- transparent/base-canvas assistant stream;
- thin separators and status glyphs;
- mono tool rows;
- code diffs may use a contained code surface;
- no global black assistant card on top of an already dark canvas;
- user message treatment follows the reference, not a warm rounded bubble.

## Tooltips

Known failure area:

- `11–12px`;
- max `280px`;
- compact padding;
- no oversized shortcut chip;
- no inherited page-title or serif class;
- portal inherits MonoChrome theme;
- no animation that makes the tooltip lag behind pointer/focus.

## Color and contrast

Use the reference palette. A safe structure is:

- background: near-black, not pure black everywhere;
- panel: one step lighter;
- elevated: another subtle step;
- border: medium graphite;
- primary text: soft white;
- secondary: neutral gray;
- disabled: visibly dim but readable;
- focus: high-contrast white/gray outline.

Do not use low-opacity gray text on black where it becomes illegible.

## Acceptance criteria

- [ ] Shared settings, tooltips, dialogs, dropdowns, and cards no longer appear oversized.
- [ ] No serif display font appears in dense utility headings unless a reference explicitly uses it.
- [ ] Navigation and list rows fit the reference density.
- [ ] Code/terminal areas preserve their independent user font-size controls.
- [ ] No broad selector strips required radii/backgrounds from interactive controls.
- [ ] No warm/Sakura/Origami color leaks.
- [ ] The primary routes fit at 1600×900 without avoidable clipping.
- [ ] MonoChrome remains readable under compact and cozy density preferences, with compact as the intended presentation.
