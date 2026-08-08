import { useEffect, useRef, useState } from 'react';
import { Moon, Play, Pause, Music } from 'lucide-react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';
import { effectivePlan } from '@/lib/entitlements';
import { useAppAdmin } from '@/lib/admin';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { AmbientAudioEngine, type AmbientLoadStatus } from '@/features/ambient/ambientAudio';
import { shouldAmbientMusicPlay } from '@/features/ambient/ambientPlayback';
import {
  AMBIENT_PREVIEW_DURATION_MS,
  AMBIENT_TRACKS,
  FREE_AMBIENT_TRACK,
  getAmbientTrackDef,
  planAllowsAmbientTrack,
} from '@/features/ambient/tracks';
import { AMBIENT_IDLE_PRESETS_MIN, type ClockFormat } from '@/lib/timeFormat';

/**
 * Ambient settings — controls the V2 idle takeover (breathing orb, clock,
 * rotating quote, glance cards) and the hosted ambient music playlist.
 */
const PRESETS_MIN = AMBIENT_IDLE_PRESETS_MIN;

const CLOCK_FORMAT_OPTIONS: { id: ClockFormat; label: string; hint: string }[] = [
  {
    id: 'local',
    label: 'Local time',
    hint: '12-hour where your locale uses it (AM/PM).',
  },
  {
    id: 'military',
    label: 'Military time',
    hint: '24-hour format (00:00–23:59).',
  },
];

export function Ambient() {
  const ambient = useUIStore((s) => s.ambient);
  const setAmbient = useUIStore((s) => s.setAmbient);
  const ambientActive = useUIStore((s) => s.ambientActive);
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
  const clockFormat = useUIStore((s) => s.clockFormat);
  const setClockFormat = useUIStore((s) => s.setClockFormat);
  const setAmbientActive = useUIStore((s) => s.setAmbientActive);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const plan = useAuthStore((s) => s.plan);

  const [previewing, setPreviewing] = useState(false);
  const [previewingMusic, setPreviewingMusic] = useState(false);
  const [musicStatus, setMusicStatus] = useState<AmbientLoadStatus>({ state: 'idle' });
  const previewStopRef = useRef<number | null>(null);

  useEffect(() => {
    return AmbientAudioEngine.getInstance().subscribeStatus(setMusicStatus);
  }, []);

  const thresholdMin = Math.round(ambientThresholdMs / 60000);
  const admin = useAppAdmin();
  const activePlan = effectivePlan(plan, admin);
  const isMusicLive = shouldAmbientMusicPlay(
    ambient,
    ambientActive,
    ambientDrone,
    ambientAlwaysPlay,
  );
  const selectedTrackLabel = getAmbientTrackDef(ambientTrack).label;

  useEffect(() => {
    if (planAllowsAmbientTrack(ambientTrack, activePlan, admin)) return;
    setAmbientTrack(FREE_AMBIENT_TRACK);
  }, [activePlan, admin, ambientTrack, setAmbientTrack]);

  useEffect(() => {
    if (AMBIENT_TRACKS.some((track) => track.id === ambientTrack)) return;
    setAmbientTrack(FREE_AMBIENT_TRACK);
  }, [ambientTrack, setAmbientTrack]);

  const handlePreview = () => {
    setPreviewing(true);
    setSettingsOpen(false);
    setTimeout(() => {
      if (!ambient) setAmbient(true);
      if (!ambientDrone) setAmbientDrone(true);
      setAmbientActive(true);
      setPreviewing(false);
    }, 220);
  };

  useEffect(() => {
    return () => {
      if (previewStopRef.current !== null) {
        window.clearTimeout(previewStopRef.current);
      }
    };
  }, []);

  const handlePreviewMusic = () => {
    if (previewStopRef.current !== null) {
      window.clearTimeout(previewStopRef.current);
      previewStopRef.current = null;
    }

    setPreviewingMusic(true);
    const engine = AmbientAudioEngine.getInstance();
    engine.play(ambientTrack, ambientVolume);
    void engine.resume();

    previewStopRef.current = window.setTimeout(() => {
      previewStopRef.current = null;
      setPreviewingMusic(false);
      const live = shouldAmbientMusicPlay(
        useUIStore.getState().ambient,
        useUIStore.getState().ambientActive,
        useUIStore.getState().ambientDrone,
        useUIStore.getState().ambientAlwaysPlay,
      );
      if (!live) {
        engine.stop();
      }
    }, AMBIENT_PREVIEW_DURATION_MS);
  };

  return (
    <div className="mc7f-settings-ambient flex flex-col gap-6 [html[data-theme=monochrome]_&]:border-l-2 [html[data-theme=monochrome]_&]:border-l-foreground/20 [html[data-theme=monochrome]_&]:pl-4 [html[data-theme=monochrome]_&_*]:rounded-none [html[data-theme=monochrome]_&_*]:bg-none [html[data-theme=monochrome]_&_*]:shadow-none [html[data-theme=monochrome]_&_*]:!animate-none [html[data-theme=monochrome]_&_*]:!blur-none [html[data-theme=monochrome]_&_*]:backdrop-blur-none [html[data-theme=monochrome]_&_*]:transition-none [html[data-theme=monochrome]_&_*]:focus-visible:outline [html[data-theme=monochrome]_&_*]:focus-visible:outline-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-offset-2 [html[data-theme=monochrome]_&_*]:focus-visible:outline-ring motion-reduce:[&_*]:!animate-none motion-reduce:[&_*]:transition-none">
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

      <section className="flex flex-col gap-3">
        <div>
          <Label>Time format</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Applies to clocks, schedules, notifications, history, tasks, calls, and activity.
            Stored times are unchanged; only how they appear.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {CLOCK_FORMAT_OPTIONS.map((opt) => {
            const active = clockFormat === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setClockFormat(opt.id)}
                aria-pressed={active}
                className={
                  'px-3 py-1.5 rounded-md text-secondary border transition-colors ' +
                  (active
                    ? 'border-accent-cyan/60 bg-accent-cyan/10 text-foreground'
                    : 'border-border bg-panel text-muted-foreground hover:border-border-mid')
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="text-metadata text-muted-foreground">
          {CLOCK_FORMAT_OPTIONS.find((o) => o.id === clockFormat)?.hint}
          {' · '}
          Uses your system timezone.
        </div>
      </section>

      <Separator />

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="ambient-drone" className={!ambient ? 'opacity-50' : ''}>
            Ambient soundscape
          </Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Play music on the ambient idle screen (when 24/7 is off).
          </p>
        </div>
        <Switch
          id="ambient-drone"
          checked={ambientDrone}
          onCheckedChange={setAmbientDrone}
          disabled={!ambient}
        />
      </section>

      <section className="flex items-start justify-between gap-3 max-w-md">
        <div>
          <Label htmlFor="ambient-always-play">Play music 24/7</Label>
          <p className="text-metadata text-muted-foreground mt-1">
            Loop the selected track all the time. When off, music only plays during ambient idle.
          </p>
        </div>
        <Switch
          id="ambient-always-play"
          checked={ambientAlwaysPlay}
          onCheckedChange={setAmbientAlwaysPlay}
        />
      </section>

      <section className="flex flex-col gap-4 pl-4 border-l border-border/60">
        <div className="flex flex-col gap-2">
          <Label>Track selector</Label>
          <p className="text-metadata text-muted-foreground">
            Pick a track to loop. 24/7 plays it always; otherwise it plays on the ambient idle
            screen.
          </p>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {AMBIENT_TRACKS.map((t) => {
              const active = ambientTrack === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-monochrome-control-size="preserve"
                  onClick={() => {
                    setAmbientTrack(t.id);
                    if (isMusicLive) {
                      AmbientAudioEngine.getInstance().setTrack(t.id);
                    }
                  }}
                  className={
                    'flex items-center gap-2.5 p-3 rounded-lg border text-left transition-all ' +
                    (active
                      ? 'border-accent-copper bg-accent-copper/10 text-foreground shadow-sm'
                      : 'border-border bg-panel text-muted-foreground hover:border-border-mid')
                  }
                >
                  <Music
                    className={`h-4 w-4 shrink-0 ${active ? 'text-accent-copper' : 'text-muted-foreground/60'}`}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-foreground">{t.label}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                      {t.desc}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {musicStatus.state === 'error' ? (
            <p className="text-[11px] text-destructive">
              {selectedTrackLabel}: {musicStatus.message}
            </p>
          ) : null}
          {musicStatus.state === 'playing' ? (
            <p className="text-[11px] text-accent-copper">
              Now playing: {selectedTrackLabel}
              {previewingMusic
                ? ` · preview (${Math.round(AMBIENT_PREVIEW_DURATION_MS / 1000)}s)`
                : ''}
            </p>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={previewingMusic}
            onClick={handlePreviewMusic}
          >
            {previewingMusic ? (
              <Pause className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            Preview music ({Math.round(AMBIENT_PREVIEW_DURATION_MS / 1000)}s)
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Plays the selected track for {Math.round(AMBIENT_PREVIEW_DURATION_MS / 1000)} seconds.
            Volume applies live.
          </p>
        </div>

        <div className="flex flex-col gap-2 max-w-md">
          <div className="flex items-center justify-between">
            <Label htmlFor="ambient-volume">Volume</Label>
            <span className="text-metadata text-accent-copper font-medium">{ambientVolume}%</span>
          </div>
          <input
            id="ambient-volume"
            type="range"
            min="0"
            max="100"
            value={ambientVolume}
            onChange={(e) => {
              const next = Number(e.target.value);
              setAmbientVolume(next);
              AmbientAudioEngine.getInstance().setVolume(next);
            }}
            className="h-1.5 w-full appearance-none rounded-lg bg-border cursor-pointer accent-accent-copper"
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
            {previewing ? (
              <Pause className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            <Moon className="h-3.5 w-3.5 mr-1.5" />
            Try ambient mode now
          </Button>
        </div>
      </section>
    </div>
  );
}
