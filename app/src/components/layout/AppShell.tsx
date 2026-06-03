import * as React from 'react';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { TooltipProvider } from '@/components/ui/tooltip';
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
 *   +- NavPane (animated 240/56)  | center column                     | Inspector (slides)
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
          </div>
        </div>
      </TooltipProvider>
    </MotionConfig>
  );
}
