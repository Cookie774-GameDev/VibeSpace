import * as React from 'react';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useHotkey, HOTKEYS } from '@/lib/hotkeys';
import { useUIStore } from '@/stores/ui';
import { TopBar } from './TopBar';
import { NavPane } from './NavPane';
import { Inspector } from './Inspector';
import { TabStrip } from './TabStrip';
import { ActivityStrip } from './ActivityStrip';

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * AppShell - the chrome of the entire desktop app.
 *
 * Composition:
 *   TopBar (40px)
 *   +- NavPane (animated 240/56)  | center column                     | Inspector (slides) | TodoDrawer slot
 *                                 | TabStrip (32px)                   |
 *                                 | <main>{children}</main>           |
 *                                 | ActivityStrip (32px, council only)|
 *
 * The shell does not decide which canvas is active - children are slotted
 * by the caller. The shell wires global hotkeys for nav / inspector /
 * palette / voice / settings.
 *
 * `<MotionConfig reducedMotion="user">` propagates the user's
 * prefers-reduced-motion preference to every motion primitive in the tree.
 * Combined with the global CSS rule in globals.css this gives full
 * accessibility coverage.
 */
export function AppShell({ children }: AppShellProps) {
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const toggleNav = useUIStore((s) => s.toggleNav);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleVoice = useUIStore((s) => s.toggleVoice);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  useHotkey(HOTKEYS.TOGGLE_NAV, (e) => {
    e.preventDefault();
    toggleNav();
  });
  useHotkey(HOTKEYS.TOGGLE_INSPECTOR, (e) => {
    e.preventDefault();
    toggleInspector();
  });
  useHotkey(HOTKEYS.PALETTE, (e) => {
    e.preventDefault();
    setPaletteOpen(true);
  });
  useHotkey(HOTKEYS.PUSH_TO_TALK, (e) => {
    e.preventDefault();
    toggleVoice();
  });
  useHotkey(HOTKEYS.SETTINGS, (e) => {
    e.preventDefault();
    setSettingsOpen(true);
  });

  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
    >
      <TooltipProvider delayDuration={400}>
        <div className="flex h-full w-full flex-col bg-background text-foreground">
          <TopBar />

          <div className="flex min-h-0 flex-1">
            <NavPane />

            <div className="flex min-w-0 flex-1 flex-col">
              <TabStrip />
              <main
                aria-label="Workspace"
                className="min-h-0 min-w-0 flex-1 overflow-auto"
              >
                {children}
              </main>
              <ActivityStrip />
            </div>

            <AnimatePresence initial={false}>
              {inspectorOpen && <Inspector key="inspector" />}
            </AnimatePresence>

            {/* Slot owned by A5 (TodoDrawer); A5 portals into this aside. */}
            <aside id="todo-drawer-root" aria-label="Tasks" />
          </div>
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
