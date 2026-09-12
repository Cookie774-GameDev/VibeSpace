# VibeSpace Fullscreen System Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent, composable Workspace Focus Mode and native Tauri
System Fullscreen with safe layered exit, explicit persistence, crash/update
restore suppression, and route-aware shell expansion.

**Architecture:** A pure fullscreen domain and persisted preference store drive
a React `FullscreenHost`. The host serializes a small dynamically imported
Tauri window adapter, owns native truth and activation order, and leaves
`AppShell` children mounted while shell chrome changes. Existing public action
IDs remain compatible and target Workspace Focus Mode.

**Tech Stack:** React 18.3.1, TypeScript, Zustand persist middleware, Vitest,
Testing Library, Tauri 2 JavaScript window API, Tailwind/Radix-style existing
UI primitives.

## Global Constraints

- Source authority:
  `docs/superpowers/specs/2026-08-02-fullscreen-system-upgrade-design.md`.
- Do not modify Rust, dependencies, Tauri configuration, capabilities, schemas,
  migrations, updater behavior, billing, cloud systems, or production state.
- Do not add custom taskbar, Dock, menu-bar, panel, display, or window-manager
  hooks.
- Do not simulate system fullscreen or create fake operating-system UI.
- Keep the active page subtree mounted across all fullscreen transitions.
- Add only the fullscreen exit and settings controls required by the source
  prompt.
- Preserve public action IDs, themes, reduced-motion behavior, and non-fullscreen
  behavior.
- Every behavior change follows RED, observed failure, minimal GREEN, focused
  refactor, and a fresh passing test.
- Do not claim macOS, Linux, multi-monitor, Dock, or desktop-panel verification
  without real hardware evidence.

---

## File map

### New fullscreen feature boundary

- `app/src/features/fullscreen/contracts.ts` — pure types, defaults,
  normalization, activation-stack transitions, and restoration eligibility.
- `app/src/features/fullscreen/contracts.test.ts` — pure domain and invalid
  persisted-input tests.
- `app/src/features/fullscreen/nativeFullscreen.ts` — dynamic Tauri window
  adapter and normalized native errors.
- `app/src/features/fullscreen/nativeFullscreen.test.ts` — adapter entry, exit,
  verification, unavailable-runtime, listener, and failure tests.
- `app/src/features/fullscreen/fullscreenStore.ts` — persisted fullscreen
  preferences, remembered states, clean-session/version guard, runtime native
  truth, pending/error state, and controller actions.
- `app/src/features/fullscreen/fullscreenStore.test.ts` — persistence,
  restoration, serialization, stale-result, and layered-exit tests.
- `app/src/features/fullscreen/FullscreenHost.tsx` — boot restoration, native
  synchronization, `F11`, layered `Esc`, clean-close recording, and status
  announcements.
- `app/src/features/fullscreen/FullscreenHost.test.tsx` — host lifecycle,
  shortcuts, restoration ordering, and listener cleanup.
- `app/src/features/fullscreen/FocusModeExit.tsx` — required pointer/keyboard
  exit control.
- `app/src/features/fullscreen/FocusModeExit.test.tsx` — visibility, label,
  focusability, and direct-exit tests.
- `app/src/features/fullscreen/index.ts` — public feature exports.

### Existing integration paths

- `app/src/stores/ui.ts` and `app/src/stores/ui.test.ts` — remove the old
  fullscreen state/actions/document side effect while preserving unrelated UI
  persistence.
- `app/src/components/layout/AppShell.tsx` and new
  `app/src/components/layout/AppShell.fullscreen.test.tsx` — route-aware shell
  chrome without child remounts.
- `app/src/components/layout/TopBar.tsx`,
  `TopBar.sakura.test.tsx`, and `TopBar.voiceSmoke.test.tsx` — existing button
  targets Focus Mode without unrelated top-bar changes.
- `app/src/App.tsx` and new `app/src/App.fullscreen.test.tsx` — mount the host
  once and remove the old fullscreen hotkey binding.
- `app/src/features/settings/sections/Appearance.tsx` and
  `Appearance.test.tsx` — required fullscreen preferences and native toggle.
- `app/src/features/settings/sections/Accessibility.tsx` — update existing
  fullscreen help copy only.
- `app/src/lib/hotkeys.ts` and `app/src/features/settings/sections/Hotkeys.tsx`
  — retain `Mod+Shift+F`, add documented `F11`.
- `app/src/features/command-palette/actions.ts`,
  `app/src/features/assistant/execute.ts`,
  `app/src/features/launcher/launch.ts`, and
  `app/src/lib/actions/registry.ts` — preserve existing public commands while
  targeting Focus Mode.
- `app/src/styles/globals.css` — remove obsolete cosmetic fullscreen rule and
  add only the fixed exit-control/reduced-motion boundary if utility classes
  cannot express it.
- `app/src/test/setup.ts` — complete the shared Tauri window mock with
  `setFullscreen`, `isFullscreen`, resize, and focus listener seams.
- `docs/orchestration/ACTIVE_STATE.md` in the root authority checkout and the
  PR #31 worktree lock receipt — controller-only progress, evidence, and lock
  release records; never part of the product commit.

---

### Task 1: Pure fullscreen contracts

**Files:**

- Create: `app/src/features/fullscreen/contracts.ts`
- Create: `app/src/features/fullscreen/contracts.test.ts`

**Interfaces:**

- Produces:

```ts
export type FullscreenLayer = 'focus' | 'system';
export type SystemFullscreenBehavior = 'always-hidden' | 'reveal-on-edge-hover';
export type FullscreenAvailability = 'available' | 'web-preview' | 'unavailable';
export interface FullscreenPreferences {
  rememberFocusMode: boolean;
  rememberSystemFullscreen: boolean;
  restoreFullscreenOnRestart: boolean;
  systemFullscreenBehavior: SystemFullscreenBehavior;
}
export interface FullscreenRestoreRecord {
  focusActive: boolean;
  systemActive: boolean;
  cleanShutdown: boolean;
  appVersion: string | null;
  recoveryLaunch: boolean;
}
export const DEFAULT_FULLSCREEN_PREFERENCES: Readonly<FullscreenPreferences>;
export function normalizeFullscreenPreferences(value: unknown): FullscreenPreferences;
export function activateLayer(
  order: readonly FullscreenLayer[],
  layer: FullscreenLayer,
): FullscreenLayer[];
export function deactivateLayer(
  order: readonly FullscreenLayer[],
  layer: FullscreenLayer,
): FullscreenLayer[];
export function lastActiveLayer(order: readonly FullscreenLayer[]): FullscreenLayer | null;
export function resolveRestorableLayers(input: {
  preferences: FullscreenPreferences;
  record: FullscreenRestoreRecord;
  currentVersion: string;
}): FullscreenLayer[];
```

- [ ] **Step 1: Write failing contract tests**

```ts
it('keeps fullscreen layers unique and most-recent-first for Escape', () => {
  expect(activateLayer(['focus'], 'system')).toEqual(['focus', 'system']);
  expect(activateLayer(['focus', 'system'], 'focus')).toEqual(['system', 'focus']);
  expect(lastActiveLayer(['system', 'focus'])).toBe('focus');
  expect(deactivateLayer(['system', 'focus'], 'focus')).toEqual(['system']);
});

it.each([
  { cleanShutdown: false, appVersion: '1.5.0', recoveryLaunch: false },
  { cleanShutdown: true, appVersion: '1.4.9', recoveryLaunch: false },
  { cleanShutdown: true, appVersion: '1.5.0', recoveryLaunch: true },
])('suppresses unsafe restoration for %o', (unsafe) => {
  expect(
    resolveRestorableLayers({
      preferences: {
        rememberFocusMode: true,
        rememberSystemFullscreen: true,
        restoreFullscreenOnRestart: true,
        systemFullscreenBehavior: 'always-hidden',
      },
      record: { focusActive: true, systemActive: true, ...unsafe },
      currentVersion: '1.5.0',
    }),
  ).toEqual([]);
});
```

- [ ] **Step 2: Run RED**

Run:

```powershell
npm --prefix app run test -- --run src/features/fullscreen/contracts.test.ts
```

Expected: FAIL because `contracts.ts` and its exports do not exist.

- [ ] **Step 3: Implement minimal pure contracts**

Implement strict object/boolean/enum normalization, immutable default
preferences, unique activation ordering, and a restoration function that
returns no layer unless every master, per-layer, clean-shutdown, same-version,
and non-recovery condition is satisfied.

- [ ] **Step 4: Run GREEN**

Run the Task 1 command again. Expected: PASS.

- [ ] **Step 5: Format and commit**

```powershell
npx prettier --write app/src/features/fullscreen/contracts.ts app/src/features/fullscreen/contracts.test.ts
git diff --check
git add -- app/src/features/fullscreen/contracts.ts app/src/features/fullscreen/contracts.test.ts
git commit -m "feat(fullscreen): define layered fullscreen contracts"
```

---

### Task 2: Verified native Tauri adapter

**Files:**

- Create: `app/src/features/fullscreen/nativeFullscreen.ts`
- Create: `app/src/features/fullscreen/nativeFullscreen.test.ts`
- Modify: `app/src/test/setup.ts`

**Interfaces:**

- Consumes: `FullscreenAvailability` from Task 1.
- Produces:

```ts
export interface NativeFullscreenWindow {
  setFullscreen(enabled: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
  onResized(listener: () => void): Promise<() => void>;
  onFocusChanged(listener: () => void): Promise<() => void>;
}
export interface NativeFullscreenAdapter {
  availability(): FullscreenAvailability;
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<boolean>;
  subscribe(listener: (enabled: boolean) => void): Promise<() => void>;
}
export function createNativeFullscreenAdapter(options?: {
  isTauriRuntime?: () => boolean;
  loadWindow?: () => Promise<NativeFullscreenWindow>;
}): NativeFullscreenAdapter;
```

- [ ] **Step 1: Write failing adapter tests**

```ts
it('sets native fullscreen and returns verified native truth', async () => {
  const windowApi = {
    setFullscreen: vi.fn(async () => undefined),
    isFullscreen: vi.fn(async () => true),
    onResized: vi.fn(async () => vi.fn()),
    onFocusChanged: vi.fn(async () => vi.fn()),
  };
  const adapter = createNativeFullscreenAdapter({
    isTauriRuntime: () => true,
    loadWindow: async () => windowApi,
  });

  await expect(adapter.write(true)).resolves.toBe(true);
  expect(windowApi.setFullscreen).toHaveBeenCalledWith(true);
  expect(windowApi.isFullscreen).toHaveBeenCalledOnce();
});

it('rejects an unavailable web-preview write without faking fullscreen', async () => {
  const adapter = createNativeFullscreenAdapter({ isTauriRuntime: () => false });
  expect(adapter.availability()).toBe('web-preview');
  await expect(adapter.write(true)).rejects.toThrow(
    'System fullscreen requires the installed VibeSpace desktop app.',
  );
});
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/nativeFullscreen.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the adapter**

Use a guarded dynamic import:

```ts
const loadWindow = async (): Promise<NativeFullscreenWindow> => {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
};
```

`write()` must call `setFullscreen`, then `isFullscreen`. If observed truth
does not equal the requested target, throw
`Native fullscreen did not reach the requested state.` `subscribe()` must
coalesce resize/focus callbacks through one pending microtask, query truth,
ignore query failures, and return a cleanup that calls both unlisteners.

- [ ] **Step 4: Complete the shared test mock**

Add async `setFullscreen`, `isFullscreen`, `onResized`, and `onFocusChanged`
mock methods while preserving the existing `label` and `listen` mock.

- [ ] **Step 5: Run GREEN and commit**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/nativeFullscreen.test.ts
npx prettier --write app/src/features/fullscreen/nativeFullscreen.ts app/src/features/fullscreen/nativeFullscreen.test.ts app/src/test/setup.ts
git diff --check
git add -- app/src/features/fullscreen/nativeFullscreen.ts app/src/features/fullscreen/nativeFullscreen.test.ts app/src/test/setup.ts
git commit -m "feat(fullscreen): add verified native window adapter"
```

---

### Task 3: Persisted fullscreen store and serialized controller

**Files:**

- Create: `app/src/features/fullscreen/fullscreenStore.ts`
- Create: `app/src/features/fullscreen/fullscreenStore.test.ts`
- Create: `app/src/features/fullscreen/index.ts`

**Interfaces:**

- Consumes: Task 1 contracts and Task 2 adapter.
- Produces:

```ts
export interface FullscreenState {
  focusActive: boolean;
  systemActive: boolean;
  activationOrder: FullscreenLayer[];
  preferences: FullscreenPreferences;
  rememberedFocusActive: boolean;
  rememberedSystemActive: boolean;
  cleanShutdown: boolean;
  storedAppVersion: string | null;
  recoveryLaunch: boolean;
  nativeAvailability: FullscreenAvailability;
  nativePending: boolean;
  error: string | null;
  setFocusActive(enabled: boolean): void;
  toggleFocus(): void;
  requestSystemActive(enabled: boolean): Promise<boolean>;
  toggleSystem(): Promise<boolean>;
  exitMostRecentLayer(): Promise<FullscreenLayer | null>;
  syncNativeState(enabled: boolean): void;
  setPreferences(patch: Partial<FullscreenPreferences>): void;
  beginSession(input: { appVersion: string; recoveryLaunch: boolean }): FullscreenLayer[];
  markCleanShutdown(appVersion: string): void;
  clearError(): void;
}
export const useFullscreenStore: UseBoundStore<StoreApi<FullscreenState>>;
export function configureFullscreenAdapter(adapter: NativeFullscreenAdapter): () => void;
```

- [ ] **Step 1: Write failing persistence/controller tests**

```ts
it('serializes contradictory native targets and ignores stale completion', async () => {
  const first = deferred<boolean>();
  const second = deferred<boolean>();
  const adapter = fakeAdapter([first.promise, second.promise]);
  configureFullscreenAdapter(adapter);

  const enter = useFullscreenStore.getState().requestSystemActive(true);
  const exit = useFullscreenStore.getState().requestSystemActive(false);
  first.resolve(true);
  second.resolve(false);

  await expect(enter).resolves.toBe(true);
  await expect(exit).resolves.toBe(false);
  expect(useFullscreenStore.getState().systemActive).toBe(false);
  expect(useFullscreenStore.getState().nativePending).toBe(false);
});

it('exits only the most recently activated layer', async () => {
  useFullscreenStore.getState().setFocusActive(true);
  await useFullscreenStore.getState().requestSystemActive(true);
  useFullscreenStore.getState().setFocusActive(true);

  await expect(useFullscreenStore.getState().exitMostRecentLayer()).resolves.toBe('focus');
  expect(useFullscreenStore.getState().focusActive).toBe(false);
  expect(useFullscreenStore.getState().systemActive).toBe(true);
});
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/fullscreenStore.test.ts
```

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement persisted preference and restore state**

Use a dedicated Zustand persist key
`vibespace-fullscreen-preferences-v1`. Persist only sanitized preferences,
remembered layer flags, clean-shutdown flag, stored version, and recovery
flag. Keep active state, activation order, native pending, availability, and
errors transient.

Disabling a remember preference must immediately clear its remembered flag.
Active changes update remembered flags only when their corresponding remember
preference is enabled.

- [ ] **Step 4: Implement serialized native requests**

Maintain a private monotonically increasing request ID and one promise chain.
Every request calls the configured adapter in sequence. Only the newest request
may publish native truth/error. A failed request preserves last observed state,
sets a bounded error, and resolves to the preserved state.

- [ ] **Step 5: Run GREEN, format, and commit**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/contracts.test.ts src/features/fullscreen/nativeFullscreen.test.ts src/features/fullscreen/fullscreenStore.test.ts
npx prettier --write app/src/features/fullscreen/fullscreenStore.ts app/src/features/fullscreen/fullscreenStore.test.ts app/src/features/fullscreen/index.ts
git diff --check
git add -- app/src/features/fullscreen/fullscreenStore.ts app/src/features/fullscreen/fullscreenStore.test.ts app/src/features/fullscreen/index.ts
git commit -m "feat(fullscreen): persist and coordinate fullscreen layers"
```

---

### Task 4: Fullscreen host, shortcuts, restoration, and required exit control

**Files:**

- Create: `app/src/features/fullscreen/FullscreenHost.tsx`
- Create: `app/src/features/fullscreen/FullscreenHost.test.tsx`
- Create: `app/src/features/fullscreen/FocusModeExit.tsx`
- Create: `app/src/features/fullscreen/FocusModeExit.test.tsx`
- Modify: `app/src/App.tsx`
- Create: `app/src/App.fullscreen.test.tsx`
- Modify: `app/src/lib/hotkeys.ts`
- Modify: `app/src/features/settings/sections/Hotkeys.tsx`

**Interfaces:**

- Consumes: `useFullscreenStore`, `createNativeFullscreenAdapter`, `useHotkey`,
  and `HOTKEYS`.
- Produces:

```ts
export function FullscreenHost(): React.ReactElement | null;
export function FocusModeExit(): React.ReactElement | null;
```

- [ ] **Step 1: Write failing host and exit-control tests**

```tsx
it('Escape exits only the most recently activated fullscreen layer', async () => {
  render(<FullscreenHost />);
  useFullscreenStore.getState().setFocusActive(true);
  await useFullscreenStore.getState().requestSystemActive(true);
  useFullscreenStore.getState().setFocusActive(true);

  fireEvent.keyDown(window, { key: 'Escape' });

  await waitFor(() => expect(useFullscreenStore.getState().focusActive).toBe(false));
  expect(useFullscreenStore.getState().systemActive).toBe(true);
});

it('offers a pointer and keyboard exit while Focus Mode hides the top bar', () => {
  useFullscreenStore.getState().setFocusActive(true);
  render(<FocusModeExit />);
  const exit = screen.getByRole('button', { name: 'Exit Focus Mode' });
  expect(exit.tabIndex).toBe(0);
  fireEvent.click(exit);
  expect(useFullscreenStore.getState().focusActive).toBe(false);
});
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/FullscreenHost.test.tsx src/features/fullscreen/FocusModeExit.test.tsx src/App.fullscreen.test.tsx
```

Expected: FAIL because the host and exit component do not exist.

- [ ] **Step 3: Implement host lifecycle**

On mount:

1. configure the native adapter;
2. subscribe to native truth;
3. obtain current app version through guarded dynamic
   `@tauri-apps/api/app.getVersion()` with package-version fallback for web
   tests;
4. detect recovery from an explicit `?recovery=1` or `?safe-mode=1` launch;
5. call `beginSession`;
6. restore Focus Mode first, then request System Fullscreen;
7. register `pagehide` and `beforeunload` clean-shutdown handlers;
8. clean up listeners and adapter configuration on unmount.

Use `HOTKEYS.TOGGLE_FULLSCREEN`, new
`HOTKEYS.TOGGLE_SYSTEM_FULLSCREEN = 'F11'`, and `HOTKEYS.ESCAPE`. The Escape
binding must be disabled when no layer is active and must not prevent default
unless a layer was handled.

- [ ] **Step 4: Mount the host once**

Mount `<FullscreenHost />` alongside the existing global hosts and remove only
the old `toggleChatFullscreen` hotkey block from `GlobalHotkeysHost`.

- [ ] **Step 5: Run GREEN, format, and commit**

```powershell
npm --prefix app run test -- --run src/features/fullscreen/FullscreenHost.test.tsx src/features/fullscreen/FocusModeExit.test.tsx src/App.fullscreen.test.tsx
npx prettier --write app/src/features/fullscreen/FullscreenHost.tsx app/src/features/fullscreen/FullscreenHost.test.tsx app/src/features/fullscreen/FocusModeExit.tsx app/src/features/fullscreen/FocusModeExit.test.tsx app/src/App.tsx app/src/App.fullscreen.test.tsx app/src/lib/hotkeys.ts app/src/features/settings/sections/Hotkeys.tsx
git diff --check
git add -- app/src/features/fullscreen/FullscreenHost.tsx app/src/features/fullscreen/FullscreenHost.test.tsx app/src/features/fullscreen/FocusModeExit.tsx app/src/features/fullscreen/FocusModeExit.test.tsx app/src/App.tsx app/src/App.fullscreen.test.tsx app/src/lib/hotkeys.ts app/src/features/settings/sections/Hotkeys.tsx
git commit -m "feat(fullscreen): add safe host shortcuts and exit control"
```

---

### Task 5: Route-aware Focus Mode shell without remounts

**Files:**

- Modify: `app/src/components/layout/AppShell.tsx`
- Create: `app/src/components/layout/AppShell.fullscreen.test.tsx`
- Modify: `app/src/styles/globals.css`

**Interfaces:**

- Consumes: `useFullscreenStore((state) => state.focusActive)` and
  `<FocusModeExit />`.
- Produces: `data-focus-mode="true"` and
  `data-focus-mode-route="<route>"` shell evidence attributes.

- [ ] **Step 1: Write failing route-policy and identity tests**

```tsx
it.each([
  ['chat', false],
  ['terminal', false],
  ['canvas', true],
])('applies Focus Mode chrome policy for %s', (route, expectNav) => {
  useUIStore.setState({ route });
  useFullscreenStore.getState().setFocusActive(true);
  render(
    <AppShell>
      <StatefulWorkspace />
    </AppShell>,
  );

  expect(screen.queryByLabelText('Application header')).toBeNull();
  expect(Boolean(screen.queryByLabelText('Navigation'))).toBe(expectNav);
  expect(screen.queryByLabelText('Open chats')).toBeNull();
  expect(screen.getByTestId('stateful-workspace')).toBeTruthy();
});

it('does not remount workspace children across Focus Mode entry and exit', () => {
  const mounted = vi.fn();
  const { rerender } = render(
    <AppShell>
      <MountProbe onMount={mounted} />
    </AppShell>,
  );
  useFullscreenStore.getState().setFocusActive(true);
  rerender(
    <AppShell>
      <MountProbe onMount={mounted} />
    </AppShell>,
  );
  useFullscreenStore.getState().setFocusActive(false);
  rerender(
    <AppShell>
      <MountProbe onMount={mounted} />
    </AppShell>,
  );
  expect(mounted).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run RED**

```powershell
npm --prefix app run test -- --run src/components/layout/AppShell.fullscreen.test.tsx
```

Expected: FAIL because AppShell still renders normal chrome.

- [ ] **Step 3: Implement route-aware shell composition**

Keep one stable workspace `<main>` and children expression. Compute:

```ts
const focusActive = useFullscreenStore((state) => state.focusActive);
const focusedChat = focusActive && route === 'chat';
const focusedTerminal = focusActive && route === 'terminal';
const showTopBar = !focusActive;
const showNav = !focusActive || (!focusedChat && !focusedTerminal);
const showApplicationTabs = !focusActive;
const showPeripheralChrome = !focusActive;
```

Render `<FocusModeExit />` inside the stable shell boundary. Preserve the
existing Workbench early return exactly.

- [ ] **Step 4: Add only bounded transition CSS**

Delete the obsolete `[data-fullscreen='true']` cosmetic rule. Add no layout
height placeholder. If utilities are insufficient, add one fixed
`[data-focus-mode-exit]` transition and a reduced-motion override.

- [ ] **Step 5: Run GREEN and existing shell/theme tests**

```powershell
npm --prefix app run test -- --run src/components/layout/AppShell.fullscreen.test.tsx src/components/layout/AppShell.sakura.test.tsx
npx prettier --write app/src/components/layout/AppShell.tsx app/src/components/layout/AppShell.fullscreen.test.tsx app/src/styles/globals.css
git diff --check
git add -- app/src/components/layout/AppShell.tsx app/src/components/layout/AppShell.fullscreen.test.tsx app/src/styles/globals.css
git commit -m "feat(fullscreen): expand route-aware focused workspaces"
```

---

### Task 6: Settings and compatibility consumer migration

**Files:**

- Modify: `app/src/features/settings/sections/Appearance.tsx`
- Modify: `app/src/features/settings/sections/Appearance.test.tsx`
- Modify: `app/src/features/settings/sections/Accessibility.tsx`
- Modify: `app/src/components/layout/TopBar.tsx`
- Modify: `app/src/components/layout/TopBar.sakura.test.tsx`
- Modify: `app/src/components/layout/TopBar.voiceSmoke.test.tsx`
- Modify: `app/src/features/command-palette/actions.ts`
- Modify: `app/src/features/assistant/execute.ts`
- Modify: `app/src/features/launcher/launch.ts`
- Modify: `app/src/lib/actions/registry.ts`
- Modify: `app/src/stores/ui.ts`
- Modify: `app/src/stores/ui.test.ts`

**Interfaces:**

- Consumes: fullscreen feature exports.
- Preserves: existing `toggle-fullscreen` command-palette ID,
  `chat.fullscreen` action ID, assistant `set_fullscreen` intent, and launcher
  `fullscreen` command.

- [ ] **Step 1: Write failing settings tests**

```tsx
it('exposes independent native fullscreen and restoration preferences', () => {
  render(<Appearance />);
  expect(screen.getByRole('switch', { name: 'True System Fullscreen' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'Always Hidden' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'Reveal on Edge Hover' })).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'Remember Workspace Focus Mode' })).toBeTruthy();
  expect(screen.getByRole('switch', { name: 'Remember True System Fullscreen' })).toBeTruthy();
  expect(
    screen.getByRole('switch', { name: 'Restore fullscreen state when VibeSpace restarts' }),
  ).toBeTruthy();
});
```

Add compatibility assertions that every existing public fullscreen consumer
calls `useFullscreenStore.getState().toggleFocus()` and does not write the old
UI-store field.

- [ ] **Step 2: Run RED**

```powershell
npm --prefix app run test -- --run src/features/settings/sections/Appearance.test.tsx src/stores/ui.test.ts src/components/layout/TopBar.sakura.test.tsx src/components/layout/TopBar.voiceSmoke.test.tsx
```

Expected: FAIL because the settings and migrated behavior do not exist.

- [ ] **Step 3: Add the bounded Appearance section**

Use existing `Switch`, `Label`, `Separator`, and button/radio styles. Bind the
system toggle to `requestSystemActive`, behavior radios and remember/restore
switches to `setPreferences`, and display the store's availability, pending,
or bounded error status. Disable only the native active toggle in web preview;
preference controls remain available.

- [ ] **Step 4: Migrate existing fullscreen consumers**

Replace `chatFullscreen`, `toggleChatFullscreen`, and `setChatFullscreen`
reads/writes with `focusActive`, `toggleFocus`, and `setFocusActive`.
TopBar keeps the same position, icons, and labels. Public action IDs and
assistant intent shapes remain unchanged.

Remove the old fullscreen fields/actions/default and
`document.documentElement` side effect from `ui.ts`. Add a migration assertion
that obsolete persisted fullscreen keys are ignored and cannot activate the
new feature.

- [ ] **Step 5: Run GREEN, format, and commit**

```powershell
npm --prefix app run test -- --run src/features/settings/sections/Appearance.test.tsx src/stores/ui.test.ts src/components/layout/TopBar.sakura.test.tsx src/components/layout/TopBar.voiceSmoke.test.tsx
npx prettier --write app/src/features/settings/sections/Appearance.tsx app/src/features/settings/sections/Appearance.test.tsx app/src/features/settings/sections/Accessibility.tsx app/src/components/layout/TopBar.tsx app/src/components/layout/TopBar.sakura.test.tsx app/src/components/layout/TopBar.voiceSmoke.test.tsx app/src/features/command-palette/actions.ts app/src/features/assistant/execute.ts app/src/features/launcher/launch.ts app/src/lib/actions/registry.ts app/src/stores/ui.ts app/src/stores/ui.test.ts
git diff --check
git add -- app/src/features/settings/sections/Appearance.tsx app/src/features/settings/sections/Appearance.test.tsx app/src/features/settings/sections/Accessibility.tsx app/src/components/layout/TopBar.tsx app/src/components/layout/TopBar.sakura.test.tsx app/src/components/layout/TopBar.voiceSmoke.test.tsx app/src/features/command-palette/actions.ts app/src/features/assistant/execute.ts app/src/features/launcher/launch.ts app/src/lib/actions/registry.ts app/src/stores/ui.ts app/src/stores/ui.test.ts
git commit -m "feat(fullscreen): connect settings and existing controls"
```

---

### Task 7: Cross-feature regression and final verification

**Files:**

- Modify only a Task 1–6 owned test/source path when a concrete regression
  requires correction.
- Update controller-only coordination records after exact evidence is known.

**Interfaces:**

- Consumes the completed fullscreen feature.
- Produces a verified PR #31 commit set and recorded handoff.

- [ ] **Step 1: Run the complete focused fullscreen boundary**

```powershell
npm --prefix app run test -- --run src/features/fullscreen src/components/layout/AppShell.fullscreen.test.tsx src/App.fullscreen.test.tsx src/features/settings/sections/Appearance.test.tsx src/stores/ui.test.ts
```

Expected: PASS with no unhandled rejection or leaked listener.

- [ ] **Step 2: Run affected compatibility tests**

```powershell
npm --prefix app run test -- --run src/components/layout/TopBar.sakura.test.tsx src/components/layout/TopBar.voiceSmoke.test.tsx src/features/assistant src/features/command-palette src/features/launcher src/lib/actions
```

Expected: PASS. Correct only a concrete regression inside the locked paths and
repeat its focused RED/GREEN cycle.

- [ ] **Step 3: Run broad frontend gates**

```powershell
npm run typecheck
npm --prefix app run test
npm run build
```

Record exact PASS/FAIL and duration. Do not weaken tests or types.

- [ ] **Step 4: Run native compile and repository hygiene**

```powershell
cargo check --manifest-path app/src-tauri/Cargo.toml
npx prettier --check app/src/features/fullscreen app/src/components/layout/AppShell.tsx app/src/components/layout/AppShell.fullscreen.test.tsx app/src/components/layout/TopBar.tsx app/src/features/settings/sections/Appearance.tsx app/src/features/settings/sections/Appearance.test.tsx app/src/stores/ui.ts app/src/stores/ui.test.ts app/src/App.tsx app/src/lib/hotkeys.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Perform installed Windows manual checks**

In the Tauri desktop app:

1. enter/exit Chat Focus Mode and confirm no header gap, draft loss, remount, or
   scroll reset;
2. enter/exit Terminal Focus Mode and confirm panes, tabs, PTYs, active pane,
   input, and refit remain intact;
3. test another page and confirm the sidebar remains;
4. enter/exit System Fullscreen with settings, `F11`, and `Esc`;
5. activate both layers in each order and confirm last-activated exits first;
6. repeat toggles rapidly and confirm no loop, flicker, or trapped state;
7. exercise remember/restore after clean restart and suppression after a
   simulated unclean/version-change/recovery launch;
8. record the available display/scale and whether Windows edge reveal is
   native-managed.

Do not claim macOS, Linux, or physical multi-monitor results unless they were
actually exercised.

- [ ] **Step 6: Review exact diff and security boundary**

```powershell
git diff 227fdf738095c13896842811db6d8c98b60182a0 --stat
git diff 227fdf738095c13896842811db6d8c98b60182a0 --
git status --short
```

Confirm no Rust, dependency, lockfile, capability, schema, billing, updater,
release, external-system, unrelated UI, secret, debug, or generated change.

- [ ] **Step 7: Record, push, and verify PR #31**

Append the exact commits, changed paths, tests, risks, skipped platforms,
rollback, and lock release to the controller authority. Push only
`agent/pr30-fixes-and-updates`, verify the remote SHA, and fetch PR #31 metadata
to confirm the intended changed-file set. Do not merge, undraft, release, or
deploy.
