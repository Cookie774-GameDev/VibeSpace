/**
 * Live UI scale for nested surfaces (pet mini-panel). Avoids chat↔pets import cycles.
 */
import { useSyncExternalStore } from 'react';

let livePanelScale = 1;
const listeners = new Set<() => void>();

export function setLivePanelUiScale(scale: number): void {
  // Match petPanelUiScale floor (0.62) so pickers track the smallest panels.
  const next = Number.isFinite(scale) ? Math.max(0.62, Math.min(1, scale)) : 1;
  if (next === livePanelScale) return;
  livePanelScale = next;
  for (const listener of listeners) listener();
}

export function getLivePanelUiScale(): number {
  return livePanelScale;
}

export function subscribeLivePanelUiScale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook — re-renders compact pickers when the mini panel is resized. */
export function useLivePanelUiScale(enabled = true): number {
  return useSyncExternalStore(
    subscribeLivePanelUiScale,
    () => (enabled ? livePanelScale : 1),
    () => 1,
  );
}
