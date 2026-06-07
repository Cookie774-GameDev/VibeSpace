import { useEffect, useState } from 'react';
import { Moon, Play, Pause, Music } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { effectivePlan, isAdminIdentity } from '@/lib/entitlements';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  AMBIENT_TRACKS,
  FREE_AMBIENT_TRACK,
  planAllowsAmbientTrack,
} from '@/features/ambient/tracks';

/**
 * Ambient settings — controls the V2 idle takeover (breathing orb, clock,
 * rotating quote, glance cards) and the hosted ambient music playlist.
 */
const PRESETS_MIN: { label: string; value: number }[] = [
  { label: '1 min', value: 1 },
  { label: '3 min', value: 3 },
  { label: '5 min', value: 5 },
  { label: '10 min', value: 10 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];

export function Ambient() {
  const ambient = useUIStore((s) => s.ambient);
  const setAmbient = useUIStore((s) => s.setAmbient);
  const ambientThresholdMs = useUIStore((s) => s.ambientThresholdMs);
  const setAmbientThresholdMs = useUIStore((s) => s.setAmbientThresholdMs);
  const ambientDrone = useUIStore((s) => s.ambientDrone);
  const setAmbientDrone = useUIStore((s) => s.setAmbientDrone);
  const ambientTrack = useUIStore((s) => s.ambientTrack);
  const setAmbientTrack = useUIStore((s) => s.setAmbientTrack);
  const ambientVolume = useUIStore((s) => s.ambientVolume);
  const setAmbientVolume = useUIStore((s) => s.setAmbientVolume);
  const ambientAlwaysPlay = useUIStore((s) => s.ambientAlwaysPlay);
  const setAmbientAlwaysPlay = useUIStore((s) => s.setAmbientAlwaysPlay);
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const plan = useAuthStore((s) => s.plan);
  const email = useAuthStore((s) => s.email);
  const cloudEmail = useAuthStore((s) => s.cloudSession?.email ?? null);
  const localUserId = useAuthStore((s) => s.localUserId);

  const [previewing, setPreviewing] = useState(false);

  const thresholdMin = Math.round(ambientThresholdMs / 60000);
  const admin = isAdminIdentity({ email, cloudEmail, localUserId });
  const activePlan = effectivePlan(plan, admin);
  useEffect(() => {
    if (planAllowsAmbientTrack(ambientTrack, activePlan, admin)) return;
    setAmbientTrack(FREE_AMBIENT_TRACK);
  }, [activePlan, admin, ambientTrack, setAmbientTrack]);

  const handlePreview = () => {
    setPreviewing(true);
    setSettingsOpen(false);
    // Defer slightly so the modal close animation finishes before ambient mounts.
    setTimeout(() => {
      if (!ambient) setAmbient(true);
      setAmbientActive(true);
      setPreviewing(false);
    }, 220);
  };

  const isDroneControlsDisabled = !ambient || !ambientDrone;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="text-page-title text-foreground">Ambient mode</h2>
        <p className="text-secondary text-muted-foreground mt-1">
          A calm idle screen with a breathing orb, clock, and your next event. Wakes on any input.
        </p>
      </header>

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="ambient-toggle">Enable ambient mode</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Master switch. When off, your screen stays as-is regardless of idle time.
          </p>
        </div>
        <Switch
          id="ambient-toggle"
          checked={ambient}
          onCheckedChange={(v) => setAmbient(Boolean(v))}
        />
      </section>

      <Separator />

      <section className="flex flex-col gap-3">
        <div>
          <Label className={!ambient ? 'opacity-50' : ''}>Idle threshold</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            How long without input before ambient takes over.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESETS_MIN.map((p) => {
            const active = thresholdMin === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setAmbientThresholdMs(p.value * 60_000)}
                disabled={!ambient}
                className={
                  'px-3 py-1.5 rounded-md text-secondary border transition-colors ' +
                  (active
                    ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
                    : 'border-border bg-panel text-muted-foreground hover:border-border-mid disabled:opacity-50')
                }
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className={`text-metadata text-muted-foreground ${!ambient ? 'opacity-50' : ''}`}>
          Currently: {thresholdMin} minute{thresholdMin === 1 ? '' : 's'} of inactivity.
        </div>
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="ambient-drone" className={!ambient ? 'opacity-50' : ''}>Ambient soundscape</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Play the hosted Jarvis music playlist while ambient is active.
          </p>
        </div>
        <Switch
          id="ambient-drone"
          checked={ambientDrone}
          onCheckedChange={setAmbientDrone}
          disabled={!ambient}
        />
      </section>

      {/* Dynamic Soundscape Sub-options */}
      <section className="flex flex-col gap-4 pl-4 border-l border-border/60">
        <div className="flex flex-col gap-2">
          <Label className={isDroneControlsDisabled ? 'opacity-50' : ''}>Track selector</Label>
          <p className="text-metadata text-muted-foreground">
            Choose where the five-track playlist starts. It continues in order and repeats.
          </p>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {AMBIENT_TRACKS.map((t) => {
              const active = ambientTrack === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setAmbientTrack(t.id);
                  }}
                  disabled={isDroneControlsDisabled}
                  className={
                    'flex items-center gap-2.5 p-3 rounded-lg border text-left transition-all ' +
                    (active
                      ? 'border-accent-copper bg-accent-copper/10 text-foreground shadow-sm'
                      : 'border-border bg-panel text-muted-foreground hover:border-border-mid disabled:opacity-40')
                  }
                >
                  <Music className={`h-4 w-4 shrink-0 ${active ? 'text-accent-copper' : 'text-muted-foreground/60'}`} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-foreground">{t.label}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{t.desc}</div>
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-metadata text-muted-foreground">
            Replace the five placeholder URLs in the ambient track configuration with your public R2 links.
          </p>
        </div>

        <div className="flex flex-col gap-2 max-w-md">
          <div className="flex items-center justify-between">
            <Label htmlFor="ambient-volume" className={isDroneControlsDisabled ? 'opacity-50' : ''}>Volume</Label>
            <span className={`text-metadata text-accent-copper font-medium ${isDroneControlsDisabled ? 'opacity-50' : ''}`}>
              {ambientVolume}%
            </span>
          </div>
          <input
            id="ambient-volume"
            type="range"
            min="0"
            max="100"
            value={ambientVolume}
            onChange={(e) => setAmbientVolume(Number(e.target.value))}
            disabled={isDroneControlsDisabled}
            className="h-1.5 w-full appearance-none rounded-lg bg-border cursor-pointer accent-accent-copper disabled:opacity-50"
          />
        </div>

        <div className="flex items-start justify-between gap-3 max-w-md">
          <div>
            <Label htmlFor="ambient-always-play" className={isDroneControlsDisabled ? 'opacity-50' : ''}>Always play 24/7</Label>
            <p className="text-metadata text-muted-foreground mt-1">
              Keep the hosted music playlist playing continuously, even when not in idle mode.
            </p>
          </div>
          <Switch
            id="ambient-always-play"
            checked={ambientAlwaysPlay}
            onCheckedChange={setAmbientAlwaysPlay}
            disabled={isDroneControlsDisabled}
          />
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-2">
        <Label>Preview</Label>
        <p className="text-metadata text-muted-foreground">
          Closes settings and drops into ambient. Press any key or move the mouse to wake.
        </p>
        <div>
          <Button onClick={handlePreview} disabled={previewing} variant="secondary">
            {previewing ? <Pause className="h-3.5 w-3.5 mr-1.5" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
            <Moon className="h-3.5 w-3.5 mr-1.5" />
            Try ambient mode now
          </Button>
        </div>
      </section>
    </div>
  );
}
