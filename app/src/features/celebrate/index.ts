/**
 * Wave 4 — Celebration system barrel.
 *
 * Public API:
 *   - celebrate(kind, detail?)        Fire a celebration from anywhere.
 *   - <CelebrationHost />             Mount once inside `WorkspaceRoot`.
 *
 * The host renders a pure-canvas <Confetti /> overlay AND a serif
 * gradient toast for each celebration. `prefers-reduced-motion`
 * suppresses the canvas but the toast still fires.
 */

import * as React from 'react';
import { toast } from '@/components/ui/toast';
import { Confetti } from './Confetti';
import { CELEBRATE_EVENT, type CelebrationKind } from './celebrate';

export { celebrate, CELEBRATE_EVENT } from './celebrate';
export type { CelebrationKind, CelebrateEventDetail } from './celebrate';
export { Confetti } from './Confetti';

const HEADLINES: Record<CelebrationKind, string> = {
  project_created: 'New project. Welcome aboard.',
  kanban_done: 'Done. Nice.',
  terminal_success: 'Build green. Ship it.',
  big: '🎉 Big win.',
};

const SUBLINES: Record<CelebrationKind, string> = {
  project_created: "Let's build something good.",
  kanban_done: 'One off the list.',
  terminal_success: 'All checks passed.',
  big: 'That deserves a moment.',
};

/**
 * Host component for the celebration system. Mount once near app root
 * (inside `WorkspaceRoot`). Renders the canvas overlay and fires the
 * gradient toast on each celebration event. Reduced-motion suppresses
 * the canvas but the toast still fires.
 */
export function CelebrationHost(): JSX.Element {
  React.useEffect(() => {
    const onCelebrate = (e: WindowEventMap[typeof CELEBRATE_EVENT]) => {
      const { kind, detail } = e.detail;
      const headline = HEADLINES[kind];
      if (!headline) return;
      // Existing toast API has no `variant` slot, so we fall back to
      // plain success per the contract; the existing serif/gradient
      // styling can be layered on later without changing this call site.
      toast.success(headline, detail ?? SUBLINES[kind]);
    };
    window.addEventListener(CELEBRATE_EVENT, onCelebrate);
    return () => window.removeEventListener(CELEBRATE_EVENT, onCelebrate);
  }, []);

  return React.createElement(Confetti);
}
