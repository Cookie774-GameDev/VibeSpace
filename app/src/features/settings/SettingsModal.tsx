import { useEffect, useState } from 'react';
import {
  User2,
  KeyRound,
  Palette,
  Mic,
  Phone,
  Keyboard,
  Info,
  Moon,
  Bell,
  Sparkles,
  HardDriveDownload,
  Accessibility as AccessibilityIcon,
  Blocks,
  type LucideIcon,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { Account } from './sections/Account';
import { Providers } from './sections/Providers';
import { LocalModels } from './sections/LocalModels';
import { Plans } from './sections/Plans';
import { Appearance } from './sections/Appearance';
import { Voice } from './sections/Voice';
import { PhoneVoice } from './sections/PhoneVoice';
import { Hotkeys } from './sections/Hotkeys';
import { About } from './sections/About';
import { Ambient } from './sections/Ambient';
import { Accessibility } from './sections/Accessibility';
import { Notifications } from './sections/Notifications';
import { Plugins } from '@/features/plugins';

type SettingsTab =
  | 'account'
  | 'plans'
  | 'providers'
  | 'plugins'
  | 'localmodels'
  | 'appearance'
  | 'voice'
  | 'phone'
  | 'ambient'
  | 'notifications'
  | 'accessibility'
  | 'hotkeys'
  | 'about';

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
}

const TABS: TabDef[] = [
  { id: 'account', label: 'Account', icon: User2 },
  { id: 'plans', label: 'Plans', icon: Sparkles },
  { id: 'providers', label: 'Providers', icon: KeyRound },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
  { id: 'localmodels', label: 'Local Models', icon: HardDriveDownload },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'phone', label: 'Phone & Voice', icon: Phone },
  { id: 'ambient', label: 'Ambient', icon: Moon },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'accessibility', label: 'Accessibility', icon: AccessibilityIcon },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info },
];

interface SettingsModalProps {
  /** Optional initial tab. Defaults to 'account' on each open. */
  initialTab?: SettingsTab;
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
export function SettingsModal({ initialTab = 'account' }: SettingsModalProps) {
  const open = useUIStore((s) => s.settingsOpen);
  const setOpen = useUIStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (!open) return;
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: SettingsTab }>).detail;
      if (detail?.tab) setTab(detail.tab);
    };
    window.addEventListener('jarvis:settings:tab', onJump);
    return () => window.removeEventListener('jarvis:settings:tab', onJump);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          // Reset to the requested initial tab so the next open lands there.
          setTab(initialTab);
        }
      }}
    >
      <DialogContent className="max-w-6xl w-[min(1180px,94vw)] h-[min(760px,90vh)] p-0 flex flex-col overflow-hidden">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure your account, providers, appearance, voice, hotkeys, and telemetry.
        </DialogDescription>

        <div className="flex-1 min-h-0 grid grid-cols-[220px_1fr] grid-rows-[1fr]">
          <aside className="border-r border-border bg-panel flex flex-col min-h-0">
            <div className="px-4 py-4 shrink-0">
              <span className="text-ui-strong text-foreground">Settings</span>
            </div>
            <nav
              className="flex-1 px-2 pb-2 flex flex-col gap-0.5 overflow-y-auto min-h-0"
              aria-label="Settings sections"
            >
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTab(t.id)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-secondary text-left transition-colors',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      active
                        ? 'bg-elevated text-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                  >
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        active ? 'text-accent-cyan' : 'text-muted-foreground',
                      )}
                    />
                    <span className="flex-1 truncate">{t.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="overflow-y-auto px-6 py-6 min-h-0">
            {tab === 'account' && <Account />}
            {tab === 'plans' && <Plans />}
            {tab === 'providers' && <Providers />}
            {tab === 'plugins' && <Plugins />}
            {tab === 'localmodels' && <LocalModels />}
            {tab === 'appearance' && <Appearance />}
            {tab === 'voice' && <Voice />}
            {tab === 'phone' && <PhoneVoice />}
            {tab === 'ambient' && <Ambient />}
            {tab === 'notifications' && <Notifications />}
            {tab === 'accessibility' && <Accessibility />}
            {tab === 'hotkeys' && <Hotkeys />}
            {tab === 'about' && <About />}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
