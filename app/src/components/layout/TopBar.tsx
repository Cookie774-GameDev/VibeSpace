import * as React from 'react';
import {
  Search,
  Mic,
  Settings,
  PanelLeft,
  CalendarDays,
  Maximize2,
  Minimize2,
  Rocket,
  Sparkles,
  Terminal,
  KanbanSquare,
  BarChart3,
  Phone,
  PhoneOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { Hint } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { HOTKEYS } from '@/lib/hotkeys';
import { cn, isMac } from '@/lib/utils';
import { useCallStore } from '@/features/call/store';
import { getCallService } from '@/features/call/CallService';
import { toast } from '@/components/ui/toast';

/**
 * TopBar - 40px chrome at the very top of the app.
 *
 * Left cluster: collapse-nav button, workspace/project breadcrumb,
 * route breadcrumb segment (V3, when navigated away from chat).
 *
 * Right cluster: quick launcher, assistant, route nav (terminal /
 * kanban / benchmarks - V3), schedule, fullscreen toggle, search,
 * voice mic, settings, avatar.
 *
 * The header itself is a Tauri drag region so users can drag the window
 * by its background. Interactive elements opt out via `no-drag`.
 *
 * V3 also adds a copper bottom-border accent that fades in when the
 * user has navigated away from the chat canvas, signalling context.
 */

// --- Route store contract (Slice 4 / Slice 12) -------------------------
// `route` and `setRoute` may not exist on useUIStore until that slice
// lands. We read them defensively and gracefully degrade.

type Route =
  | 'chat'
  | 'terminal'
  | 'kanban'
  | 'agents'
  | 'skills'
  | 'benchmarks'
  | 'history';

const ROUTES: ReadonlyArray<Route> = [
  'chat',
  'terminal',
  'kanban',
  'agents',
  'skills',
  'benchmarks',
  'history',
];

const ROUTE_LABELS: Record<Route, string> = {
  chat: 'Chat',
  terminal: 'Terminal',
  kanban: 'Kanban',
  agents: 'Agents',
  skills: 'Skills',
  benchmarks: 'Benchmarks',
  history: 'History',
};

type RouteStoreShape = {
  route?: Route;
  setRoute?: (r: Route) => void;
};

// Active-button styling shared by the three route buttons. Override the
// ghost variant's text-muted-foreground (and its hover) with copper, and
// add a gentle copper ring so the current route is unmistakable.
const ROUTE_BTN_ACTIVE =
  'ring-1 ring-accent-copper/40 text-accent-copper hover:text-accent-copper';

export function TopBar() {
  const navOpen = useUIStore((s) => s.navOpen);
  const toggleNav = useUIStore((s) => s.toggleNav);
  const voiceListening = useUIStore((s) => s.voiceListening);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleVoice = useUIStore((s) => s.toggleVoice);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  // V2 — schedule + launcher + fullscreen
  const setScheduleOpen = useUIStore((s) => s.setScheduleOpen);
  const setLauncherOpen = useUIStore((s) => s.setLauncherOpen);
  const setAssistantOpen = useUIStore((s) => s.setAssistantOpen);
  const chatFullscreen = useUIStore((s) => s.chatFullscreen);
  const toggleChatFullscreen = useUIStore((s) => s.toggleChatFullscreen);

  // V3 — route store (defensive read; field may be absent pre-Slice 4).
  const route = useUIStore(
    (s) => ((s as unknown) as RouteStoreShape).route ?? 'chat',
  );
  const setRouteRaw = useUIStore(
    (s) => ((s as unknown) as RouteStoreShape).setRoute,
  );

  const setRouteWarned = React.useRef(false);
  const setRoute = React.useCallback(
    (r: Route) => {
      if (typeof setRouteRaw === 'function') {
        setRouteRaw(r);
        return;
      }
      if (!setRouteWarned.current) {
        setRouteWarned.current = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[TopBar] useUIStore.setRoute is not available yet; route navigation is a no-op until Slice 4 lands.',
        );
      }
    },
    [setRouteRaw],
  );

  const workspaceId = useAuthStore((s) => s.workspaceId);
  const projectId = useAuthStore((s) => s.projectId);
  const displayName = useAuthStore((s) => s.displayName);

  // The auth store currently has only IDs for workspace/project (no name
  // fields), so we fall back to generic labels when the IDs are set, and
  // "Loading..." when they're null. Replace with real names once the
  // auth/workspaces stores expose them.
  const workspaceLabel = workspaceId ? 'Workspace' : 'Loading\u2026';
  const projectLabel = projectId ? 'Project' : null;

  const offChat = route !== 'chat';
  const [routeMenuOpen, setRouteMenuOpen] = React.useState(false);

  return (
    <header
      aria-label="Application header"
      className={cn(
        'drag-region relative flex h-10 shrink-0 items-center gap-2 border-b bg-panel pr-2 text-secondary transition-colors',
        offChat ? 'border-accent-copper/40' : 'border-border',
        // Reserve room on macOS for native traffic-light buttons in
        // titleBarStyle: overlay configurations.
        isMac ? 'pl-[72px]' : 'pl-2',
      )}
    >
      {/* Left: nav toggle */}
      <div className="no-drag flex items-center">
        <Hint label={navOpen ? 'Hide sidebar' : 'Show sidebar'} hotkey="Mod+B">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleNav}
            aria-label="Toggle navigation"
            aria-pressed={navOpen}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        </Hint>
      </div>

      {/* Breadcrumb */}
      <div className="no-drag flex min-w-0 items-center gap-1.5">
        <Avatar
          seed={workspaceId ?? 'workspace'}
          initials={(workspaceLabel || 'W').charAt(0)}
          size={20}
          className="shrink-0"
        />
        <span
          className={cn(
            'truncate text-secondary font-medium',
            workspaceId ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {workspaceLabel}
        </span>
        {projectLabel && (
          <>
            <span className="px-0.5 text-secondary text-muted-foreground/60 select-none">/</span>
            <span className="truncate text-secondary text-muted-foreground">{projectLabel}</span>
          </>
        )}
        {offChat && (
          <>
            <span className="px-0.5 text-secondary text-muted-foreground/60 select-none">/</span>
            <Popover open={routeMenuOpen} onOpenChange={setRouteMenuOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`Current route: ${ROUTE_LABELS[route]}. Open route switcher`}
                  aria-haspopup="menu"
                  aria-expanded={routeMenuOpen}
                  className={cn(
                    'truncate rounded px-1 text-secondary text-accent-copper transition-colors',
                    'hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/50',
                  )}
                >
                  {ROUTE_LABELS[route]}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={6} className="w-44 p-1">
                <ul role="menu" className="flex flex-col gap-0.5">
                  {ROUTES.map((r) => {
                    const active = r === route;
                    return (
                      <li key={r} role="none">
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          onClick={() => {
                            setRoute(r);
                            setRouteMenuOpen(false);
                          }}
                          className={cn(
                            'w-full rounded px-2 py-1.5 text-left text-secondary transition-colors',
                            'hover:bg-muted hover:text-foreground',
                            active
                              ? 'text-accent-copper font-medium'
                              : 'text-foreground/90',
                          )}
                        >
                          {ROUTE_LABELS[r]}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      {/* Spacer (also drag region) */}
      <div className="flex-1" />

      {/* Right cluster */}
      <div className="no-drag flex items-center gap-1">
        <Hint label="Quick launcher" hotkey={HOTKEYS.LAUNCHER}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setLauncherOpen(true)}
            aria-label="Open quick launcher"
          >
            <Rocket className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Jarvis Assistant" hotkey={HOTKEYS.ASSISTANT}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setAssistantOpen(true)}
            aria-label="Open Jarvis Assistant"
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Terminals">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRoute('terminal')}
            aria-label="Terminals"
            aria-pressed={route === 'terminal'}
            className={cn(route === 'terminal' && ROUTE_BTN_ACTIVE)}
          >
            <Terminal className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Kanban">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRoute('kanban')}
            aria-label="Kanban"
            aria-pressed={route === 'kanban'}
            className={cn(route === 'kanban' && ROUTE_BTN_ACTIVE)}
          >
            <KanbanSquare className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Benchmarks">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setRoute('benchmarks')}
            aria-label="Benchmarks"
            aria-pressed={route === 'benchmarks'}
            className={cn(route === 'benchmarks' && ROUTE_BTN_ACTIVE)}
          >
            <BarChart3 className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Schedule" hotkey={HOTKEYS.SCHEDULE}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setScheduleOpen(true)}
            aria-label="Open schedule"
          >
            <CalendarDays className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint
          label={chatFullscreen ? 'Exit fullscreen' : 'Fullscreen workspace'}
          hotkey={HOTKEYS.TOGGLE_FULLSCREEN}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleChatFullscreen}
            aria-label={chatFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            aria-pressed={chatFullscreen}
          >
            {chatFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </Hint>

        <Hint label="Search" hotkey="Mod+K">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open command palette"
          >
            <Search className="h-4 w-4" />
          </Button>
        </Hint>

        <Hint label="Voice" hotkey="Mod+Space">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleVoice}
            aria-label="Voice"
            aria-pressed={voiceListening}
            className="relative"
          >
            <Mic
              className={cn('h-4 w-4 transition-colors', voiceListening && 'text-accent-cyan')}
            />
            {voiceListening && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-accent-cyan/60 animate-pulse"
              />
            )}
          </Button>
        </Hint>

        <CallTopBarButton />

        <Hint label="Settings" hotkey="Mod+,">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
        </Hint>

        <div className="pl-1">
          <Avatar
            seed={displayName || workspaceId || 'jarvis'}
            initials={(displayName || 'J').charAt(0)}
            size={24}
            aria-label={displayName ? `Profile: ${displayName}` : 'Profile'}
          />
        </div>
      </div>
    </header>
  );
}

/**
 * Call button — small TopBar control. Lives here (not in /features/call)
 * so the TopBar's no-drag region wraps it consistently with other controls.
 *
 * idle:   green Phone icon, click opens the call modal (which auto-starts).
 * active: red PhoneOff icon, click hangs up immediately.
 *
 * Disabled with explanatory toast when the cloud URL is unset.
 */
function CallTopBarButton() {
  const status = useCallStore((s) => s.status);
  const setCallModalOpen = useUIStore((s) => s.setCallModalOpen);

  const inCall = status !== 'idle';
  const service = getCallService();
  const configured = service.isConfigured();

  const handleClick = () => {
    if (!configured) {
      toast.info(
        'Phone & Voice not set up',
        'Open Settings → Phone & Voice and point Jarvis at your phone-jarvis cloud.',
      );
      return;
    }
    if (inCall) {
      void service.stop();
      return;
    }
    setCallModalOpen(true);
  };

  return (
    <Hint label={inCall ? 'Hang up' : 'Call Sage'}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleClick}
        aria-label={inCall ? 'Hang up' : 'Call Sage'}
        className={cn(
          inCall && 'text-rose-500 hover:text-rose-400',
          !inCall && configured && 'text-emerald-500 hover:text-emerald-400',
          !configured && 'text-muted-foreground/50',
        )}
      >
        {inCall ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </Button>
    </Hint>
  );
}
