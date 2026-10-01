/**
 * DevConsoleHost — non-rendering bootstrap component.
 *
 * Four jobs:
 *   1. Install the patchers on mount (and tear them down on unmount).
 *   2. Wire the Mod+Shift+D / F12 hotkeys so the user can summon the panel.
 *   3. Subscribe to UI store route changes and emit them on the `route`
 *      DevConsole channel so navigation shows up in the same feed as
 *      console / fetch / invoke / AI / action breadcrumbs.
 *   4. Mount `<DevConsolePanel/>`.
 *
 * Sits at the App root (outside `<AuthGate>`) so it captures events
 * during onboarding too — that's where most "stuck on a screen"
 * reports happen.
 */

import * as React from 'react';
import { matchesHotkey, resolveHotkey } from '@/lib/hotkeys';
import { DevConsolePanel } from './DevConsolePanel';
import { installPatchers } from './patchers';
import { devConsole, useDevConsoleStore } from './store';
import { useUIStore } from '@/stores/ui';

export function DevConsoleHost() {
  const toggleOpen = useDevConsoleStore((s) => s.toggleOpen);

  React.useEffect(() => {
    const teardown = installPatchers();
    // One-time boot anchor so every session timeline starts with a
    // "where am I running" entry. Captured on the `app` channel so it
    // sits separately from the patcher-driven channels (console /
    // fetch / invoke / event / window) and the activity channels
    // wired below.
    devConsole.log({
      channel: 'app',
      level: 'info',
      message: 'DevConsole booted',
      detail: {
        tauri:
          typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
            .__TAURI_INTERNALS__ !== 'undefined',
        href: typeof location !== 'undefined' ? location.href : null,
        userAgent:
          typeof navigator !== 'undefined' ? navigator.userAgent : null,
        platform:
          typeof navigator !== 'undefined'
            ? (navigator as Navigator & { platform?: string }).platform ?? null
            : null,
        language:
          typeof navigator !== 'undefined' ? navigator.language : null,
      },
    });
    return teardown;
  }, []);

  // Route subscription. We subscribe directly to the Zustand store so
  // this component never re-renders on a route change (the panel
  // observes its own store) — only the side-effect logger fires. The
  // initial route is logged once on mount so the timeline always
  // starts with a "you are here" entry.
  React.useEffect(() => {
    let prev = useUIStore.getState().route;
    devConsole.log({
      channel: 'route',
      level: 'info',
      message: `Route boot: ${prev}`,
      detail: { route: prev, initial: true },
    });
    const unsub = useUIStore.subscribe((state) => {
      const next = state.route;
      if (next === prev) return;
      const from = prev;
      prev = next;
      devConsole.log({
        channel: 'route',
        level: 'info',
        message: `Route ${from} → ${next}`,
        detail: { from, to: next },
      });
    });
    return unsub;
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Live registry so Settings → Hotkeys rebinds apply immediately.
      if (matchesHotkey(e, resolveHotkey('DEV_CONSOLE'))) {
        e.preventDefault();
        toggleOpen();
        return;
      }
      if (matchesHotkey(e, resolveHotkey('DEV_CONSOLE_F12'))) {
        e.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleOpen]);

  return <DevConsolePanel />;
}
