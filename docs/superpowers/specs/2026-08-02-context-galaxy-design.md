# Context Galaxy Design

## Objective

Turn the existing Context Map renderer into a usable, pannable 3D galaxy while preserving its
persisted maps, source tree, notes, templates, workspaces, saved views, retrieval contracts, and
large-map safety. Embed the same live graph beneath the transcript in the expanded voice panel.

## Architecture

`ContextGalaxy` is a reusable renderer with `full` and `compact` presentations. It consumes the
existing immutable node/edge projection and selected/highlighted node IDs; it does not own or
rewrite Context data. `contextGalaxyLayout.ts` deterministically projects the current hierarchy
into clustered three-dimensional coordinates, derives camera matrices and level-of-detail, and
keeps geometry independently testable.

WebGL2 is the primary renderer. It draws bounded visible edges and points in a small number of
buffers, projects only the nearest useful labels into an HTML overlay, and invalidates frames only
after camera, selection, resize, or real activity changes. It does not add Three.js or a continuous
background task. Unsupported WebGL2, forced 2D, reduced motion, and context loss use the existing
2D graph behavior.

## Interaction and accessibility

- Primary drag orbits; Shift+drag and middle/right drag pan; wheel/pinch zooms.
- Reset, 2D/3D mode, zoom, and keyboard-node controls are explicit semantic buttons.
- A compact searchable/list alternative exposes nodes, selection, descriptions, and relationships
  without requiring spatial perception.
- Labels are limited by distance, importance, selection, and compact/full mode.
- Reduced motion disables pulses and camera interpolation while retaining direct controls.
- Focus indicators, live selection announcements, 200% zoom/reflow, and forced-colors fallback are
  preserved.

## Meaningful galaxy structure

The root is the galactic center. Real first-level source families form deterministic sectors; their
descendants occupy bounded spiral arms and depth shells. Source, note, template, workspace, and view
labels retain their existing names because they represent real persisted concepts: inputs, authored
knowledge, reusable structures, working collections, and saved projections. Descriptions explain
those purposes rather than renaming data categories.

Only nodes identified by the existing Jarvis retrieval/activity contract pulse. Decorative random
flashes and simulated processing are forbidden.

## Voice embedding

The expanded voice panel renders `JarvisVoiceTranscript`, then a compact Context Galaxy, then the
existing Command Center. The compact graph shares the current account/project map projection,
selection and real activity state; it uses a hairline separator, fewer labels, bounded height and no
heavy panel border. Missing project/map or unsupported graphics produces a concise accessible
fallback rather than an empty canvas.

## Performance and failure handling

- Reuse the cooperative worker and graph-performance index already used by Context.
- Cap rendered nodes, edges, labels and animated activity nodes per frame.
- Cluster distant nodes and progressively reveal descendants as camera distance decreases.
- Pause rendering while hidden and release WebGL resources on unmount/context loss.
- Keep the last valid projection if worker/layout work fails.
- Never modify map data because of renderer failure.

## Verification

Focused tests cover deterministic 3D layout, clustering/LOD bounds, camera controls, activity-only
animation, reduced-motion and WebGL fallback, keyboard selection, compact voice placement and
unchanged Context data behavior. Manual verification covers orbit/pan/zoom, selection details,
context loss/fallback, narrow layout, 200% zoom, forced colors and expanded voice presentation.

## Rollback

Remove the reusable galaxy component/layout and restore the ContextPage renderer call plus the
VoiceModal embed. No persisted schema or map data changes are involved.
