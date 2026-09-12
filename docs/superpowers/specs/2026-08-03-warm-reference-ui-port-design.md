# Warm Reference UI Port Design

## Decision

Port the supplied Warm reference into the existing `warm` appearance in place.
Production components, stores, handlers, routes, native integration, and
accessibility semantics remain the functional source of truth. The supplied
`index(12).html` and its embedded assets are the visual source of truth.
Default, Monochrome, and Jarvis remain unchanged.

## Architecture

The port is a scoped presentation layer:

1. Exact reference assets live under `app/public/assets/themes/warm/reference/`.
2. `app/src/styles/warm-theme.css` owns centralized Warm tokens, shared shell
   materials, reusable paper/control primitives, and route-specific selectors.
3. Existing semantic markers such as `data-monochrome-route`,
   `data-monochrome-surface`, and `data-vibespace-page` connect production
   components to the Warm presentation layer.
4. Components change only when a truthful state marker or inert decorative
   asset host is required. Existing handlers, labels, test IDs, and focus order
   remain attached to their production controls.

## Visual System

- Geometry begins with the reference values: 320px sidebar, 65px top bar, and
  50px tab strip, with responsive production-safe reductions.
- Shell surfaces use layered walnut gradients based on `#332a22`, `#3b3027`,
  and `#46392e`.
- Workspace surfaces use `#faefe2`, `#f6e9d8`, and translucent warm paper
  cards with one-pixel brown borders, inset highlights, and restrained shadows.
- Serif typography is limited to route headings and editorial card titles;
  sans remains the utility face and monospace remains exclusive to code/data.
- Motion is limited to 140–220ms hover, focus, and state transitions with a
  complete reduced-motion fallback.
- Decorative artwork is pointer-inert, state-aware, and hidden when it would
  obscure live content.

## Route Coverage

Chat, Files, Kanban, Scheduler, Skills, and Tools reproduce the supplied
reference compositions using real production state. Settings, Workbench,
Terminals, Benchmarks, History, Agents, profile/account, and remaining routes
extend the same paper, shell, timeline, split-pane, and dense-data patterns
without changing their layouts or behaviors.

## Verification

The implementation requires focused contract tests, affected production
component tests, TypeScript, a production build, keyboard/reduced-motion checks,
and screenshots at 1672×941, 1440×900, 1280×800, and one supported narrow
viewport. Visual claims must be limited to evidence actually captured.
