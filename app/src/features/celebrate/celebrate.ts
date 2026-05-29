/**
 * Wave 4 — Celebration bus.
 *
 * Tiny pub/sub that fires `CustomEvent('jarvis:celebrate')` on the window.
 * Subscribers (Confetti, CelebrationHost) react: paint particles + toast.
 *
 * Anyone who wants to celebrate just calls `celebrate('project_created')`.
 * No imports of UI from callers — keeps this slice low-coupling.
 */

export type CelebrationKind =
  | 'project_created'
  | 'kanban_done'
  | 'terminal_success'
  | 'big';

export interface CelebrateEventDetail {
  kind: CelebrationKind;
  detail?: string;
}

declare global {
  interface WindowEventMap {
    'jarvis:celebrate': CustomEvent<CelebrateEventDetail>;
  }
}

export const CELEBRATE_EVENT = 'jarvis:celebrate' as const;

/**
 * Fire a celebration. Confetti + serif toast (toast still fires under
 * prefers-reduced-motion; only the canvas is suppressed).
 */
export function celebrate(kind: CelebrationKind, detail?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<CelebrateEventDetail>(CELEBRATE_EVENT, {
      detail: { kind, detail },
    }),
  );
}
