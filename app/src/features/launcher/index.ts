/**
 * V2 — Quick Launch.
 *
 * A keyboard-first launcher pad for URLs/apps/files/jarvis-actions. Backed by
 * the Dexie `quick_links` and `quick_link_groups` tables.
 *
 * Render path:
 *   - Mod+Shift+L hotkey opens the dialog
 *   - Topbar button + command-palette action also open it
 *   - The dialog reads `useUIStore.launcherOpen`
 */
export { LauncherDialog } from './LauncherDialog';
export { LinkEditDialog } from './LinkEditDialog';
export { useQuickLinks, useQuickLinkGroups, useStaleLinks } from './hooks';
export { launchLink, QUICK_PRESETS } from './launch';
export { useLinkHotkeys } from './useLinkHotkeys';
