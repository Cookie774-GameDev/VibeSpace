# Taskbar AI Usage Module — UI and Theme Integration Design

## Goal

Make the existing usage-module setting produce a real, visible, compact taskbar-adjacent module. Preserve the production/data requirements in:

```text
docs/ideas/TASKBAR_AI_USAGE_MODULE.md
```

This document focuses on the visual implementation and integration with the theme-restoration goal. Where requirements overlap, the production repair document remains authoritative for data truth, lifecycle, security, and performance.

## Non-negotiable truth rule

Never display guessed usage, fake progress, invented quota, or a connected state inferred only from a provider name.

A provider row may truthfully show:

- live local activity;
- authoritative quota;
- cached/stale authoritative quota;
- connected but quota unavailable;
- disconnected;
- error/degraded.

## Window behavior

- enabling creates or reveals exactly one module;
- disabling closes it and stops subscriptions/timers;
- an enabled-but-invisible state is forbidden;
- recover off-screen placement;
- restore after restart when enabled;
- stable native label;
- no duplicate windows after repeated toggles;
- browser preview shows a clear desktop-only preview/error instead of pretending a native window exists.

## Compact geometry

Use the existing specification bounds:

- collapsed strip about `280 × 36px`;
- expanded compact panel about `340 × 128px`.

Normal view shows exactly the user-ranked top two provider rows. Do not show four rows merely because an old reference did.

### Row layout

Each row has stable columns:

```text
provider icon/name | state/activity | thick compact bar or unavailable | value
```

- fixed-width number region;
- tabular numerals;
- no resize as values change;
- compact status glyph;
- no multi-line marketing descriptions;
- `Quota unavailable` replaces an invalid empty bar.

## Theme projection

The companion window receives serialized semantic tokens from the main appearance store. It must update immediately when the user changes theme without resizing or remounting the window.

Required semantic values:

- base surface;
- elevated/inset surface;
- border;
- primary text;
- muted text;
- accent;
- success;
- warning;
- danger;
- focus;
- shadow;
- radius;
- font roles/density.

### MonoChrome module

- near-black/graphite;
- crisp one-pixel border;
- square/small radius;
- mono labels/numbers;
- white/gray bar;
- no blur or warm glow.

### Sakura module

- compact translucent dusk glass;
- enough opacity for taskbar readability;
- Sakura accent;
- subtle edge highlight;
- restrained blur;
- no petals inside the tiny module unless the reference explicitly requires them.

### Origami module

- soft folded-paper card;
- pastel edge/accent;
- directional shadow;
- compact sans;
- no glass blur;
- provider logos remain legible.

### Warm module

- dark parchment/wood surface;
- cream text;
- terracotta/honey accents;
- warm shadow;
- no bright white panel;
- no large illustration inside the tiny module.

## Live update architecture

- request start/settle/cancel/error events update local activity immediately;
- one shared coordinator reconciles aggregate state at least every five seconds while enabled;
- remote quota is refreshed at provider-safe intervals, not every five seconds;
- visible top-two providers receive priority;
- cache/dedupe/jitter/backoff;
- abort on disable or account/mode change;
- no work while disabled.

## Provider coverage

Use the data-driven 30+ provider registry in the existing production repair document. A registered family is allowed to support:

- detection only;
- activity only;
- quota only when authoritative;
- full support.

The UI must not imply that every provider exposes quota.

## Settings UI

The settings section should be compact:

- `Show taskbar usage module`;
- `Launch with VibeSpace`;
- verified status;
- provider order;
- hidden providers;
- reset position;
- retry when degraded.

Do not embed a duplicate provider key manager. Reuse already connected provider, OAuth, CLI, and local-runtime state.

## States

### Disabled

Show setting off and no background work.

### Starting

Small progress state with bounded timeout.

### Running

Show module visible and last reconciliation time only if useful.

### No providers

`No AI providers connected` and a navigation action to existing provider settings.

### Connected / quota unavailable

Show live activity and `Quota unavailable`.

### Stale/offline

Show last authoritative value with stale/offline label.

### Window error

Settings must show a clear error plus `Retry` and `Reset position`. Do not silently keep a meaningless enabled toggle.

## Accessibility

- keyboard-accessible expanded controls;
- visible focus;
- status not color-only;
- concise accessible names;
- forced colors fallback;
- reduced motion;
- correct scaling under Windows DPI;
- no tiny click targets below reasonable desktop limits.

## Acceptance criteria

- [ ] Setting on produces a visible module or actionable error.
- [ ] Setting off removes module and all owned work.
- [ ] Exactly two top-ranked providers appear normally.
- [ ] Theme switches update module immediately.
- [ ] Five-second aggregate reconciliation works.
- [ ] Local activity updates without waiting five seconds.
- [ ] Remote APIs are not polled blindly every five seconds.
- [ ] Thirty-plus families use one registry.
- [ ] Unsupported quota is labeled unavailable.
- [ ] One adapter failure does not break other rows.
- [ ] No secrets enter the companion webview, UI state, logs, or screenshots.
- [ ] Idle resource use remains within the existing production-repair budget.
