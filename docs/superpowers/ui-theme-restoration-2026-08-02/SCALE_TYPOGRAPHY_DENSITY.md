# Scale, Typography, and Density Contract

## Problem

The current scale failure is cross-cutting. Text, cards, settings rows, dialogs, tooltips, and page layouts have drifted too large. Fixing individual screenshots with scattered overrides will leave the same defect elsewhere.

The solution is a shared, density-aware scale system consumed by all themes. Theme identity may change fonts, material, color, and selected display sizes, but it must not break functional density.

## Required token model

Create or consolidate semantic variables similar to:

```css
:root {
  --vs-font-ui: "Plus Jakarta Sans", Inter, system-ui, sans-serif;
  --vs-font-display: Fraunces, Georgia, serif;
  --vs-font-mono: "JetBrains Mono", "Cascadia Code", monospace;

  --vs-text-2xs: 10px;
  --vs-text-xs: 11px;
  --vs-text-sm: 12px;
  --vs-text-body: 13px;
  --vs-text-label: 13px;
  --vs-text-ui-strong: 13px;
  --vs-text-section: 15px;
  --vs-text-title-sm: 18px;
  --vs-text-title: 24px;
  --vs-text-hero: 30px;

  --vs-leading-tight: 1.15;
  --vs-leading-ui: 1.35;
  --vs-leading-body: 1.5;
  --vs-leading-copy: 1.6;

  --vs-control-h-sm: 28px;
  --vs-control-h: 32px;
  --vs-control-h-lg: 36px;

  --vs-space-1: 4px;
  --vs-space-2: 8px;
  --vs-space-3: 12px;
  --vs-space-4: 16px;
  --vs-space-5: 20px;
  --vs-space-6: 24px;
  --vs-space-8: 32px;
}
```

Names may differ to fit the repository, but the semantics must exist. Existing utilities such as `text-page-title`, `text-secondary`, `text-metadata`, and `text-ui-strong` must resolve through the shared scale rather than isolated arbitrary sizes.

## Density modes

### Compact

Use for high-information screens and MonoChrome by default.

- body: `12.5–13px`;
- metadata: `10.5–11.5px`;
- label/button text: `12–13px`;
- row height: `28–32px`;
- input height: `30–34px`;
- card padding: `10–14px`;
- settings section gap: `16–20px`;
- navigation item: `28–32px`;
- line height: `1.35–1.5`.

### Cozy

Use for Warm, Sakura, and Origami where the reference permits more breathing room.

- body: `13–14px`;
- metadata: `11–12px`;
- label/button text: `13px`;
- row height: `32–36px`;
- input height: `34–38px`;
- card padding: `14–18px`;
- settings section gap: `20–24px`;
- navigation item: `32–36px`;
- line height: `1.45–1.6`.

Cozy does not mean oversized. It adds controlled spacing, not larger paragraphs and giant cards.

## Desktop title hierarchy

Recommended bounds:

| Role | Compact | Cozy | Notes |
|---|---:|---:|---|
| metadata / badge | 10–11px | 11–12px | uppercase tracking only when useful |
| secondary copy | 11.5–12.5px | 12–13px | maximum readable line length |
| body | 12.5–13px | 13–14px | default app text |
| strong UI label | 12.5–13px | 13–14px | medium/semi-bold |
| section heading | 14–16px | 15–17px | avoid display serif in dense lists |
| dialog title | 18–22px | 20–24px | one line where possible |
| page title | 22–28px | 24–30px | only one per page |
| hero/empty state | 28–38px | 30–42px | chat empty state only |

Do not render ordinary settings section headings at hero sizes.

## Width and line-length rules

- settings body copy: `48–72ch`, preferably under `64ch`;
- compact card copy: `32–55ch`;
- tooltip: `220–320px`, never page-width;
- dialog body: use columns or progressive disclosure instead of `100ch` paragraphs;
- model/provider descriptions: one or two lines in the list; move long detail into expansion;
- badges may not wrap into tall pills unless the reference explicitly does.

## Settings dialog contract

At common desktop sizes:

```css
width: min(1240px, calc(100vw - 64px));
height: min(760px, calc(100vh - 72px));
min-width: 760px; /* desktop app; use responsive fallback below this */
```

- left navigation: `220–250px`;
- body header remains visible where appropriate;
- body scrolls independently;
- close button never overlaps title or scrollbar;
- no page content should be hidden behind mascot art;
- one settings card should not exceed the height of a normal paragraph and control unless its content genuinely requires it;
- use sections, dividers, compact rows, and disclosure instead of stacking enormous bordered panels.

## Wizard/dialog contract

For Build Your Own AI and similar workflows:

- max width around `1120–1220px`;
- max height `calc(100vh - 80px)`;
- header, stage navigation, body, and footer are distinct regions;
- only body scrolls;
- stage tabs fit without overflowing at the primary desktop viewport;
- method cards use concise summary text and comparable heights;
- disabled methods remain readable and explain why, without low-contrast walls of copy;
- footer controls remain visible and do not cover content.

## Card sizing

A card must derive height from content. Avoid fixed minimum heights unless rows must align within a specific reference composition.

Recommended compact card recipe:

- padding `12–16px`;
- title-to-copy gap `4–6px`;
- internal group gap `8–12px`;
- radius from theme;
- border/shadow from theme;
- no more than one paragraph visible before disclosure on settings/catalog screens.

## Tooltip and popover sizing

This is a known MonoChrome problem and must be checked globally.

- tooltip font `11–12px`;
- line height `1.35–1.45`;
- padding `6–9px 8–10px`;
- max width `280px`;
- keyboard shortcut on one aligned line when possible;
- no large serif text;
- no oversized radius;
- no hover surface that changes layout.

## Responsive floor

The app is desktop-first, but narrower windows must not break.

At widths below approximately `900px`:

- collapse or overlay the settings navigation;
- reduce multi-column grids to one column;
- preserve scroll;
- keep primary controls visible;
- do not shrink text below the compact minimum;
- do not scale the entire application with transforms.

## Theme overrides

Theme overrides may alter:

- font family by role;
- letter spacing;
- selected title size within the bounds above;
- control geometry;
- material and decoration.

Theme overrides may not:

- multiply body text size;
- make settings cards twice as tall;
- replace semantic utilities with page-specific arbitrary values;
- use different base scales on random routes;
- force text overflow to imitate a screenshot.

## Acceptance checks

Check all five current-state screenshot surfaces after the shared scale refactor. The same routes should:

- fit materially more content without feeling cramped;
- show clear title/section/body/metadata hierarchy;
- avoid clipped bottom rows;
- keep line lengths controlled;
- keep controls at desktop-application density;
- remain legible at 100%, 125%, and 150% OS scaling where browser emulation permits.
