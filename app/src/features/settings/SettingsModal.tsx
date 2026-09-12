import {
  lazy,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  KeyRound,
  Palette,
  Mic,
  Phone,
  Keyboard,
  AudioLines,
  Brain,
  Info,
  Moon,
  Bell,
  Sparkles,
  Network,
  HardDriveDownload,
  Accessibility as AccessibilityIcon,
  Blocks,
  Cable,
  Shield,
  Zap,
  Settings2,
  MonitorCog,
  type LucideIcon,
} from 'lucide-react';
import { useAppAdmin } from '@/lib/admin';
import { isHiveProductEnabled } from '@/lib/features/hiveProductGate';
import { useUIStore } from '@/stores/ui';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { HiveModelTabIcon } from '@/components/brand';
import {
  DEFAULT_SETTINGS_TAB,
  isLegacySettingsAccountTab,
  prefetchSettingsTab,
  resolveSettingsTab,
  type SettingsTab,
} from './settingsPrefetch';
import { rememberSettingsTab } from './settingsTabMemory';
import './sakura-settings.css';

const General = lazy(() => import('./sections/General').then((m) => ({ default: m.General })));
const Providers = lazy(() =>
  import('./sections/Providers').then((m) => ({ default: m.Providers })),
);
const SubscriptionCliBridge = lazy(() =>
  import('./sections/SubscriptionCliBridge').then((m) => ({ default: m.SubscriptionCliBridge })),
);
const LocalModels = lazy(() =>
  import('./sections/LocalModels').then((m) => ({ default: m.LocalModels })),
);
const BrowserAgentSettings = lazy(() =>
  import('./sections/BrowserAgentSettings').then((m) => ({ default: m.BrowserAgentSettings })),
);
const Plans = lazy(() => import('./sections/Plans').then((m) => ({ default: m.Plans })));
/** Retained for recovery when VITE_HIVE_ENABLED is set; not loaded while gated. */
const Hive = lazy(() => import('./sections/Hive').then((m) => ({ default: m.Hive })));
const AllAboutMe = lazy(() =>
  import('./sections/AllAboutMe').then((m) => ({ default: m.AllAboutMe })),
);
const Appearance = lazy(() =>
  import('./sections/Appearance').then((m) => ({ default: m.Appearance })),
);
const Voice = lazy(() => import('./sections/Voice').then((m) => ({ default: m.Voice })));
const PhoneVoice = lazy(() =>
  import('./sections/PhoneVoice').then((m) => ({ default: m.PhoneVoice })),
);
const ComposerStt = lazy(() =>
  import('./sections/ComposerStt').then((m) => ({ default: m.ComposerStt })),
);
const Hotkeys = lazy(() => import('./sections/Hotkeys').then((m) => ({ default: m.Hotkeys })));
const About = lazy(() => import('./sections/About').then((m) => ({ default: m.About })));
const Ambient = lazy(() => import('./sections/Ambient').then((m) => ({ default: m.Ambient })));
const Accessibility = lazy(() =>
  import('./sections/Accessibility').then((m) => ({ default: m.Accessibility })),
);
const Notifications = lazy(() =>
  import('./sections/Notifications').then((m) => ({ default: m.Notifications })),
);
const Telemetry = lazy(() =>
  import('./sections/Telemetry').then((m) => ({ default: m.Telemetry })),
);
const Plugins = lazy(() =>
  import('@/features/plugins/Plugins').then((m) => ({ default: m.Plugins })),
);
const Admin = lazy(() => import('./sections/Admin').then((m) => ({ default: m.Admin })));
const JarvisActions = lazy(() =>
  import('./sections/JarvisActions').then((m) => ({ default: m.JarvisActions })),
);

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
  /** Official brand mark instead of Lucide (e.g. Hive model). */
  brandIcon?: React.ComponentType<{ className?: string }>;
}

const TABS_ALL: TabDef[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'plans', label: 'Plans', icon: Sparkles },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'connections', label: 'AI Connectors', icon: Cable },
  { id: 'hive', label: 'Hive', icon: Network, brandIcon: HiveModelTabIcon },
  { id: 'allaboutme', label: 'All About Me', icon: Brain },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
  { id: 'localmodels', label: 'Local Models', icon: HardDriveDownload },
  { id: 'browseragent', label: 'Browser Agent', icon: MonitorCog },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'composerstt', label: 'Speech to Text', icon: AudioLines },
  { id: 'phone', label: 'Phone & Voice', icon: Phone },
  { id: 'ambient', label: 'Ambient', icon: Moon },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'telemetry', label: 'Telemetry', icon: Shield },
  { id: 'accessibility', label: 'Accessibility', icon: AccessibilityIcon },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'jarvisactions', label: 'Jarvis Actions', icon: Zap },
  { id: 'about', label: 'About', icon: Info },
];

/** Product-visible settings tabs (Hive hidden while product gate is off). */
function productSettingsTabs(): TabDef[] {
  if (isHiveProductEnabled()) return TABS_ALL;
  return TABS_ALL.filter((tab) => tab.id !== 'hive');
}

interface SettingsModalProps {
  /** Optional initial tab. Defaults to Plans (settings root). */
  initialTab?: SettingsTab | 'account';
  /**
   * Exposes the real non-authoritative Admin presentation for the contained
   * visual profile. This does not change the entitlement snapshot consumed by
   * the Admin section and must stay false in ordinary runtime.
   */
  visualAdminPreview?: boolean;
}

function CachedTabPanel({
  id,
  active,
  visited,
  children,
}: {
  id: SettingsTab;
  active: boolean;
  visited: boolean;
  children: ReactNode;
}) {
  if (!visited) return null;
  return (
    <div
      id={`settings-panel-${id}`}
      role="tabpanel"
      aria-labelledby={`settings-tab-${id}`}
      hidden={!active}
      className={cn(!active && 'hidden')}
    >
      {children}
    </div>
  );
}

function SettingsTabPanels({
  tab,
  visited,
  hiveEnabled,
}: {
  tab: SettingsTab;
  visited: ReadonlySet<SettingsTab>;
  hiveEnabled: boolean;
}) {
  return (
    <Suspense fallback={null}>
      <CachedTabPanel id="general" active={tab === 'general'} visited={visited.has('general')}>
        <General />
      </CachedTabPanel>
      <CachedTabPanel id="plans" active={tab === 'plans'} visited={visited.has('plans')}>
        <Plans />
      </CachedTabPanel>
      <CachedTabPanel
        id="providers"
        active={tab === 'providers'}
        visited={visited.has('providers')}
      >
        <Providers />
      </CachedTabPanel>
      <CachedTabPanel
        id="connections"
        active={tab === 'connections'}
        visited={visited.has('connections')}
      >
        <SubscriptionCliBridge />
      </CachedTabPanel>
      {hiveEnabled ? (
        <CachedTabPanel id="hive" active={tab === 'hive'} visited={visited.has('hive')}>
          <Hive />
        </CachedTabPanel>
      ) : null}
      <CachedTabPanel
        id="allaboutme"
        active={tab === 'allaboutme'}
        visited={visited.has('allaboutme')}
      >
        <AllAboutMe />
      </CachedTabPanel>
      <CachedTabPanel id="plugins" active={tab === 'plugins'} visited={visited.has('plugins')}>
        <Plugins />
      </CachedTabPanel>
      <CachedTabPanel
        id="localmodels"
        active={tab === 'localmodels'}
        visited={visited.has('localmodels')}
      >
        <LocalModels active={tab === 'localmodels'} />
      </CachedTabPanel>
      <CachedTabPanel
        id="browseragent"
        active={tab === 'browseragent'}
        visited={visited.has('browseragent')}
      >
        <BrowserAgentSettings />
      </CachedTabPanel>
      <CachedTabPanel
        id="appearance"
        active={tab === 'appearance'}
        visited={visited.has('appearance')}
      >
        <Appearance />
      </CachedTabPanel>
      <CachedTabPanel id="voice" active={tab === 'voice'} visited={visited.has('voice')}>
        <Voice active={tab === 'voice'} />
      </CachedTabPanel>
      <CachedTabPanel
        id="composerstt"
        active={tab === 'composerstt'}
        visited={visited.has('composerstt')}
      >
        <ComposerStt />
      </CachedTabPanel>
      <CachedTabPanel id="phone" active={tab === 'phone'} visited={visited.has('phone')}>
        <PhoneVoice />
      </CachedTabPanel>
      <CachedTabPanel id="ambient" active={tab === 'ambient'} visited={visited.has('ambient')}>
        <Ambient />
      </CachedTabPanel>
      <CachedTabPanel
        id="notifications"
        active={tab === 'notifications'}
        visited={visited.has('notifications')}
      >
        <Notifications />
      </CachedTabPanel>
      <CachedTabPanel
        id="telemetry"
        active={tab === 'telemetry'}
        visited={visited.has('telemetry')}
      >
        <Telemetry />
      </CachedTabPanel>
      <CachedTabPanel
        id="accessibility"
        active={tab === 'accessibility'}
        visited={visited.has('accessibility')}
      >
        <Accessibility />
      </CachedTabPanel>
      <CachedTabPanel id="hotkeys" active={tab === 'hotkeys'} visited={visited.has('hotkeys')}>
        <Hotkeys />
      </CachedTabPanel>
      <CachedTabPanel
        id="jarvisactions"
        active={tab === 'jarvisactions'}
        visited={visited.has('jarvisactions')}
      >
        <JarvisActions />
      </CachedTabPanel>
      <CachedTabPanel id="admin" active={tab === 'admin'} visited={visited.has('admin')}>
        <Admin />
      </CachedTabPanel>
      <CachedTabPanel id="about" active={tab === 'about'} visited={visited.has('about')}>
        <About />
      </CachedTabPanel>
    </Suspense>
  );
}

/**
 * Root settings modal. Left-rail navigation, content area on the right.
 *
 * Reads `settingsOpen` from the UI store so any caller (Cmd+, hotkey, profile
 * menu, link from elsewhere) can pop the modal by toggling that flag.
 *
 * Cross-section navigation: any code that wants to jump tabs while the
 * modal is already open dispatches a `jarvis:settings:tab` CustomEvent
 * with `{ detail: { tab } }`. The Plans tab uses this to send the user
 * to Providers when they click "Add a key".
 */
export function SettingsModal({
  initialTab = DEFAULT_SETTINGS_TAB,
  visualAdminPreview = false,
}: SettingsModalProps) {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const setRoute = useUIStore((s) => s.setRoute);
  const isAdmin = useAppAdmin();
  const adminTabVisible = isAdmin || visualAdminPreview;
  const hiveEnabled = isHiveProductEnabled();
  const resolvedInitial = resolveSettingsTab(initialTab);
  const [tab, setTab] = useState<SettingsTab>(resolvedInitial);
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<SettingsTab>>(
    () => new Set<SettingsTab>([resolvedInitial]),
  );
  const tabs = useMemo(() => {
    const base = productSettingsTabs();
    return adminTabVisible
      ? [
          ...base.slice(0, 1),
          { id: 'admin' as const, label: 'Admin', icon: Shield },
          ...base.slice(1),
        ]
      : base;
  }, [adminTabVisible, hiveEnabled]);

  const selectTab = (next: SettingsTab) => {
    rememberSettingsTab(next);
    prefetchSettingsTab(next);
    startTransition(() => {
      setTab(next);
      setVisitedTabs((prev) => {
        if (prev.has(next)) return prev;
        const copy = new Set(prev);
        copy.add(next);
        return copy;
      });
    });
  };

  useEffect(() => {
    if (!adminTabVisible && tab === 'admin') setTab(DEFAULT_SETTINGS_TAB);
  }, [adminTabVisible, tab]);

  useEffect(() => {
    if (!open) return;
    prefetchSettingsTab(tab);
  }, [open, tab]);

  useEffect(() => {
    if (!open) return;
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      const requested = detail?.tab;
      if (!requested) return;
      // Retired Settings → Account: send users to the Account Center.
      if (isLegacySettingsAccountTab(requested)) {
        setOpen(false);
        setRoute('account');
        return;
      }
      selectTab(resolveSettingsTab(requested));
    };
    window.addEventListener('jarvis:settings:tab', onJump);
    return () => window.removeEventListener('jarvis:settings:tab', onJump);
  }, [open, setOpen, setRoute]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(`settings-tab-${tab}`)?.focus();
        }}
        overlayProps={{
          'data-monochrome-overlay': 'settings-modal',
          'data-sakura-overlay': 'settings-modal',
          className:
            '[html[data-theme=monochrome]_&]:backdrop-blur-none [html[data-theme=monochrome]_&]:data-[state=open]:!animate-none [html[data-theme=monochrome]_&]:data-[state=closed]:!animate-none',
        }}
        className="mc7f-settings-modal w-[min(1180px,94vw)] max-w-6xl h-[min(760px,90vh)] p-0 flex flex-col overflow-hidden motion-reduce:!left-0 motion-reduce:!right-0 motion-reduce:!top-[round(nearest,calc(50vh-min(380px,45vh)),1px)] motion-reduce:!bottom-auto motion-reduce:!mx-auto motion-reduce:!my-0 motion-reduce:!transform-none [html[data-theme=monochrome]_&]:rounded-none [html[data-theme=monochrome]_&]:border-foreground/40 [html[data-theme=monochrome]_&]:shadow-none [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:shadow-none"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure providers, appearance, voice, hotkeys, plans, and telemetry. Profile and billing
          live in Account Center.
        </DialogDescription>

        <div
          className="flex-1 min-h-0 grid grid-cols-[220px_1fr] grid-rows-[1fr]"
          data-sakura-surface="settings-layout"
          data-warm-surface="settings-canvas"
        >
          <div
            aria-hidden="true"
            className="hidden [html[data-theme=warm]_&]:block"
            data-warm-decoration="settings-scene"
          >
            <img
              src="/assets/themes/warm/settings/settings-landscape-v4-selected.webp"
              alt=""
              decoding="async"
              draggable={false}
            />
          </div>
          <div
            aria-hidden="true"
            className="hidden [html[data-theme=warm]_&]:block"
            data-warm-decoration="settings-wash"
          />
          <aside
            className="border-r border-border bg-panel flex flex-col min-h-0"
            data-sakura-surface="settings-navigation"
          >
            <div className="flex h-[54px] shrink-0 items-center px-4 py-0">
              <span className="text-ui-strong text-foreground">Settings</span>
            </div>
            <nav
              className="flex-1 px-2 pb-2 flex flex-col gap-0.5 overflow-y-auto min-h-0"
              aria-label="Settings sections"
            >
              {tabs.map((t) => {
                const Icon = t.icon;
                const BrandIcon = t.brandIcon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    id={`settings-tab-${t.id}`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`settings-panel-${t.id}`}
                    onClick={() => selectTab(t.id)}
                    onMouseEnter={() => prefetchSettingsTab(t.id)}
                    onFocus={() => prefetchSettingsTab(t.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 py-0 text-secondary text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      active
                        ? 'bg-elevated text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                  >
                    {BrandIcon ? (
                      <BrandIcon
                        className={cn('h-6 w-6 shrink-0', active ? 'opacity-100' : 'opacity-70')}
                      />
                    ) : (
                      <Icon
                        className={cn(
                          'h-4 w-4 shrink-0',
                          active ? 'text-accent-cyan' : 'text-muted-foreground',
                        )}
                      />
                    )}
                    <span className="h-4 flex-1 truncate leading-4">{t.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main
            className="overflow-y-auto px-6 py-6 min-h-0"
            role="tablist"
            data-sakura-surface="settings-content"
            data-warm-settings-tab={tab}
          >
            <SettingsTabPanels tab={tab} visited={visitedTabs} hiveEnabled={hiveEnabled} />
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
