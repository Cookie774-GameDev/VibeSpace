# Canvas Ambience, App Brightness, and Fullscreen Design

## Scope

This repair has three bounded outcomes:

1. Every Canvas document owns and persists its own ambience wallpaper.
2. Appearance exposes one VibeSpace-only brightness setting from 0% through 200%.
3. Workbench and Settings control one synchronized fullscreen state in both the installed desktop app and supported browser previews.

No Canvas tools/content behavior, Workbench editor behavior, wallpaper entitlements, theme selection, backend, or external system changes are in scope.

## Canvas ambience

Canvas currently imports the Workbench wallpaper store directly. That makes the two surfaces share both configuration and mutations.

The Canvas document contract will gain an optional, validated wallpaper configuration inside its existing background aggregate. Existing documents that omit it normalize to a safe no-wallpaper/default configuration. The current Canvas document autosave, recovery, revision, account scoping, and optimistic-concurrency paths will therefore save and restore ambience atomically with the Canvas.

`WallpaperPicker` will become controlled: callers provide the current configuration and mutation callbacks. Workbench will pass its existing store adapter; Canvas will update only its active document. The visual catalog and controls remain shared.

Stable catalog/custom media identifiers are stored in the document. Temporary object URLs are never treated as durable document state; cached wallpaper assets are resolved when the document opens and fail safely to their fallback when local bytes are unavailable.

## App brightness

The persisted UI store will own an integer `appBrightness` in the inclusive range 0–200, defaulting to 100. Hydration and setters both clamp invalid values.

Appearance will expose a labeled range control, a numeric percentage, and a reset-to-100 action. A small host applies the normalized multiplier to the VibeSpace root. It does not modify the OS display, other applications, saved wallpaper brightness, theme tokens, or product state.

Brightness has no background worker, polling, animation, or network behavior.

## Fullscreen

Fullscreen adapter initialization must not depend on the global-hotkey runtime flag. `FullscreenHost` will mount for every ordinary VibeSpace workspace surface that exposes fullscreen controls.

The adapter retains Tauri `setFullscreen`/`isFullscreen` as the authoritative installed-app path. When Tauri is absent, a browser adapter uses the standard Fullscreen API when supported. Unsupported environments remain explicitly unavailable. Both paths publish external fullscreen exits into the same store, and Workbench and Settings consume the same pending, active, availability, and error state.

The browser fallback is a preview/runtime compatibility path, not a claim of native desktop-window control.

## Verification

Focused tests prove:

- two Canvas documents retain different wallpapers across save/load;
- changing Canvas ambience does not change Workbench wallpaper;
- malformed/legacy Canvas wallpaper data fails closed or normalizes safely;
- brightness defaults, clamps, persists, resets, and applies only to the VibeSpace root;
- native and browser fullscreen enter, exit, external-exit synchronization, unsupported, and failure paths;
- Workbench and Settings reflect the same fullscreen state.

TypeScript, scoped formatting, and diff hygiene close the slice.
