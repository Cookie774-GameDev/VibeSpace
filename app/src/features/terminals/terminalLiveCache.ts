/**
 * In-memory live cache of pane trees, keyed by project id.
 *
 * Why this exists.
 *   The pane tree is persisted to `localStorage` with `sessionId`
 *   values stripped. That stripping is correct for full app reloads
 *   — the Rust process and every PTY it owned died with the app, so
 *   any session id we'd remembered would point at nothing.
 *
 *   It's WRONG for in-app project switches. When the user flips from
 *   project A to B and back, the Rust process never died — every PTY
 *   from project A is still alive, still has `opencode`/`claude`/etc.
 *   running. Reading from `localStorage` on the swap would lose those
 *   ids and force a fresh spawn, leaving the original PTYs orphaned
 *   in the backend HashMap forever and the user staring at brand-new
 *   shells where their work used to be.
 *
 *   This cache holds the *live* tree (with session ids intact) per
 *   project, in process memory. It survives project switches and
 *   route navigation (TerminalsPage unmount/remount), but is correctly
 *   blown away on full app reload because module memory is reset.
 *
 * Lifecycle.
 *   - `captureLiveTree(pid, tree)` runs on every tree change for the
 *     active project. The latest snapshot wins.
 *   - `getLiveTree(pid)` is consulted before falling back to
 *     localStorage when restoring a project's tree.
 *   - `clearLiveTree(pid)` is for the rare cases where we want to
 *     force a fresh load (e.g. an explicit "reset terminals for this
 *     project" action from settings, if we ever add one). Today the
 *     "Reset" button in the page chrome resets only the active tree
 *     in React state and re-caches via the normal write path; it does
 *     not need to invalidate.
 *
 * Why a plain Map (not Zustand).
 *   We never need to subscribe to cache changes from React. The cache
 *   is a write-through helper: TerminalsPage writes on every tree
 *   change, reads on project switch, and that's it. Adding a store
 *   would buy us nothing and cost a useStore subscription on every
 *   render.
 *
 * Caveats.
 *   - Ctrl+R in the WebView (dev) reloads React but NOT the Rust
 *     process. The PTYs survive but this cache is wiped, so we'll
 *     spawn fresh and orphan the survivors. Not addressed here — a
 *     future fix would call `terminal_list` on boot and reconcile.
 *   - Hot-module replacement of this module would also wipe the cache
 *     mid-session. Vite usually doesn't HMR module-level Maps cleanly,
 *     so we mark this module as a no-HMR boundary via the pattern
 *     below — Vite will do a full page refresh instead of an in-place
 *     swap, which is the desired behaviour (in-place swap would lose
 *     the cache for active projects).
 */

import type { PaneNode } from './paneTree';

const liveTreeCache = new Map<string, PaneNode>();

/**
 * Stable map key for a project id. We accept `null` (which means
 * "no project active" — a legitimate state) and normalize it to a
 * sentinel so the Map doesn't fight over `null` vs `undefined`.
 */
function keyFor(projectId: string | null | undefined): string {
  return projectId ?? '__default__';
}

/**
 * Stash the given tree under `projectId`. Overwrites whatever was
 * there; the latest snapshot is always what we want.
 *
 * Callers should pass the tree as it currently exists in React state
 * — including any `sessionId` values — so a subsequent
 * `getLiveTree(projectId)` returns a re-attachable tree.
 */
export function captureLiveTree(
  projectId: string | null | undefined,
  tree: PaneNode,
): void {
  liveTreeCache.set(keyFor(projectId), tree);
}

/**
 * Retrieve the most recently captured tree for a project, or
 * `undefined` if we've never seen one this session.
 */
export function getLiveTree(
  projectId: string | null | undefined,
): PaneNode | undefined {
  return liveTreeCache.get(keyFor(projectId));
}

/**
 * Drop the cached tree for a project. Reserved for the "reset" path
 * if we ever expose one; nothing in the current codebase calls this.
 */
export function clearLiveTree(
  projectId: string | null | undefined,
): void {
  liveTreeCache.delete(keyFor(projectId));
}

/** Iterate cached pane trees (for persistence flush). */
export function forEachLiveTree(
  fn: (projectId: string | null, tree: PaneNode) => void,
): void {
  for (const [cacheKey, tree] of liveTreeCache.entries()) {
    fn(cacheKey === '__default__' ? null : cacheKey, tree);
  }
}

/**
 * Test/debug helper. Not exported through the barrel; only the unit
 * tests reach for this directly.
 */
export function _resetLiveCacheForTests(): void {
  liveTreeCache.clear();
}

// Vite HMR opt-out: hot-swapping this module mid-session would wipe
// the Map and silently break the project-switch contract. A full
// page reload is the safer default; the user loses dev-time PTYs
// either way.
if (typeof import.meta !== 'undefined' && (import.meta as ImportMeta & { hot?: { decline: () => void } }).hot) {
  (import.meta as ImportMeta & { hot: { decline: () => void } }).hot.decline();
}
