# Canvas Ambience, App Brightness, and Fullscreen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate per-document Canvas ambience from Workbench wallpaper, add persisted 0–200% VibeSpace brightness, and make fullscreen work consistently from Workbench and Settings.

**Architecture:** Canvas wallpaper configuration becomes validated Canvas-document state and the shared picker becomes controlled. Brightness remains a lightweight persisted UI preference applied by one root host. Fullscreen uses one adapter contract with Tauri authority and a standards-based browser fallback, mounted independently from global hotkeys.

**Tech Stack:** React, TypeScript, Zustand, Dexie, Tauri v2, browser Fullscreen API, Vitest, Testing Library.

## Global Constraints

- Preserve unrelated UI, state, backend, native, billing, and wallpaper-entitlement behavior.
- Do not add dependencies, background polling, external mutations, or Git publication.
- Preserve all pre-existing dirty work and edit only the owned paths.
- Use RED-first focused tests and run broad checks only where the touched boundary requires them.

---

### Task 1: Per-document Canvas ambience contract

**Files:**

- Create: `app/src/features/workbench/wallpaperConfig.ts`
- Modify: `app/src/features/workbench/types.ts`
- Modify: `app/src/features/canvas/contracts.ts`
- Test: `app/src/features/canvas/contracts.test.ts`
- Modify: `app/src/features/canvas/persistence.ts`
- Test: `app/src/features/canvas/persistence.test.ts`

**Interfaces:**

- Produces: `normalizeWallpaperConfig(value): WorkbenchWallpaperConfig`
- Produces: `CanvasBackground.wallpaper`
- Consumes: existing Canvas document parse/create/save/load paths.

- [ ] **Step 1: Write failing contract and persistence tests**

```ts
expect(
  createCanvasDocument({ ...input, background: { ...base, wallpaper: warm } }).background.wallpaper,
).toEqual(warm);
expect((await repository.load(scope, document.id))?.background.wallpaper).toEqual(warm);
expect(parseCanvasDocument(legacyDocument).background.wallpaper).toEqual(DEFAULT_WALLPAPER_CONFIG);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm test -- --run src/features/canvas/contracts.test.ts src/features/canvas/persistence.test.ts`

Expected: failures because Canvas background does not accept or round-trip wallpaper state.

- [ ] **Step 3: Extract bounded wallpaper normalization and extend Canvas background**

Define the shared default and fail-safe clamping in `wallpaperConfig.ts`. Parse optional Canvas wallpaper input, normalize legacy documents, deep-freeze the value, and map it through the existing document row.

- [ ] **Step 4: Run the focused tests and confirm GREEN**

Run: `npm test -- --run src/features/canvas/contracts.test.ts src/features/canvas/persistence.test.ts`

Expected: all tests pass.

### Task 2: Controlled picker and Canvas/Workbench isolation

**Files:**

- Modify: `app/src/features/workbench/WallpaperPicker.tsx`
- Test: `app/src/features/workbench/WallpaperPicker.test.tsx`
- Modify: `app/src/features/canvas/CanvasPage.tsx`
- Test: `app/src/features/canvas/CanvasPage.test.tsx`

**Interfaces:**

- Consumes: `WallpaperPickerController` containing `config`, `setWallpaper`, and `configureWallpaper`.
- Produces: Canvas document updates through the existing document transition/autosave path.

- [ ] **Step 1: Write failing isolation tests**

```ts
const workbenchBefore = useWorkbenchStore.getState().wallpaper;
selectCanvasWallpaper('warm-gradient');
expect(activeCanvas().background.wallpaper.id).toBe('warm-gradient');
expect(useWorkbenchStore.getState().wallpaper).toEqual(workbenchBefore);
switchCanvas('canvas-b');
expect(renderedWallpaper()).toBe('none');
```

- [ ] **Step 2: Run the focused component tests and confirm RED**

Run: `npm test -- --run src/features/workbench/WallpaperPicker.test.tsx src/features/canvas/CanvasPage.test.tsx`

Expected: Canvas still mutates the Workbench store.

- [ ] **Step 3: Make the picker controlled and route Canvas edits to its document**

Keep Workbench’s existing store-backed wrapper. Pass a Canvas controller from `CanvasPage`, update the active document’s wallpaper with its existing revision/autosave transition, and render `WallpaperHost` from that document configuration.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --run src/features/workbench/WallpaperPicker.test.tsx src/features/canvas/CanvasPage.test.tsx`

Expected: Canvas documents remain independent and Workbench state is unchanged.

### Task 3: Persisted application brightness

**Files:**

- Modify: `app/src/stores/ui.ts`
- Test: `app/src/stores/ui.test.ts`
- Modify: `app/src/features/settings/sections/Appearance.tsx`
- Test: `app/src/features/settings/sections/Appearance.test.tsx`
- Modify: `app/src/App.tsx`
- Modify: `app/src/styles/globals.css`

**Interfaces:**

- Produces: `appBrightness: number`, `setAppBrightness(value: number)`, and `--vibespace-app-brightness`.

- [ ] **Step 1: Write failing normalization and UI tests**

```ts
useUIStore.getState().setAppBrightness(250);
expect(useUIStore.getState().appBrightness).toBe(200);
fireEvent.change(screen.getByRole('slider', { name: /app brightness/i }), {
  target: { value: '0' },
});
expect(document.documentElement.style.getPropertyValue('--vibespace-app-brightness')).toBe('0');
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `npm test -- --run src/stores/ui.test.ts src/features/settings/sections/Appearance.test.tsx`

Expected: brightness state and control are absent.

- [ ] **Step 3: Implement the preference, control, and root host**

Clamp hydration and setter values to integer 0–200, persist through the existing UI storage, render the range/value/reset controls, and apply `brightness(value / 100)` to `#root` through one CSS custom property.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm test -- --run src/stores/ui.test.ts src/features/settings/sections/Appearance.test.tsx`

Expected: default, clamp, persistence, reset, and root application pass.

### Task 4: Unified native and browser fullscreen

**Files:**

- Modify: `app/src/features/fullscreen/contracts.ts`
- Modify: `app/src/features/fullscreen/nativeFullscreen.ts`
- Test: `app/src/features/fullscreen/nativeFullscreen.test.ts`
- Modify: `app/src/features/fullscreen/fullscreenStore.ts`
- Test: `app/src/features/fullscreen/fullscreenStore.test.ts`
- Modify: `app/src/features/fullscreen/FullscreenHost.tsx`
- Test: `app/src/features/fullscreen/FullscreenHost.test.tsx`
- Modify: `app/src/App.tsx`
- Test: `app/src/App.runtimeProfile.test.tsx`
- Modify: `app/src/features/workbench/WorkbenchPage.tsx`
- Test: `app/src/features/workbench/WorkbenchPage.test.tsx`
- Modify: `app/src/features/settings/sections/Appearance.tsx`
- Test: `app/src/features/settings/sections/Appearance.test.tsx`

**Interfaces:**

- Produces: one fullscreen adapter whose availability is `available` when either Tauri or browser fullscreen is supported.
- Consumes: existing fullscreen Zustand state and Workbench/Settings controls.

- [ ] **Step 1: Write failing browser fallback and lifecycle tests**

```ts
await adapter.write(true);
expect(document.documentElement.requestFullscreen).toHaveBeenCalledOnce();
fullscreenChange(false);
expect(useFullscreenStore.getState().systemActive).toBe(false);
expect(
  renderWorkspaceRoot({ globalHotkeyEnabled: false }).queryByTestId('fullscreen-host'),
).toBeTruthy();
```

- [ ] **Step 2: Run focused fullscreen tests and confirm RED**

Run: `npm test -- --run src/features/fullscreen/nativeFullscreen.test.ts src/features/fullscreen/fullscreenStore.test.ts src/features/fullscreen/FullscreenHost.test.tsx src/features/workbench/WorkbenchPage.test.tsx src/features/settings/sections/Appearance.test.tsx src/App.runtimeProfile.test.tsx`

Expected: browser preview is unavailable and host mounting remains coupled to global hotkeys.

- [ ] **Step 3: Implement adapter fallback and independent host lifecycle**

Prefer Tauri when installed. Otherwise use `requestFullscreen`, `exitFullscreen`, `fullscreenElement`, and `fullscreenchange`; report unsupported environments accurately. Mount `FullscreenHost` independently, preserve F11/Focus Mode behavior, and keep Settings/Workbench state synchronized.

- [ ] **Step 4: Run focused fullscreen tests and confirm GREEN**

Run the command from Step 2.

Expected: native, browser, failure, external-exit, Workbench, and Settings paths pass.

### Task 5: Boundary verification

**Files:**

- Verify only the paths listed above.

- [ ] **Step 1: Run the combined focused suite**

Run: `npm test -- --run src/features/canvas/contracts.test.ts src/features/canvas/persistence.test.ts src/features/canvas/CanvasPage.test.tsx src/features/workbench/WallpaperPicker.test.tsx src/stores/ui.test.ts src/features/settings/sections/Appearance.test.tsx src/features/fullscreen/nativeFullscreen.test.ts src/features/fullscreen/fullscreenStore.test.ts src/features/fullscreen/FullscreenHost.test.tsx src/features/workbench/WorkbenchPage.test.tsx src/App.runtimeProfile.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 2: Run TypeScript**

Run: `npm run typecheck`

Expected: exit 0, or report only proven pre-existing failures outside the owned paths.

- [ ] **Step 3: Run scoped formatting and diff hygiene**

Run: `npx prettier --check <owned TypeScript/TSX files>`

Run: `git diff --check -- <owned paths>`

Expected: exit 0.

- [ ] **Step 4: Inspect the exact diff**

Confirm no Workbench editor semantics, Canvas content/tool behavior, backend, entitlement, theme, dependency, or external-system path changed.
