import { Bird, Cpu, Flower2, Moon, Sparkles, Sunrise, Terminal } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useFullscreenStore, type SystemFullscreenBehavior } from '@/features/fullscreen';
import { cn } from '@/lib/utils';
import { SELECTABLE_THEMES, type SelectableTheme } from '@/features/appearance/themes';
import type { SakuraPetalSpeed } from '@/stores/ui';

const THEME_ICONS: Record<SelectableTheme, typeof Terminal> = {
  jarvis: Cpu,
  vibespace: Sparkles,
  default: Moon,
  monochrome: Terminal,
  sakura: Flower2,
  warm: Sunrise,
  origami: Bird,
};

const DENSITIES: { id: 'compact' | 'cozy'; label: string; description: string }[] = [
  { id: 'compact', label: 'Compact', description: '13px text, 28px rows. Maximum density.' },
  { id: 'cozy', label: 'Cozy', description: 'A touch more breathing room.' },
];

const SAKURA_PETAL_SPEEDS: ReadonlyArray<{ id: SakuraPetalSpeed; label: string }> = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

export function Appearance() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const density = useUIStore((s) => s.density);
  const appBrightness = useUIStore((s) => s.appBrightness);
  const setAppBrightness = useUIStore((s) => s.setAppBrightness);
  const sakuraPetalsEnabled = useUIStore((s) => s.sakuraPetalsEnabled);
  const sakuraPetalSpeed = useUIStore((s) => s.sakuraPetalSpeed);
  const setSakuraPetalsEnabled = useUIStore((s) => s.setSakuraPetalsEnabled);
  const setSakuraPetalSpeed = useUIStore((s) => s.setSakuraPetalSpeed);
  const defaultTerminalFontSize = useUIStore((s) => s.defaultTerminalFontSize);
  const setDefaultTerminalFontSize = useUIStore((s) => s.setDefaultTerminalFontSize);
  const systemFullscreenActive = useFullscreenStore((s) => s.systemActive);
  const nativeAvailability = useFullscreenStore((s) => s.nativeAvailability);
  const nativePending = useFullscreenStore((s) => s.nativePending);
  const fullscreenError = useFullscreenStore((s) => s.error);
  const fullscreenPreferences = useFullscreenStore((s) => s.preferences);
  const requestSystemFullscreen = useFullscreenStore((s) => s.requestSystemActive);
  const setFullscreenPreferences = useFullscreenStore((s) => s.setPreferences);

  function setDensity(d: 'compact' | 'cozy') {
    // density has no dedicated action in the store yet; setState is the safe
    // imperative escape hatch zustand always provides.
    useUIStore.setState({ density: d });
  }

  return (
    <div className="mc7f-settings-appearance flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none">
      <header>
        <h2 className="text-page-title text-foreground">Appearance</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          Pick the app skin without replacing the existing themes.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <Label>Theme</Label>
        <div className="grid grid-cols-2 gap-2 max-w-md" role="radiogroup" aria-label="App theme">
          {SELECTABLE_THEMES.map((t) => {
            const Icon = THEME_ICONS[t.id];
            const selected = theme === t.id;
            return (
              <button
                type="button"
                key={t.id}
                onClick={() => setTheme(t.id)}
                aria-pressed={selected}
                role="radio"
                aria-checked={selected}
                data-monochrome-control-size="preserve"
                className={cn(
                  'flex min-h-[104px] flex-col items-center justify-center gap-2 rounded-md border bg-panel px-3 py-4 transition-colors',
                  'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  selected
                    ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.3)]'
                    : 'border-border',
                )}
              >
                <Icon
                  className={cn('h-5 w-5', selected ? 'text-accent-cyan' : 'text-muted-foreground')}
                />
                <span
                  className={cn(
                    'text-ui-strong',
                    selected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {t.label}
                </span>
                <span className="text-metadata text-muted-foreground text-center px-2">
                  {t.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {theme === 'sakura' && (
        <>
          <Separator />
          <section
            aria-labelledby="sakura-visual-effects"
            className="sakura-appearance-effects flex max-w-md flex-col gap-4 rounded-lg border border-border bg-panel p-4"
          >
            <div>
              <h3 id="sakura-visual-effects" className="text-ui-strong text-foreground">
                Sakura visual effects
              </h3>
              <p className="text-metadata text-muted-foreground mt-1">
                Local presentation controls. Reduced motion hides petals automatically.
              </p>
            </div>
            <SettingSwitch
              id="sakura-falling-petals"
              label="Falling petals"
              description="Let petals drift behind the workspace."
              checked={sakuraPetalsEnabled}
              onCheckedChange={setSakuraPetalsEnabled}
            />
            <div className="flex flex-col gap-2">
              <Label>Petal speed</Label>
              <div aria-label="Petal speed" className="grid grid-cols-3 gap-2" role="radiogroup">
                {SAKURA_PETAL_SPEEDS.map((speed) => {
                  const selected = sakuraPetalSpeed === speed.id;
                  return (
                    <button
                      key={speed.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setSakuraPetalSpeed(speed.id)}
                      className={cn(
                        'rounded-md border px-3 py-2 text-ui-strong transition-colors',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        selected
                          ? 'border-accent-cyan/60 bg-elevated text-foreground'
                          : 'border-border bg-panel text-muted-foreground hover:bg-elevated',
                      )}
                    >
                      {speed.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>
        </>
      )}

      <Separator />

      <section className="flex flex-col gap-3">
        <Label>Density</Label>
        <div className="grid grid-cols-2 gap-2 max-w-md">
          {DENSITIES.map((d) => {
            const selected = density === d.id;
            return (
              <button
                type="button"
                key={d.id}
                onClick={() => setDensity(d.id)}
                aria-pressed={selected}
                data-monochrome-control-size="preserve"
                className={cn(
                  'flex min-h-[64px] flex-col items-start gap-1 rounded-md border bg-panel px-3 py-2.5 text-left transition-colors',
                  'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                  selected
                    ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.3)]'
                    : 'border-border',
                )}
              >
                <span
                  className={cn(
                    'text-ui-strong',
                    selected ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {d.label}
                </span>
                <span className="text-metadata text-muted-foreground">{d.description}</span>
              </button>
            );
          })}
        </div>
      </section>

      <Separator />

      <section className="flex max-w-md flex-col gap-3" aria-labelledby="app-brightness-title">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 id="app-brightness-title" className="text-ui-strong text-foreground">
              App brightness
            </h3>
            <p className="text-metadata text-muted-foreground mt-1">
              Adjust only VibeSpace. 100% is the original appearance.
            </p>
          </div>
          <span className="text-ui-strong min-w-12 text-right text-foreground">
            {appBrightness}%
          </span>
        </div>
        <input
          id="app-brightness"
          type="range"
          min="0"
          max="200"
          step="1"
          value={appBrightness}
          aria-label="App brightness"
          onChange={(event) => setAppBrightness(Number(event.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-border accent-accent-cyan"
        />
        <div className="flex items-center justify-between text-metadata text-muted-foreground">
          <span>0%</span>
          <span>200%</span>
        </div>
        <button
          type="button"
          aria-label="Reset app brightness"
          onClick={() => setAppBrightness(100)}
          disabled={appBrightness === 100}
          className="self-start rounded-md border border-border bg-panel px-3 py-2 text-ui-strong text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
        >
          Reset to 100%
        </button>
      </section>

      <Separator />

      <section className="flex max-w-md flex-col gap-4" aria-labelledby="fullscreen-settings">
        <div>
          <h3 id="fullscreen-settings" className="text-ui-strong text-foreground">
            Fullscreen
          </h3>
          <p className="text-metadata text-muted-foreground mt-1">
            Workspace Focus Mode and display fullscreen remain independent.
          </p>
        </div>

        <SettingSwitch
          id="system-fullscreen-active"
          label="True System Fullscreen"
          description="Use fullscreen for this VibeSpace window."
          checked={systemFullscreenActive}
          disabled={nativeAvailability !== 'available' || nativePending}
          onCheckedChange={(enabled) => {
            void requestSystemFullscreen(enabled);
          }}
        />

        <div className="flex flex-col gap-2">
          <Label>System fullscreen display behavior</Label>
          <div
            className="grid grid-cols-2 gap-2"
            role="radiogroup"
            aria-label="System fullscreen display behavior"
          >
            {(
              [
                {
                  id: 'always-hidden',
                  label: 'Always Hidden',
                  description: 'Keep native system chrome hidden until fullscreen exits.',
                },
                {
                  id: 'reveal-on-edge-hover',
                  label: 'Reveal on Edge Hover',
                  description: 'Let the operating system reveal its chrome at the screen edge.',
                },
              ] satisfies Array<{
                id: SystemFullscreenBehavior;
                label: string;
                description: string;
              }>
            ).map((behavior) => {
              const selected = fullscreenPreferences.systemFullscreenBehavior === behavior.id;
              return (
                <button
                  key={behavior.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={behavior.label}
                  data-monochrome-control-size="preserve"
                  onClick={() =>
                    setFullscreenPreferences({
                      systemFullscreenBehavior: behavior.id,
                    })
                  }
                  className={cn(
                    'flex min-h-[74px] flex-col items-start gap-1 rounded-md border bg-panel px-3 py-2.5 text-left transition-colors',
                    'hover:bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    selected
                      ? 'border-accent-cyan/50 shadow-[0_0_0_1px_hsl(var(--accent-cyan)/0.3)]'
                      : 'border-border',
                  )}
                >
                  <span className="text-ui-strong text-foreground">{behavior.label}</span>
                  <span className="text-metadata text-muted-foreground">
                    {behavior.description}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <SettingSwitch
          id="remember-focus-mode"
          label="Remember Workspace Focus Mode"
          description="Remember whether internal workspace chrome was hidden."
          checked={fullscreenPreferences.rememberFocusMode}
          onCheckedChange={(enabled) => setFullscreenPreferences({ rememberFocusMode: enabled })}
        />
        <SettingSwitch
          id="remember-system-fullscreen"
          label="Remember True System Fullscreen"
          description="Remember whether the native window occupied the display."
          checked={fullscreenPreferences.rememberSystemFullscreen}
          onCheckedChange={(enabled) =>
            setFullscreenPreferences({ rememberSystemFullscreen: enabled })
          }
        />
        <SettingSwitch
          id="restore-fullscreen-on-restart"
          label="Restore fullscreen state when VibeSpace restarts"
          description="Restore remembered layers after a clean same-version restart, never after recovery."
          checked={fullscreenPreferences.restoreFullscreenOnRestart}
          onCheckedChange={(enabled) =>
            setFullscreenPreferences({ restoreFullscreenOnRestart: enabled })
          }
        />

        <p
          className={cn(
            'text-metadata',
            fullscreenError ? 'text-destructive' : 'text-muted-foreground',
          )}
          role={fullscreenError ? 'alert' : 'status'}
        >
          {fullscreenError ??
            (nativeAvailability === 'web-preview'
              ? 'True System Fullscreen requires the installed VibeSpace desktop app.'
              : nativeAvailability === 'unavailable'
                ? 'Native fullscreen is unavailable in this environment.'
                : nativePending
                  ? 'Changing fullscreen…'
                  : fullscreenPreferences.systemFullscreenBehavior === 'reveal-on-edge-hover'
                    ? 'Edge reveal is managed by your operating system or window manager.'
                    : 'System bars stay hidden for the fullscreen session when the operating system supports it.')}
        </p>
      </section>

      <Separator />

      <section className="flex flex-col gap-3 max-w-md">
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="default-font-size">Terminal default font size</Label>
            <p className="text-metadata text-muted-foreground mt-1">
              Global baseline font size for newly spawned or unscaled terminal panes.
            </p>
          </div>
          <span className="text-metadata text-accent-cyan font-medium">
            {defaultTerminalFontSize}px
          </span>
        </div>
        <input
          id="default-font-size"
          type="range"
          min="1"
          max="72"
          value={defaultTerminalFontSize}
          onChange={(e) => setDefaultTerminalFontSize(Number(e.target.value))}
          className="h-1.5 w-full appearance-none rounded-lg bg-border cursor-pointer accent-accent-cyan"
        />
      </section>
    </div>
  );
}

function SettingSwitch(props: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <Label htmlFor={props.id}>{props.label}</Label>
        <p className="text-metadata text-muted-foreground mt-1">{props.description}</p>
      </div>
      <Switch
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(enabled) => props.onCheckedChange(Boolean(enabled))}
      />
    </div>
  );
}
