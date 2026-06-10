import * as React from 'react';
import {
  Search,
  Mic,
  Bot,
  Settings,
  PanelLeft,
  CalendarDays,
  Maximize2,
  Minimize2,
  Rocket,
  Sparkles,
  Phone,
  PhoneOff,
  Megaphone,
  MoreHorizontal,
  PanelRight,
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
import { isCallConfigured, loadCallService } from '@/features/call';
import { toast } from '@/components/ui/toast';
import { useWhatsNew } from '@/features/whats-new';
import { isAdminIdentity, planAllowsJarvisCall } from '@/lib/entitlements';

/**
 * TopBar - 40px chrome at the very top of the app.
 *
 * Left cluster: collapse-nav button, workspace/project breadcrumb,
 * route breadcrumb segment (a popover route switcher shown when the user
 * has navigated away from chat — this is the lightweight way to jump
 * routes when the sidebar is collapsed).
 *
 * Right cluster: quick launcher, assistant, schedule, fullscreen toggle,
 * search, voice mic, call, what's new, settings, avatar. Route navigation
 * lives in the side NavPane (and the breadcrumb popover) — we deliberately
 * don't duplicate per-route icon buttons here.
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
  | 'schedule'
  | 'agents'
  | 'agent-detail'
  | 'project-detail'
  | 'context'
  | 'skills'
  | 'benchmarks'
  | 'history'
  | 'tools'
  | 'files'
  | 'account';

const ROUTES: ReadonlyArray<Route> = [
  'chat',
  'terminal',
  'kanban',
  'schedule',
  'agents',
  'context',
  'skills',
  'benchmarks',
  'history',
  'tools',
  'files',
  'account',
];

const ROUTE_LABELS: Record<Route, string> = {
  chat: 'Chat',
  terminal: 'Terminal',
  kanban: 'Kanban',
  schedule: 'Schedule',
  agents: 'Agents',
  'agent-detail': 'Agent',
  'project-detail': 'Project',
  context: 'Context',
  skills: 'Skills',
  benchmarks: 'Benchmarks',
  history: 'History',
  tools: 'Tools',
  files: 'Files',
  account: 'Account',
};

type RouteStoreShape = {
  route?: Route;
  setRoute?: (r: Route) => void;
};

export function TopBar() {
  const navOpen = useUIStore((s) => s.navOpen);
  const toggleNav = useUIStore((s) => s.toggleNav);
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const voiceListening = useUIStore((s) => s.voiceListening);
  const setVoiceModalOpen = useUIStore((s) => s.setVoiceModalOpen);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const toggleVoice = useUIStore((s) => s.toggleVoice);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  // V2 — launcher + fullscreen
  const setLauncherOpen = useUIStore((s) => s.setLauncherOpen);
  const setAssistantOpen = useUIStore((s) => s.setAssistantOpen);
  const setWhatsNewOpen = useUIStore((s) => s.setWhatsNewOpen);
  const chatFullscreen = useUIStore((s) => s.chatFullscreen);
  const toggleChatFullscreen = useUIStore((s) => s.toggleChatFullscreen);

  // Drives the unseen-dot indicator on the "What's new" button. The
  // hook is backed by Zustand so this re-renders the moment the user
  // dismisses the modal.
  const { hasUpdate: hasUnseenWhatsNew, currentVersion } = useWhatsNew();

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

  // V3.1 — compact chrome.
  // The user wants more vertical room for terminals; specifically the
  // top bar should shrink whenever the user is on the terminal route
  // OR has flipped chat-fullscreen on. We collapse height to 28px and
  // funnel low-frequency buttons (launcher, assistant, schedule, search,
  // voice, call, what's-new) into a `⋯` overflow popover so the right
  // cluster stays just: fullscreen, more, settings, avatar.
  const compactChrome = route === 'terminal' || chatFullscreen;
  const [overflowOpen, setOverflowOpen] = React.useState(false);

  return (
    <header
      aria-label="Application header"
      className={cn(
        'drag-region relative flex shrink-0 items-center gap-2 border-b bg-panel pr-2 text-secondary transition-[height,padding,colors] duration-150',
        compactChrome ? 'h-7 gap-1' : 'h-10 gap-2',
        offChat ? 'border-accent-copper/40' : 'border-border',
        // Reserve room on macOS for native traffic-light buttons in
        // titleBarStyle: overlay configurations. Compact mode uses a
        // tighter pl since the traffic-lights themselves shrink with
        // the title-bar height in WebView2 builds.
        isMac ? (compactChrome ? 'pl-[64px]' : 'pl-[72px]') : 'pl-2',
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
            className={cn(compactChrome && 'h-5 w-5 [&_svg]:size-3')}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        </Hint>
      </div>

      {/* Breadcrumb */}
      <div className="no-drag flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setVoiceModalOpen(true)}
          aria-label="Open Jarvis voice panel"
          className="jarvis-breadcrumb-trigger relative rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/60"
        >
          {/* Always-on Jarvis halo — soft purple→cyan pulse so the activation
              point reads as "alive". Intensifies into a ping while listening. */}
          <span aria-hidden className="jarvis-j-glow pointer-events-none absolute -inset-1 rounded-full" />
          {voiceListening && (
            <span
              className="absolute inset-0 rounded-full animate-ping"
              style={{
                background: 'radial-gradient(circle at 38% 34%, #fff7cb 0%, #ffd45a 18%, #ff980f 48%, #cf6205 72%, #5b2300 100%)',
                opacity: 0.4,
              }}
            />
          )}
          <span
            className={cn(
              'jarvis-bot-mark shrink-0 relative z-[1] grid place-items-center rounded-full',
              compactChrome ? 'h-4 w-4' : 'h-5 w-5',
              voiceListening && 'animate-pulse',
            )}
          >
            <Bot
              className={compactChrome ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'}
              strokeWidth={2.4}
              aria-hidden
            />
          </span>
        </button>
        <span
          className={cn(
            'truncate font-medium',
            compactChrome ? 'text-metadata' : 'text-secondary',
            workspaceId ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {workspaceLabel}
        </span>
        {projectLabel && (
          <>
            <span className="px-0.5 text-secondary text-muted-foreground/60 select-none">/</span>
            <span
              className={cn(
                'truncate text-muted-foreground',
                compactChrome ? 'text-metadata' : 'text-secondary',
              )}
            >
              {projectLabel}
            </span>
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
                    'truncate rounded px-1 text-accent-copper transition-colors',
                    compactChrome ? 'text-metadata' : 'text-secondary',
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

      {/* Right cluster.
          Two layouts on the same data:
            - Normal: every action gets its own button.
            - Compact: only Fullscreen + ⋯ overflow + Settings + Avatar
              are visible inline; everything else moves into the popover so
              the user keeps the maximum amount of vertical room for the
              workspace canvas (terminals especially). */}
      {compactChrome ? (
        <CompactRightCluster
          overflowOpen={overflowOpen}
          setOverflowOpen={setOverflowOpen}
          chatFullscreen={chatFullscreen}
          toggleChatFullscreen={toggleChatFullscreen}
          voiceListening={voiceListening}
          setLauncherOpen={setLauncherOpen}
          setAssistantOpen={setAssistantOpen}
          openSchedule={() => setRoute('schedule')}
          setPaletteOpen={setPaletteOpen}
          toggleVoice={toggleVoice}
          setSettingsOpen={setSettingsOpen}
          setWhatsNewOpen={setWhatsNewOpen}
          hasUnseenWhatsNew={hasUnseenWhatsNew}
          currentVersion={currentVersion}
          displayName={displayName}
          workspaceId={workspaceId}
          setRoute={setRoute}
        />
      ) : (
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

          <Hint label="Schedule" hotkey={HOTKEYS.SCHEDULE}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setRoute('schedule')}
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

          <Hint label="What's new">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setWhatsNewOpen(true)}
              aria-label={
                hasUnseenWhatsNew
                  ? `What's new in v${currentVersion} (unread)`
                  : `What's new in v${currentVersion}`
              }
              className="relative"
            >
              <Megaphone className="h-4 w-4" />
              {hasUnseenWhatsNew && (
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full',
                    'bg-accent-copper ring-2 ring-panel',
                  )}
                />
              )}
            </Button>
          </Hint>

          <Hint label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} hotkey="Mod+I">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleInspector}
              aria-label="Toggle inspector"
              aria-pressed={inspectorOpen}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          </Hint>

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

          <button
            type="button"
            onClick={() => setRoute('account')}
            className="pl-1 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/60"
            aria-label={displayName ? `Open account for ${displayName}` : 'Open account'}
          >
            <Avatar
              seed={displayName || workspaceId || 'jarvis'}
              initials={(displayName || 'J').charAt(0)}
              size={24}
            />
          </button>
        </div>
      )}
    </header>
  );
}

/**
 * Compact right-cluster for the terminal route + chat-fullscreen mode.
 *
 * Renders inline: Fullscreen toggle, ⋯ overflow popover, Settings, small
 * avatar. Everything else (Quick launcher, Assistant, Schedule, Search,
 * Voice, Call, What's new) moves into the popover so the user keeps the
 * maximum amount of vertical room for terminals.
 *
 * The popover contains a `<MenuRow>` per action with the same hotkey
 * tooltip and active-state cues as the full top bar.
 */
interface CompactRightClusterProps {
  overflowOpen: boolean;
  setOverflowOpen: (v: boolean) => void;
  chatFullscreen: boolean;
  toggleChatFullscreen: () => void;
  voiceListening: boolean;
  setLauncherOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
  openSchedule: () => void;
  setPaletteOpen: (v: boolean) => void;
  toggleVoice: () => void;
  setSettingsOpen: (v: boolean) => void;
  setWhatsNewOpen: (v: boolean) => void;
  hasUnseenWhatsNew: boolean;
  currentVersion: string;
  displayName: string | null;
  workspaceId: string | null;
  setRoute: (r: Route) => void;
}

function CompactRightCluster(props: CompactRightClusterProps) {
  const inspectorOpen = useUIStore((s) => s.inspectorOpen);
  const toggleInspector = useUIStore((s) => s.toggleInspector);
  const {
    overflowOpen,
    setOverflowOpen,
    chatFullscreen,
    toggleChatFullscreen,
    voiceListening,
    setLauncherOpen,
    setAssistantOpen,
    openSchedule,
    setPaletteOpen,
    toggleVoice,
    setSettingsOpen,
    setWhatsNewOpen,
    hasUnseenWhatsNew,
    currentVersion,
    displayName,
    workspaceId,
    setRoute,
  } = props;

  // Each menu click should also dismiss the popover so the user lands
  // on the action they wanted with no extra step. We curry that here.
  const closeAfter = (fn: () => void) => () => {
    fn();
    setOverflowOpen(false);
  };

  return (
    <div className="no-drag flex items-center gap-0.5">
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
          className="h-5 w-5 [&_svg]:size-3"
        >
          {chatFullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
        </Button>
      </Hint>

      <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            className="relative h-5 w-5 [&_svg]:size-3"
          >
            <MoreHorizontal className="h-3 w-3" />
            {hasUnseenWhatsNew && (
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute right-0.5 top-0.5 h-1 w-1 rounded-full',
                  'bg-accent-copper ring-1 ring-panel',
                )}
              />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-52 p-1">
          <ul role="menu" className="flex flex-col gap-0.5">
            <MenuRow
              icon={<Rocket className="h-3.5 w-3.5" />}
              label="Quick launcher"
              hotkey={HOTKEYS.LAUNCHER}
              onClick={closeAfter(() => setLauncherOpen(true))}
            />
            <MenuRow
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="Assistant"
              hotkey={HOTKEYS.ASSISTANT}
              onClick={closeAfter(() => setAssistantOpen(true))}
            />
            <MenuRow
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              label="Schedule"
              hotkey={HOTKEYS.SCHEDULE}
              onClick={closeAfter(openSchedule)}
            />
            <MenuRow
              icon={<Search className="h-3.5 w-3.5" />}
              label="Search"
              hotkey="Mod+K"
              onClick={closeAfter(() => setPaletteOpen(true))}
            />
            <MenuRow
              icon={
                <Mic
                  className={cn(
                    'h-3.5 w-3.5',
                    voiceListening && 'text-accent-cyan',
                  )}
                />
              }
              label={voiceListening ? 'Voice (listening)' : 'Voice'}
              hotkey="Mod+Space"
              onClick={closeAfter(toggleVoice)}
            />
            <CompactCallRow closeAfter={closeAfter} />
            <MenuRow
              icon={<Megaphone className="h-3.5 w-3.5" />}
              label={`What's new${hasUnseenWhatsNew ? ' (new)' : ''}`}
              onClick={closeAfter(() => setWhatsNewOpen(true))}
              accent={hasUnseenWhatsNew}
              suffix={hasUnseenWhatsNew ? `v${currentVersion}` : undefined}
            />
          </ul>
        </PopoverContent>
      </Popover>

      <Hint label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} hotkey="Mod+I">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleInspector}
          aria-label="Toggle inspector"
          aria-pressed={inspectorOpen}
          className="h-5 w-5 [&_svg]:size-3"
        >
          <PanelRight className="h-3 w-3" />
        </Button>
      </Hint>

      <Hint label="Settings" hotkey="Mod+,">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="h-5 w-5 [&_svg]:size-3"
        >
          <Settings className="h-3 w-3" />
        </Button>
      </Hint>

      <button
        type="button"
        onClick={() => setRoute('account')}
        className="pl-1 rounded-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-copper/60"
        aria-label={displayName ? `Open account for ${displayName}` : 'Open account'}
      >
        <Avatar
          seed={displayName || workspaceId || 'jarvis'}
          initials={(displayName || 'J').charAt(0)}
          size={18}
        />
      </button>
    </div>
  );
}

interface MenuRowProps {
  icon: React.ReactNode;
  label: string;
  hotkey?: string;
  onClick: () => void;
  accent?: boolean;
  suffix?: string;
}

function MenuRow({ icon, label, hotkey, onClick, accent, suffix }: MenuRowProps) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-secondary transition-colors',
          'hover:bg-muted hover:text-foreground',
          accent ? 'text-accent-copper' : 'text-foreground/90',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {suffix && (
          <span className="shrink-0 text-metadata text-muted-foreground/80">
            {suffix}
          </span>
        )}
        {hotkey && !suffix && (
          <kbd
            aria-hidden
            className="shrink-0 rounded border border-border bg-background/50 px-1 text-metadata text-muted-foreground"
          >
            {formatHotkey(hotkey)}
          </kbd>
        )}
      </button>
    </li>
  );
}

/** Render a hotkey string with the platform-correct meta key. */
function formatHotkey(hotkey: string): string {
  return hotkey.replaceAll('Mod', isMac ? '⌘' : 'Ctrl');
}

/**
 * Call action row for the compact overflow. Reads call state so the
 * label and click handler match the inline `<CallTopBarButton>` exactly.
 *
 * Bundle policy: this row is rendered eagerly inside the TopBar overflow
 * popover. Reading the call status from `useCallStore` is cheap (Zustand,
 * already on the boot graph), and `isCallConfigured()` is an env-only
 * helper from `@/features/call/config` — neither pulls LiveKit. The
 * actual `service.stop()` call goes through `loadCallService()` so the
 * ~500KB LiveKit SDK only loads when the user is actually in a call.
 */
function CompactCallRow({ closeAfter }: { closeAfter: (fn: () => void) => () => void }) {
  const status = useCallStore((state) => state.status);
  const setCallModalOpen = useUIStore((state) => state.setCallModalOpen);
  const plan = useAuthStore((state) => state.plan);
  const email = useAuthStore((state) => state.email);
  const cloudEmail = useAuthStore((state) => state.cloudSession?.email);
  const localUserId = useAuthStore((state) => state.localUserId);
  const inCall = status !== 'idle';
  const configured = isCallConfigured();
  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const entitled = planAllowsJarvisCall(plan, admin);

  const onActivate = closeAfter(() => {
    if (inCall) {
      // LiveKit chunk is already loaded by the time inCall is true (the
      // CallModal had to load it to start the call). `loadCallService` is
      // cheap on subsequent calls — it returns the same singleton.
      void loadCallService().then((service) => service.stop());
      return;
    }
    if (!configured) {
      toast.info(
        'Phone & Voice not set up',
        'Open Settings → Phone & Voice and point Jarvis at your phone-jarvis cloud.',
      );
      return;
    }
    if (!entitled) {
      toast.warning('Jarvis Call requires a plan', 'Upgrade to a voice-enabled plan or use an admin-enabled build.');
      return;
    }
    setCallModalOpen(true);
  });

  const Icon = inCall ? PhoneOff : Phone;
  return (
    <MenuRow
      icon={
        <Icon
          className={cn(
            'h-3.5 w-3.5',
            inCall && 'text-rose-500',
            !inCall && configured && entitled && 'text-emerald-500',
            (!configured || !entitled) && !inCall && 'text-muted-foreground/60',
          )}
        />
      }
      label={inCall ? 'Hang up' : 'Call Jarvis'}
      onClick={onActivate}
    />
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
 *
 * Bundle policy: same as `CompactCallRow` above — env-only `isCallConfigured`
 * for the button colour, and `loadCallService` only when actually hanging up.
 */
function CallTopBarButton() {
  const status = useCallStore((state) => state.status);
  const setCallModalOpen = useUIStore((state) => state.setCallModalOpen);
  const plan = useAuthStore((state) => state.plan);
  const email = useAuthStore((state) => state.email);
  const cloudEmail = useAuthStore((state) => state.cloudSession?.email);
  const localUserId = useAuthStore((state) => state.localUserId);

  const inCall = status !== 'idle';
  const configured = isCallConfigured();
  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const entitled = planAllowsJarvisCall(plan, admin);

  const handleClick = () => {
    if (inCall) {
      // The CallModal already pulled livekit-client onto the page when the
      // user dialled in; `loadCallService()` is essentially free here.
      void loadCallService().then((service) => service.stop());
      return;
    }
    if (!configured) {
      toast.info(
        'Phone & Voice not set up',
        'Open Settings → Phone & Voice and point Jarvis at your phone-jarvis cloud.',
      );
      return;
    }
    if (!entitled) {
      toast.warning('Jarvis Call requires a plan', 'Upgrade to a voice-enabled plan or use an admin-enabled build.');
      return;
    }
    setCallModalOpen(true);
  };

  return (
    <Hint label={inCall ? 'Hang up' : !configured ? 'Phone & Voice not configured' : entitled ? 'Call Jarvis' : 'Jarvis Call requires a voice plan'}>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleClick}
        aria-label={inCall ? 'Hang up' : 'Call Jarvis'}
        className={cn(
          inCall && 'text-rose-500 hover:text-rose-400',
          !inCall && configured && entitled && 'text-emerald-500 hover:text-emerald-400',
          (!configured || !entitled) && !inCall && 'text-muted-foreground/50',
        )}
      >
        {inCall ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </Button>
    </Hint>
  );
}
