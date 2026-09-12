# Workbench Fullscreen Controls Design

## Objective

Keep the existing Workbench appearance and behavior while correcting three defects visible in `Screenshot 2026-08-03 213736.png`.

## Approved behavior

- The fullscreen-exit control stays compact but moves left into the upper action row beside the Add pane controls so it cannot cover adjacent buttons.
- Fullscreen transitions preserve the native main window's visible, unminimized, focused state after Windows applies fullscreen.
- The Workbench palette reveals through a 72-pixel left-edge hot zone, matching its width closely enough that users do not need to target the exact screen edge.
- Existing layout, themes, panel behavior, persistence, and native fullscreen authority remain unchanged.

## Verification

- Focused contract tests cover control placement and the 72-pixel reveal threshold.
- Native adapter tests cover show, unminimize, and focus after the fullscreen transition.
- Existing focused Workbench and fullscreen tests remain green.
