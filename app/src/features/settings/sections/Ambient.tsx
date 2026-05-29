import { useState } from 'react';
import { Moon, Play, Pause } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

/**
 * Ambient settings — controls the V2 idle takeover (breathing orb, clock,
 * rotating quote, glance cards).
 *
 * Settings:
 *   - Master switch (`ambient`)
 *   - Idle threshold (`ambientThresholdMs`) — 1, 3, 5, 10, 15, 30 min presets
 *   - Drone audio (`ambientDrone`) — placeholder for V3 ambient soundtrack
 *   - "Try ambient mode now" — sets ambientActive=true so the user can preview
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
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const [previewing, setPreviewing] = useState(false);

  const thresholdMin = Math.round(ambientThresholdMs / 60000);

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
          <Label>Idle threshold</Label>
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
        <div className="text-metadata text-muted-foreground">
          Currently: {thresholdMin} minute{thresholdMin === 1 ? '' : 's'} of inactivity.
        </div>
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="ambient-drone">Ambient drone</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Soft generative audio while ambient is active. Coming in V3 — toggle saves your preference now.
          </p>
        </div>
        <Switch
          id="ambient-drone"
          checked={ambientDrone}
          disabled
          aria-disabled="true"
        />
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
