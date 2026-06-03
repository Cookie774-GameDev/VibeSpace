/**
 * useWhatsNew — read/write the "last seen version" so the WhatsNewModal
 * can decide whether to auto-open on boot.
 *
 * Backed by `useUIStore` so every consumer (TopBar dot indicator, the
 * modal host, anywhere else) shares the same reactive state. When the
 * user dismisses the modal, the store update flows to all subscribers
 * and the unseen-dot disappears in the same render tick.
 *
 * Persistence: the underlying field `lastSeenWhatsNewVersion` is in
 * `useUIStore`'s `partialize` whitelist, so it survives reloads via the
 * shared `jarvis-ui` localStorage entry.
 */
import { useUIStore } from '@/stores/ui';
import { CURRENT_VERSION } from './releases';

export interface UseWhatsNewResult {
  /** The version this build advertises (mirrors `CURRENT_VERSION`). */
  currentVersion: string;
  /**
   * The version the user last dismissed the modal at, or `null` on a
   * fresh install. Reactive — re-renders all consumers when the store
   * value changes.
   */
  lastSeenVersion: string | null;
  /**
   * `true` when `lastSeenVersion` differs from `currentVersion`.
   * Use this to decide whether to auto-open the modal on boot, or to
   * show an "unseen update" dot on the manual entry point.
   */
  hasUpdate: boolean;
  /** Persist `currentVersion` as the new `lastSeenVersion`. */
  markSeen: () => void;
}

export function useWhatsNew(): UseWhatsNewResult {
  const lastSeenVersion = useUIStore((s) => s.lastSeenWhatsNewVersion);
  const markWhatsNewSeen = useUIStore((s) => s.markWhatsNewSeen);

  const markSeen = () => markWhatsNewSeen(CURRENT_VERSION);

  return {
    currentVersion: CURRENT_VERSION,
    lastSeenVersion,
    hasUpdate: lastSeenVersion !== CURRENT_VERSION,
    markSeen,
  };
}
