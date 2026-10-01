# Codex-Style Chat and Token Animation Design

## Goal

Keep VibeSpace's chat canvas and display assistant execution output in a Codex-inspired inline terminal language. Do not put the assistant inside a separate black panel. The terminal feeling belongs to the output rows, cursor, code blocks, and tool events—not to an opaque rectangle covering the theme.

## Remove the incorrect implementation

Remove or refactor the surface that displays:

```text
I'm ready for your next task.
```

inside a large black assistant box.

Also remove generic new-chat copy such as:

```text
Type your first message
```

when it is not present in the active theme reference.

Do not leave dead spacing after removal.

## Layout model

```text
existing themed chat canvas
  ├─ optional theme empty-state art (only before first message)
  ├─ user message/request treatment
  ├─ inline assistant stream
  │    ├─ thinking/progress status
  │    ├─ tool/read/search rows
  │    ├─ code-change/diff rows
  │    ├─ review/result text
  │    └─ streaming cursor
  └─ existing composer
```

The assistant stream participates in normal message flow. It does not mount an additional full-width background panel.

## Inline stream primitives

Create or consolidate reusable primitives such as:

- `AssistantStream`;
- `StreamSection`;
- `ToolEventRow`;
- `FileEventRow`;
- `CommandEventRow`;
- `CodeDiffBlock`;
- `ProgressRow`;
- `StreamingCursor`;
- `FinalResponse`.

Names may differ. The important rule is a normalized event model with theme-aware presentation.

## Visual language

### Machine/action rows

- compact mono text;
- small icon/glyph;
- optional left rule or subtle separator;
- timestamp/duration only when useful;
- no giant badge;
- state: pending/running/success/error/canceled;
- details collapsible.

### Natural-language response

- theme's UI/body font;
- readable line width;
- no terminal font forced on all prose;
- markdown/code remains correct;
- no opaque outer card unless the exact theme reference contains one.

### Code blocks/diffs

A contained surface is allowed for code. It must be smaller than the full assistant message and use theme tokens.

- syntax readable;
- line numbers optional;
- additions/deletions distinct and accessible;
- horizontal scroll contained;
- copy control compact;
- no wrong-theme pure-black block in light Origami unless the reference deliberately uses it.

### Streaming cursor

- thick block or bar inspired by Codex;
- appears only while streaming;
- respects reduced motion;
- color adapts to theme;
- does not cause line reflow.

## User request treatment

Preserve the user's desired compact request-bar treatment where it already exists or is specified by the reference. It may be a long horizontal strip rather than a speech bubble. It must:

- remain visibly distinct from assistant events;
- use active theme material;
- avoid covering background art;
- support multiline input;
- remain accessible.

## Empty-state behavior by theme

- Origami: 50/50 boat or flower, stable per chat.
- Sakura: reference-led environment/empty composition.
- Warm: supplied illustrated empty state, if present.
- MonoChrome: compact terminal/editor prompt state, if present.

All empty states disappear after the first real message. They must not coexist with message history.

## Sidebar token animation

The animation described in the source request is not a large content animation. It belongs as a tiny status object in the left chat list/inspector region indicated by the references.

### Placement

- inside an explicit slot in the chat navigation/inspector;
- visually near the chat list header or designated marked region;
- small enough not to push labels or rows;
- never in the top shell;
- never overlapping mascot, tabs, or scrollbars;
- anchored to the sidebar container, not viewport coordinates.

Approximate bounds until measured from reference:

- width `24–44px`;
- height `16–32px`;
- preserve aspect ratio.

### Transparent asset

- use the supplied animation source;
- remove the visible background rectangle non-destructively;
- preserve alpha and edge quality;
- use a processed copy;
- do not rely on `mix-blend-mode` as the only background-removal method if it creates halos.

### Theme adaptation

Use one of these, in preference order:

1. supplied per-theme asset/color frames;
2. mask/SVG/currentColor;
3. CSS filter derived and visually checked;
4. canvas recolor of non-alpha pixels.

Do not tint skin/mascot art incorrectly. Only recolor the intended animation element.

### Token-rate binding

Animation speed must reflect real assistant output rate.

Use a smoothed rate:

```ts
instantRate = emittedTokens / elapsedSeconds
emaRate = alpha * instantRate + (1 - alpha) * previousRate
```

Map the rate to a bounded playback multiplier:

```ts
playback = clamp(0.35, 2.5, base + scale * normalizedRate)
```

Requirements:

- idle/stopped state when no stream is active;
- gentle low-speed state during slow output;
- visibly faster state during high throughput;
- no frame-by-frame React state storm;
- update rate at a modest interval, for example `250–500ms`;
- reset cleanly on completion/cancel/error;
- use measured token events when available;
- if exact token counts are unavailable, use emitted text length only as an explicitly local visual proxy, never label it as tokens per second;
- reduced motion freezes or simplifies animation.

## Functional preservation

- message selection/copy works;
- markdown links and code controls work;
- streaming can cancel;
- scroll anchoring remains stable;
- history restores;
- theme switching during a stream does not restart or lose output;
- no background asset blocks input;
- terminal/code mode behavior remains separate from actual PTY terminals.

## Acceptance criteria

- [ ] No large black assistant panel remains.
- [ ] Assistant output appears directly in the themed chat flow.
- [ ] Tool/code/change/review events are visually Codex-like and compact.
- [ ] Prose remains readable and not entirely monospace.
- [ ] `Type your first message` is removed where references omit it.
- [ ] Theme empty state disappears after first message.
- [ ] Token animation is in the left chat sidebar slot.
- [ ] Animation background is transparent.
- [ ] Animation tint adapts per theme.
- [ ] Playback speed responds to real streaming rate and is bounded.
- [ ] Reduced motion is respected.
