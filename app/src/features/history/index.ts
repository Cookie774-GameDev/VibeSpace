/**
 * V3 — Session History.
 *
 * Two-pane page that lists past chats and replays them with a scrubber.
 * Mounted by the page router (Slice 13) when `useUIStore.route === 'history'`.
 *
 * The slice is intentionally self-contained:
 *   - Reads from the existing `chats` / `messages` Dexie tables.
 *   - Reimplements a minimal MessageBubble locally so it does not couple to
 *     the production chat canvas.
 *   - Mutates UI store only via `setActiveChat` + `setRoute('chat')` when the
 *     user picks "Open in chat".
 */
export { HistoryPage } from './HistoryPage';
export { HistoryList } from './HistoryList';
export { Replay } from './Replay';
