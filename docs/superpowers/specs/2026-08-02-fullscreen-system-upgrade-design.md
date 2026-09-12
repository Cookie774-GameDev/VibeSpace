# VibeSpace Fullscreen System Upgrade Design

**Task:** `VS-PR31-FULLSCREEN-20260802T135507Z-ROOT`
**PR:** `Cookie774-GameDev/VibeSpace#31`
**Starting commit:** `227fdf738095c13896842811db6d8c98b60182a0`
**Source prompt:** `FullScreen Prompt.txt`
**Source prompt SHA-256:** `1EABFCB64455B8496E7978AC86D6B0F2F3388067A0284EA7A7438DCD71106371`

## Objective

Replace the existing cosmetic workspace-fullscreen toggle with two independent,
composable, safely exit-able layers:

1. Workspace Focus Mode, which removes nonessential VibeSpace chrome while
   keeping the active workspace mounted.
2. True System Fullscreen, which asks the current Tauri window to enter native
   operating-system fullscreen.

The upgrade changes only fullscreen behavior, its required controls, its
preferences, and focused regression coverage. It does not redesign unrelated
pages or change unrelated application systems.

## Non-negotiable boundaries

- Do not modify Rust, dependencies, Tauri configuration, or capability files.
- Do not add platform-specific taskbar, Dock, menu-bar, desktop-panel, display,
  or window-manager hooks.
- Do not simulate native fullscreen by resizing or repositioning the window.
- Do not create a fake operating-system bar or edge-reveal surface.
- Do not unmount or reload the active page when either fullscreen layer changes.
- Do not change authentication, authorization, billing, persistence schemas,
  terminal processes, chat data, updater behavior, releases, or external
  services.
- Do not restyle unrelated UI. Add only the exit control and settings controls
  required by the source prompt.
- Preserve existing themes, accessibility behavior, reduced motion, and
  platform-neutral application behavior.

## Existing behavior

The current `chatFullscreen` Zustand value toggles a
`data-fullscreen="true|false"` attribute. The current CSS only changes the
workspace background, while `TopBar` switches to a compact 28-pixel form.
Consequently, the top bar remains in layout and no native fullscreen operation
occurs. The existing action, assistant, command-palette, launcher, hotkey, and
button consumers all target this single cosmetic value.

The existing Tauri capability set already grants the current main window the
native window operations needed to query and set fullscreen. No native or
security capability expansion is necessary.

## Architecture

### 1. Fullscreen domain contract

A focused `features/fullscreen` module owns fullscreen-specific types and pure
state transitions:

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
```

Runtime state records whether each layer is active, the activation order, the
native availability, whether a native transition is pending, and a bounded
user-facing error. Activation order contains each active layer at most once;
activating an already-active layer moves it to the top. `Esc` removes only the
last active layer.

Workspace Focus Mode is synchronous application state. System Fullscreen is
asynchronous and changes its active state only after the native window reports
the resulting truth.

### 2. Workspace Focus Mode shell behavior

`AppShell` will branch only the chrome around its existing `children`. The
active page subtree retains the same React identity and remains mounted across
entry and exit.

The shell applies these route policies:

| Active route                 | Top bar                                | Left navigation                | Tab strip                                                                              | Inspector/activity chrome                        | Workspace                                                        |
| ---------------------------- | -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Chat                         | Hidden                                 | Hidden                         | Hidden                                                                                 | Hidden                                           | Conversation fills all available space                           |
| Terminal                     | Hidden                                 | Hidden                         | Preserved only when it belongs to the terminal workspace; application tab strip hidden | Hidden                                           | Terminal page and its own tabs/controls fill all available space |
| Other routes                 | Hidden                                 | Preserved in its current state | Hidden                                                                                 | Hidden unless required by the active page itself | Current page fills the recovered vertical space                  |
| Workbench/detached Workbench | Existing full-bleed ownership retained | Existing behavior              | Existing behavior                                                                      | Existing behavior                                | No nested shell replacement                                      |

No hidden shell element remains transparent or occupies layout space. The
standard shell returns from the same store and component tree, preserving:

- current route and active conversation;
- message history, composer draft, and scroll position;
- terminal tabs, panes, PTYs, command input, and active pane;
- unsaved page-local state;
- active application tabs;
- navigation and panel sizes.

A small, fixed, keyboard-focusable `Exit Focus Mode` control is rendered above
the active workspace only while Focus Mode has hidden the normal top-bar
control. It uses existing button primitives and theme tokens. It does not
reserve document space and remains available to pointer and keyboard users.

The transition is limited to fast opacity/transform changes on the exit
control and shell boundaries. `prefers-reduced-motion` disables that motion.
Page content is not animated, remounted, or measured during the transition.

### 3. Native system fullscreen adapter

A small adapter dynamically imports `getCurrentWindow` from
`@tauri-apps/api/window` only in an installed Tauri runtime. Its interface is:

```ts
export interface NativeFullscreenAdapter {
  availability(): FullscreenAvailability;
  read(): Promise<boolean>;
  write(enabled: boolean): Promise<boolean>;
  subscribe(listener: (enabled: boolean) => void): Promise<() => void>;
}
```

`write()` calls `setFullscreen(enabled)`, then calls `isFullscreen()` and
returns the observed result. A rejected call, an unexpected observed result,
or an unavailable runtime is an explicit failure and never updates application
state optimistically.

The adapter synchronizes operating-system exits by rechecking native state on
window resize/focus events. Event bursts are coalesced, and stale asynchronous
results cannot replace a newer request.

The browser preview remains usable: Focus Mode works, System Fullscreen reports
that native fullscreen requires the installed desktop app, and no browser
Fullscreen API fallback is attempted.

### 4. Native display behavior

Both settings use native Tauri fullscreen. They never manipulate operating
system UI directly.

- `always-hidden` requests standard native fullscreen and describes the bar as
  hidden for the fullscreen session, subject to operating-system security and
  emergency UI.
- `reveal-on-edge-hover` requests standard native fullscreen and delegates edge
  reveal to the operating system or window manager.

If the current platform or window manager cannot distinguish these policies,
the setting remains stored and the UI reports that edge behavior is managed by
the operating system. This is the prompt's required graceful fallback; it is
not presented as verified edge-reveal support.

The implementation does not use macOS simple fullscreen because that mode does
not take control of the entire monitor and therefore does not satisfy True
System Fullscreen.

### 5. Controls and layered exit

- The existing top-bar fullscreen button toggles Workspace Focus Mode.
- `Ctrl+Shift+F` on Windows/Linux and `Cmd+Shift+F` on macOS toggles Workspace
  Focus Mode through the existing `Mod+Shift+F` hotkey contract.
- The settings control toggles True System Fullscreen.
- `F11` toggles True System Fullscreen when the event is not consumed by an
  editable element or an existing higher-priority application interaction.
- `Esc` exits the most recently activated active fullscreen layer.
- The focus exit control always exits Focus Mode directly.
- System Fullscreen remains exit-able through its settings toggle, `F11`, and
  layered `Esc`.

When both layers are active, the last activated layer exits first. If System
Fullscreen exits externally, it is removed from activation order without
changing Focus Mode.

Existing assistant, command-palette, launcher, and action-registry workspace
fullscreen commands continue to operate, but are renamed internally to target
Workspace Focus Mode. Existing public action IDs remain compatible.

### 6. Preferences and safe restoration

The persisted preferences are:

- `rememberFocusMode`, default `false`;
- `rememberSystemFullscreen`, default `false`;
- `restoreFullscreenOnRestart`, default `false`;
- `systemFullscreenBehavior`, default `always-hidden`.

The last requested active state for each layer is persisted only when its
corresponding remember preference is enabled. Disabling a remember preference
clears that layer's remembered active state.

Restoration requires all of the following:

1. the master restore preference is enabled;
2. the layer's remember preference is enabled;
3. the layer was active at the last clean shutdown;
4. the stored application version matches the current application version;
5. the prior session recorded a clean shutdown;
6. the launch is not marked as recovery or safe mode.

Boot immediately marks the current session unclean. Normal close/pagehide
records the clean marker only after current fullscreen preferences and
remembered states are flushed. A crash therefore leaves an unclean marker and
suppresses restoration. A version change suppresses restoration once and
updates the stored version without modifying updater behavior.

Focus restoration happens after persisted UI hydration. Native System
Fullscreen restoration happens afterward through the same serialized native
controller used for manual requests. A restoration failure leaves the app in
normal windowed mode with an actionable status.

### 7. Settings

The existing Appearance section receives one `Fullscreen` section using
existing `Switch`, label, separator, and radio-control patterns. It contains:

- True System Fullscreen active toggle and live status;
- Always Hidden / Reveal on Edge Hover behavior selector;
- Remember Workspace Focus Mode switch;
- Remember True System Fullscreen switch;
- Restore fullscreen state when VibeSpace restarts switch;
- a short native-behavior status or failure message.

The restore switch remains available but explains that both remember
preferences control which layers can restore. No new settings tab or unrelated
appearance change is introduced.

### 8. Error handling and concurrency

- Native transitions are serialized.
- While a native transition is pending, additional identical requests
  coalesce and contradictory requests replace the queued target.
- A monotonic request identifier prevents stale completions from changing
  current state.
- Native errors are normalized to bounded, non-sensitive messages.
- Failed entry leaves System Fullscreen inactive.
- Failed exit leaves it active and keeps all exit controls available.
- Focus Mode never depends on native availability.
- Event listeners and pending restore work are disposed on unmount.
- No exception from fullscreen control may crash or block the application
  shell.

## Verification strategy

### Pure state tests

- independent activation and deactivation of both layers;
- activation ordering and most-recent-layer `Esc`;
- duplicate activation normalization;
- remembered-state sanitization and invalid persisted input;
- clean restart, crash, update/version-change, and recovery suppression;
- stale native result rejection and serialized target replacement.

### Component tests

- Chat Focus Mode removes application chrome and retains the same conversation
  subtree and draft.
- Terminal Focus Mode removes application chrome and retains the same terminal
  subtree, pane identity, and essential controls.
- Other-page Focus Mode retains the existing sidebar and active page.
- Exit Focus Mode control is visible, labeled, keyboard reachable, and does
  not occupy layout space.
- Focus exit restores the exact previous shell state.
- Settings expose exactly the required controls, status, and accessible names.
- Reduced motion disables fullscreen transition motion.

### Native adapter and host tests

- native entry and exit call `setFullscreen` and verify with `isFullscreen`;
- web preview and unavailable native API fail safely;
- native failure does not claim success;
- external native exit synchronizes application state;
- repeated toggles do not overlap;
- `F11`, `Mod+Shift+F`, and layered `Esc` have the required behavior;
- unmount removes all listeners.

### Integration and repository gates

- focused fullscreen tests;
- affected App, shell, settings, action, assistant, launcher, and hotkey tests;
- complete app TypeScript check;
- complete app test suite;
- production frontend build;
- exact-file formatting and `git diff --check`;
- native Tauri compile check because the JavaScript API/capability boundary is
  exercised, even though no Rust file changes;
- manual installed-app checks on the available Windows environment.

macOS, Linux, multiple physical displays, and their taskbar/Dock/panel reveal
behavior must be reported as unverified unless tested on those real
environments. Unit or mock evidence must never be described as platform
verification.

## Change recording

Every implementation slice will record:

- task ID and exact owned paths;
- starting and ending commit;
- behavior before and after;
- exact RED and GREEN test commands;
- broader verification results and skipped environments;
- security and privacy impact;
- remaining risks and rollback;
- lock expansion and release;
- PR #31 commit and remote SHA after publication.

Rollback is a normal revert of the bounded fullscreen commits. Because the
design adds no schema, migration, dependency, Rust, capability, billing,
cloud, or production change, rollback requires no external recovery step.
