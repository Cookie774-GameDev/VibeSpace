# Feature Requests

## [FEAT-20260924-G7M] native_cli_controls

**Logged**: 2026-09-24T21:24:00Z
**Priority**: high
**Status**: in_progress
**Area**: frontend

### Requested Capability
Native OpenCode and Codex CLI mode, approval, command, token, and file-change surfaces that reflect the active CLI and remain usable in the official app.

### User Context
The user saw high-risk labels on ordinary commands, an oversized approval card, a dropdown that would not scroll, and counters that opened settings instead of their own details.

### Complexity Estimate
medium

### Suggested Implementation
Use CLI-provided approval events and per-launch policy, repair the existing picker and compact card, and show honest usage/file details from persisted session evidence.

### Metadata
- Frequency: recurring
- Related Features: chat, CLI harness, agentic console

---

## [FEAT-20260926-RL1] agent_relay_group_chat_profiles_and_user_control

**Logged**: 2026-09-26T22:22:44Z
**Priority**: high
**Status**: in_progress
**Area**: frontend

### Requested Capability
A small native Agent Relay group-chat panel with distinct cute agent icons, SVG/motion, a user composer, and click-through profiles showing verified agent, model, harness, current work/files, and recent prompt information. User commands have highest authority; a request to stop agents must use a real host stop path and confirm the result.

### User Context
The user wants to see agent collaboration and message as the user without changing the upstream communication engine.

### Complexity Estimate
medium

### Suggested Implementation
Enhance the existing RelayGroupChat/WorkbenchFabric panel after core Relay exchange is proven. Feed it bounded native SDK/MCP room snapshots; show unknown fields honestly; keep user posts as role-separated human credentials. Wire Stop agents only through verified existing host cancellation authority and show failures rather than optimistic success. Use the pinned Motion dependency with reduced-motion support.

### Metadata
- Frequency: first_time
- Related Features: Agent Relay, Workbench, native chat

---

## [FEAT-20260927-RI02] relay_inspector_tab_and_threaded_replies

**Logged**: 2026-09-27T04:29:57Z
**Priority**: high
**Status**: in_progress
**Area**: frontend

### Requested Capability
Show the live Agent Relay room in the Inspector's icon tab strip, style it with understated silver flowers matching the chat page, and allow replies to a particular message with visible thread context.

### User Context
The user wants to follow and direct agent collaboration from the narrow Inspector without opening the Workbench drawer.

### Complexity Estimate
medium

### Suggested Implementation
Reuse the existing native room binding and upstream parent-message reply API. Render a compact Inspector variant of RelayGroupChat with the existing floral assets, and preserve sender and parent IDs in the live room snapshot.

### Metadata
- Frequency: recurring
- Related Features: Agent Relay, Inspector, threaded chat

---

### 2026-09-27 correction to FEAT-20260927-RI02
The user rejected reused flower assets. The Inspector background now uses the chat botanical canvas's deterministic sections and seeded randomness to draw individually varied silver flowers, curved stems, and a different number of thorns per bloom. The Workbench drawer remains available.

## [FEAT-20260927-TC27] branded_windows_toasts

**Logged**: 2026-09-27T14:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: backend

### Requested Capability
Windows task notifications should show VibeSpace as the sender with its logo, including in the Live C2 native development app. The running app's taskbar icon should use the official full quality VibeSpace logo.

### User Context
A Jarvis task failure toast displayed Windows PowerShell and its icon above the task title and VibeSpace body copy. The taskbar also displayed an orange J icon from an older Jarvis identity.

### Suggested Implementation
Use a distinct VibeSpace notification AppUserModelID with a matching Start Menu shortcut for unpackaged Windows toasts. Give the running Windows app its own shell identity so it uses the bundled VibeSpace icon instead of the older Jarvis shortcut. Verify both in native C2 while preserving the historical app data identifier.

### Metadata
- Source: user_feedback
- Related Files: app/src-tauri/src/notification_branding.rs, app/src-tauri/src/branding.rs, app/src/lib/tauri.ts
- Tags: windows, notifications, branding, taskbar

### Verified Result

Live C2 (PID 1060, CDP 9252) showed a Windows banner from VibeSpace, a
Notification Center entry with the official V icon, and an active V taskbar
button. The legacy J remains a separate app button.

---
## [FEAT-20260927-WB28] themed_windows_notification_content

**Logged**: 2026-09-27T16:16:00Z
**Priority**: medium
**Status**: in_progress
**Area**: frontend

### Requested Capability

Windows notifications should carry VibeSpace's warm palette and branding throughout the visible content, beyond the sender name and app icon. Keep native delivery and Notification Center history.

### Implementation Direction

Use a full-width Windows toast hero image and official V icon. Windows owns the toast chrome/background color, so theme the supported image area rather than promising arbitrary shell recoloring. Verify the actual banner and Notification Center in official C2.

### Metadata

- Source: user_feedback
- Related Files: app/src-tauri/src/notification_branding.rs, app/src-tauri/icons/notification-hero.svg
- Tags: windows, notifications, branding, theme

---
