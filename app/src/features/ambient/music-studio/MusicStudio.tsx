import * as React from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  FolderPlus,
  GripVertical,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { useUIStore } from '@/stores/ui';
import {
  AmbientAudioEngine,
  type AmbientLoadStatus,
  type AmbientPlaybackProgress,
} from '../ambientAudio';
import { shouldAmbientMusicPlay } from '../ambientPlayback';
import {
  findMusicTrack,
  MUSIC_STUDIO_LIBRARY,
  MUSIC_STUDIO_TOTAL_BYTES,
  type MusicLibraryTrack,
} from './catalog';
import { TrackArtwork } from './TrackArtwork';
import {
  MUSIC_SPEEDS,
  musicClipUrl,
  revokeLocalMusicClip,
  useMusicProjectStore,
  type MusicClip,
} from './musicProject';

const PREVIEW_MS = 15_000;

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${Math.floor(safe % 60)
    .toString()
    .padStart(2, '0')}`;
}

function waveformHeights(seed: string): number[] {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Array.from({ length: 18 }, (_, index) => {
    value = Math.imul(value ^ (index + 1), 2246822519);
    return 22 + (Math.abs(value) % 70);
  });
}

function restoreAmbientProject(): void {
  const ui = useUIStore.getState();
  const project = useMusicProjectStore.getState();
  if (
    !shouldAmbientMusicPlay(ui.ambient, ui.ambientActive, ui.ambientDrone, ui.ambientAlwaysPlay)
  ) {
    AmbientAudioEngine.getInstance().stop();
    return;
  }
  if (project.enabledForAmbient && project.clips.length > 0) {
    AmbientAudioEngine.getInstance().playProject(project.clips, project.loop, ui.ambientVolume);
  }
}

function previewClip(clip: MusicClip): boolean {
  if (!musicClipUrl(clip)) return false;
  AmbientAudioEngine.getInstance().playProject([clip], false, useUIStore.getState().ambientVolume);
  return true;
}

export function MusicStudio({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const clips = useMusicProjectStore((state) => state.clips);
  const loop = useMusicProjectStore((state) => state.loop);
  const enabledForAmbient = useMusicProjectStore((state) => state.enabledForAmbient);
  const savedAt = useMusicProjectStore((state) => state.savedAt);
  const [query, setQuery] = React.useState('');
  const [previewingId, setPreviewingId] = React.useState<string | null>(null);
  const [playbackProgress, setPlaybackProgress] = React.useState<AmbientPlaybackProgress>({
    clipId: null,
    currentTime: 0,
    duration: 0,
  });
  const [loadStatus, setLoadStatus] = React.useState<AmbientLoadStatus>({ state: 'idle' });
  const [selectedClipId, setSelectedClipId] = React.useState<string | null>(
    () => clips[0]?.id ?? null,
  );
  const [draggedClipId, setDraggedClipId] = React.useState<string | null>(null);
  const [timelineZoom, setTimelineZoom] = React.useState(1);
  const previewTimer = React.useRef<number | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null;
  const cloudContentInMix = React.useMemo(
    () =>
      new Set(
        clips.flatMap((clip) => {
          if (clip.source !== 'cloud') return [];
          const digest = findMusicTrack(clip.trackId ?? '')?.sha256;
          return digest ? [digest] : [];
        }),
      ),
    [clips],
  );
  const selectedIndex = selectedClip ? clips.findIndex((clip) => clip.id === selectedClip.id) : -1;
  const selectedPreviewActive = Boolean(
    selectedClip &&
    previewingId === selectedClip.id &&
    playbackProgress.clipId === selectedClip.id &&
    playbackProgress.duration > 0,
  );
  const previewStart = selectedClip?.trimStart ?? 0;
  const previewEnd = Math.max(previewStart, selectedClip?.trimEnd ?? playbackProgress.duration);
  const previewPosition = Math.max(
    previewStart,
    Math.min(playbackProgress.currentTime, previewEnd),
  );
  const timelineClipWidth = Math.round(144 * timelineZoom);

  const stopPreview = React.useCallback(() => {
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    setPreviewingId(null);
    restoreAmbientProject();
  }, []);

  React.useEffect(
    () => () => {
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      restoreAmbientProject();
    },
    [],
  );

  React.useEffect(() => {
    const unsubscribe = AmbientAudioEngine.getInstance().subscribeProgress?.(setPlaybackProgress);
    return () => unsubscribe?.();
  }, []);

  React.useEffect(() => {
    const unsubscribe = AmbientAudioEngine.getInstance().subscribeStatus?.((status) => {
      setLoadStatus(status);
      if (status.state === 'error') setPreviewingId(null);
    });
    return () => unsubscribe?.();
  }, []);

  React.useEffect(() => {
    if (clips.length === 0) {
      setSelectedClipId(null);
      return;
    }
    if (!clips.some((clip) => clip.id === selectedClipId)) setSelectedClipId(clips[0]!.id);
  }, [clips, selectedClipId]);

  const preview = (track: MusicLibraryTrack) => {
    if (previewingId === track.id) {
      stopPreview();
      return;
    }
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    const clip: MusicClip = {
      id: `preview-${track.id}`,
      source: 'cloud',
      trackId: track.id,
      name: track.name,
      trimStart: 0,
      trimEnd: 15,
      speed: 1,
    };
    if (!previewClip(clip)) return;
    setPreviewingId(track.id);
    previewTimer.current = window.setTimeout(stopPreview, PREVIEW_MS);
  };

  const selectAndPreviewClip = (clip: MusicClip) => {
    setSelectedClipId(clip.id);
    if (previewingId === clip.id) {
      stopPreview();
      return;
    }
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (!previewClip(clip)) {
      setPreviewingId(null);
      return;
    }
    setPreviewingId(clip.id);
    previewTimer.current = window.setTimeout(stopPreview, PREVIEW_MS);
  };

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? MUSIC_STUDIO_LIBRARY.filter((track) => track.name.toLowerCase().includes(needle))
      : MUSIC_STUDIO_LIBRARY;
  }, [query]);

  const remove = (clip: MusicClip) => {
    revokeLocalMusicClip(clip);
    useMusicProjectStore.getState().removeClip(clip.id);
  };

  const clear = () => {
    for (const clip of clips) revokeLocalMusicClip(clip);
    useMusicProjectStore.getState().clear();
    AmbientAudioEngine.getInstance().stop();
  };

  const playMix = () => {
    if (clips.length === 0) return;
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = null;
    AmbientAudioEngine.getInstance().playProject(clips, loop, useUIStore.getState().ambientVolume);
    if (AmbientAudioEngine.getInstance().getLoadStatus?.().state !== 'error') {
      setPreviewingId('mix');
    }
  };

  const save = () => {
    useMusicProjectStore.getState().save();
    toast.success(
      'Mix saved',
      `${clips.length} clip${clips.length === 1 ? '' : 's'} ready for ambience.`,
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) stopPreview();
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="z-[100] h-[min(82vh,43rem)] w-[min(96vw,78rem)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 max-sm:h-[96vh] max-sm:w-[98vw]"
        overlayProps={{ className: 'z-[95] bg-black/75 backdrop-blur-sm' }}
      >
        <DialogHeader className="border-b border-border px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-lg tracking-tight">
            <Music2 className="h-5 w-5 text-accent-copper" /> VibeSpace Music Studio
          </DialogTitle>
          <DialogDescription className="text-xs">
            Arrange a continuous ambience mix from {MUSIC_STUDIO_LIBRARY.length} songs or your own
            audio. Local files stay on your device.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-1 overflow-y-auto lg:grid-cols-[19rem_minmax(0,1fr)] lg:overflow-hidden">
          <section
            aria-label="Music library"
            className="flex min-h-[15rem] max-h-[32vh] flex-col border-b border-border bg-paper-soft lg:min-h-0 lg:max-h-none lg:border-b-0 lg:border-r"
          >
            <div className="space-y-2.5 border-b border-border p-3">
              <div className="flex items-baseline justify-between">
                <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-foreground">
                  Library
                </h2>
                <span className="text-[10px] text-muted-foreground">Browse &amp; preview</span>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  aria-label="Search cloud music"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search ${MUSIC_STUDIO_LIBRARY.length} songs`}
                  className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm"
                />
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{MUSIC_STUDIO_LIBRARY.length} unique cloud songs</span>
                <span>{formatBytes(MUSIC_STUDIO_TOTAL_BYTES)}</span>
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="audio/*"
                multiple
                hidden
                onChange={(event) => {
                  for (const file of Array.from(event.target.files ?? [])) {
                    const url = URL.createObjectURL(file);
                    if (!useMusicProjectStore.getState().addLocalFile(file, url))
                      URL.revokeObjectURL(url);
                  }
                  event.currentTarget.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => fileInput.current?.click()}
              >
                <FolderPlus className="h-4 w-4" /> Add your songs
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.map((track) => {
                const alreadyInMix = cloudContentInMix.has(track.sha256);
                return (
                  <div
                    key={track.id}
                    className="mb-1 flex items-center gap-1 rounded-lg border border-transparent bg-background/40 p-1 transition-colors hover:border-border hover:bg-background"
                  >
                    <TrackArtwork seed={track.id} name={track.name} className="h-10 w-10" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-2 py-1.5 text-left"
                      onClick={() => preview(track)}
                      aria-label={`${previewingId === track.id ? 'Pause' : 'Preview'} ${track.name}`}
                    >
                      <span className="flex items-center gap-1">
                        <span className="block min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {track.name}
                        </span>
                        {previewingId === track.id ? (
                          <Pause className="h-3.5 w-3.5 shrink-0 text-accent-copper" />
                        ) : (
                          <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {formatBytes(track.bytes)} · preview 15s
                      </span>
                    </button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={
                        alreadyInMix ? `${track.name} already in mix` : `Add ${track.name} to mix`
                      }
                      disabled={alreadyInMix}
                      onClick={() => useMusicProjectStore.getState().addCloudTrack(track.id)}
                    >
                      {alreadyInMix ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-label="Mix timeline" className="flex min-h-[32rem] flex-col lg:min-h-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-paper px-4 py-2.5">
              <Button
                type="button"
                size="sm"
                onClick={previewingId === 'mix' ? stopPreview : playMix}
                disabled={clips.length === 0}
              >
                {previewingId === 'mix' ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}{' '}
                {previewingId === 'mix' ? 'Pause mix' : 'Play mix'}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={save}>
                <Save className="h-4 w-4" /> Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={clear}
                disabled={clips.length === 0}
              >
                <RotateCcw className="h-4 w-4" /> Clear
              </Button>
              <div className="ml-auto flex items-center gap-2">
                <Label htmlFor="music-loop">Loop mix</Label>
                <Switch
                  id="music-loop"
                  checked={loop}
                  onCheckedChange={(value) => useMusicProjectStore.getState().setLoop(value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="music-ambient">Use in ambience</Label>
                <Switch
                  id="music-ambient"
                  checked={enabledForAmbient}
                  onCheckedChange={(value) => {
                    useMusicProjectStore.getState().setEnabledForAmbient(value);
                    useMusicProjectStore.getState().save();
                  }}
                />
              </div>
            </div>
            {loadStatus.state === 'error' ? (
              <div
                role="alert"
                className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive"
              >
                Could not play track: {loadStatus.message}
              </div>
            ) : null}
            <div className="flex items-center gap-2 border-b border-border bg-paper-soft px-4 py-2 text-xs text-muted-foreground">
              <Clock3 className="h-4 w-4" />
              <span className="font-bold uppercase tracking-[0.12em] text-foreground">Mix</span>
              <span className="text-border">/</span>
              <span>
                {clips.length} clip{clips.length === 1 ? '' : 's'} in one continuous track
              </span>
              {savedAt ? (
                <span className="ml-auto flex items-center gap-1 text-accent-copper">
                  <Check className="h-3.5 w-3.5" /> Saved
                </span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              {clips.length === 0 ? (
                <div className="grid h-full min-h-52 place-items-center rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
                  <div>
                    <Music2 className="mx-auto mb-2 h-8 w-8" />
                    <p>Add songs from the library to build your track.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="overflow-hidden rounded-xl border border-border bg-[#111318] shadow-inner">
                    <div className="flex h-10 items-center gap-2 border-b border-white/10 px-3 text-[10px] text-white/65">
                      <Scissors className="h-3.5 w-3.5 text-accent-copper" />
                      <span className="font-semibold uppercase tracking-[0.16em] text-white/85">
                        Timeline
                      </span>
                      <span>1 audio lane</span>
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          aria-label="Zoom timeline out"
                          onClick={() => setTimelineZoom((value) => Math.max(0.65, value - 0.1))}
                          className="grid h-6 w-6 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white"
                        >
                          <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <input
                          type="range"
                          aria-label="Music timeline zoom"
                          min="0.65"
                          max="1.8"
                          step="0.05"
                          value={timelineZoom}
                          onChange={(event) => setTimelineZoom(Number(event.target.value))}
                          className="h-1 w-24 cursor-pointer accent-accent-copper"
                        />
                        <button
                          type="button"
                          aria-label="Zoom timeline in"
                          onClick={() => setTimelineZoom((value) => Math.min(1.8, value + 0.1))}
                          className="grid h-6 w-6 place-items-center rounded text-white/70 hover:bg-white/10 hover:text-white"
                        >
                          <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <div className="min-w-max">
                        <div className="flex h-7 items-end border-b border-white/10 bg-black/20 pb-1 text-[9px] text-white/45">
                          <span className="sticky left-0 z-20 w-14 shrink-0 bg-[#111318] px-2">
                            Track
                          </span>
                          <div className="flex gap-1 px-2">
                            {clips.map((clip, index) => (
                              <span
                                key={clip.id}
                                className="shrink-0 border-l border-white/15 pl-1"
                                style={{ width: timelineClipWidth }}
                              >
                                {String(index + 1).padStart(2, '0')}
                              </span>
                            ))}
                          </div>
                        </div>
                        <div className="flex min-h-24 items-stretch bg-[linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[length:18px_100%] py-2">
                          <div className="sticky left-0 z-20 grid w-14 shrink-0 place-items-center border-r border-white/10 bg-[#15181e] text-[10px] font-bold tracking-widest text-accent-copper">
                            A1
                          </div>
                          <ol
                            className="flex min-w-max items-stretch gap-1 px-2"
                            aria-label="Mix clips timeline"
                          >
                            {clips.map((clip, index) => {
                              const selected = clip.id === selectedClip?.id;
                              const active =
                                previewingId === 'mix' &&
                                playbackProgress.clipId === clip.id &&
                                playbackProgress.duration > 0;
                              const playheadPercent = active
                                ? Math.max(
                                    0,
                                    Math.min(
                                      100,
                                      (playbackProgress.currentTime / playbackProgress.duration) *
                                        100,
                                    ),
                                  )
                                : 0;
                              return (
                                <li
                                  key={clip.id}
                                  data-testid="music-timeline-clip"
                                  data-zoom={timelineZoom}
                                  draggable
                                  onDragStart={() => setDraggedClipId(clip.id)}
                                  onDragEnd={() => setDraggedClipId(null)}
                                  onDragOver={(event) => event.preventDefault()}
                                  onDrop={(event) => {
                                    event.preventDefault();
                                    if (draggedClipId)
                                      useMusicProjectStore
                                        .getState()
                                        .moveClipTo(draggedClipId, index);
                                    setDraggedClipId(null);
                                  }}
                                  style={{ width: timelineClipWidth }}
                                  className={`relative h-20 shrink-0 overflow-hidden rounded-md border transition-[width,border-color,background-color] ${
                                    selected
                                      ? 'border-accent-copper bg-accent-copper/20 shadow-[inset_0_0_0_1px_hsl(var(--accent-copper))]'
                                      : 'border-white/15 bg-[#252a33] hover:border-accent-copper/60'
                                  }`}
                                >
                                  <GripVertical
                                    aria-hidden="true"
                                    className="absolute left-1 top-1 z-10 h-3.5 w-3.5 text-white/60"
                                  />
                                  {selected ? (
                                    <span className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded bg-accent-copper px-1 py-0.5 text-[8px] font-bold text-black">
                                      <Check className="h-2 w-2" /> Selected
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    aria-label={`Edit ${clip.name}`}
                                    aria-pressed={selected}
                                    onClick={() => selectAndPreviewClip(clip)}
                                    className="flex h-full w-full flex-col p-1.5 pt-6 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-copper"
                                  >
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <TrackArtwork
                                        seed={clip.trackId ?? clip.id}
                                        name={clip.name}
                                        className="h-7 w-7 shrink-0 rounded"
                                      />
                                      <span className="min-w-0">
                                        <span className="block truncate text-[10px] font-semibold text-white">
                                          {clip.name}
                                        </span>
                                        <span className="block truncate text-[8px] text-white/55">
                                          {clip.speed}× · {clip.trimStart}s →{' '}
                                          {clip.trimEnd ?? 'full'}
                                        </span>
                                      </span>
                                    </span>
                                    <span
                                      data-testid="music-clip-waveform"
                                      aria-hidden="true"
                                      className="mt-auto flex h-4 items-center gap-px overflow-hidden"
                                    >
                                      {waveformHeights(clip.trackId ?? clip.id).map(
                                        (height, barIndex) => (
                                          <span
                                            key={barIndex}
                                            className="min-w-px flex-1 rounded-full bg-accent-copper/70"
                                            style={{ height: `${height}%` }}
                                          />
                                        ),
                                      )}
                                    </span>
                                  </button>
                                  {active ? (
                                    <span
                                      data-testid="music-timeline-playhead"
                                      aria-label={`Playhead for ${clip.name}`}
                                      style={{ left: `${playheadPercent}%` }}
                                      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white shadow-[0_0_5px_rgba(255,255,255,0.9)]"
                                    >
                                      <span className="absolute -left-1 -top-0.5 h-2 w-2 rotate-45 bg-white" />
                                    </span>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ol>
                        </div>
                      </div>
                    </div>
                  </div>

                  {selectedClip ? (
                    <section
                      aria-label="Selected clip editor"
                      className="grid gap-3 rounded-xl border border-accent-copper/40 bg-paper p-3 shadow-sm sm:grid-cols-[4.5rem_minmax(0,1fr)]"
                    >
                      <TrackArtwork
                        seed={selectedClip.trackId ?? selectedClip.id}
                        name={selectedClip.name}
                        className="aspect-square w-[4.5rem] rounded-lg"
                      />
                      <div className="min-w-0 space-y-2.5">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-accent-copper">
                              Clip {selectedIndex + 1} of {clips.length}
                            </p>
                            <h3 className="truncate text-base font-semibold text-foreground">
                              {selectedClip.name}
                            </h3>
                            <p className="text-xs text-muted-foreground">
                              {selectedClip.source === 'cloud'
                                ? 'VibeSpace cloud library'
                                : selectedClip.missing
                                  ? 'Local file — re-add after restart'
                                  : 'Local device only'}
                            </p>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => selectAndPreviewClip(selectedClip)}
                          >
                            {previewingId === selectedClip.id ? (
                              <Pause className="h-4 w-4" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                            {previewingId === selectedClip.id
                              ? 'Pause selected'
                              : 'Preview selected'}
                          </Button>
                        </div>

                        {selectedPreviewActive ? (
                          <div className="rounded-lg border border-border bg-background/55 px-3 py-2">
                            <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
                              <span>Song preview timeline</span>
                              <span className="font-mono text-foreground">
                                {formatTime(previewPosition - previewStart)} /{' '}
                                {formatTime(previewEnd - previewStart)}
                              </span>
                            </div>
                            <input
                              type="range"
                              aria-label={`Preview position for ${selectedClip.name}`}
                              min={previewStart}
                              max={previewEnd}
                              step="0.1"
                              value={previewPosition}
                              onChange={(event) =>
                                AmbientAudioEngine.getInstance().seek(Number(event.target.value))
                              }
                              className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-border accent-accent-copper"
                            />
                          </div>
                        ) : null}

                        <div className="grid gap-2 sm:grid-cols-3">
                          <label className="text-[10px] text-muted-foreground">
                            Selected clip start (seconds)
                            <input
                              type="number"
                              min="0"
                              step="0.5"
                              value={selectedClip.trimStart}
                              onChange={(event) =>
                                useMusicProjectStore.getState().updateClip(selectedClip.id, {
                                  trimStart: Number(event.target.value),
                                })
                              }
                              className="mt-1 h-9 w-full rounded border border-border bg-background px-2 text-xs"
                            />
                          </label>
                          <label className="text-[10px] text-muted-foreground">
                            Selected clip end (seconds)
                            <input
                              type="number"
                              min={selectedClip.trimStart}
                              step="0.5"
                              value={selectedClip.trimEnd ?? ''}
                              placeholder="Full song"
                              onChange={(event) =>
                                useMusicProjectStore.getState().updateClip(selectedClip.id, {
                                  trimEnd: event.target.value ? Number(event.target.value) : null,
                                })
                              }
                              className="mt-1 h-9 w-full rounded border border-border bg-background px-2 text-xs"
                            />
                          </label>
                          <label className="text-[10px] text-muted-foreground">
                            Selected clip speed
                            <select
                              value={selectedClip.speed}
                              onChange={(event) =>
                                useMusicProjectStore.getState().updateClip(selectedClip.id, {
                                  speed: Number(event.target.value),
                                })
                              }
                              className="mt-1 h-9 w-full rounded border border-border bg-background px-2 text-xs"
                            >
                              {MUSIC_SPEEDS.map((speed) => (
                                <option key={speed} value={speed}>
                                  {speed}×
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div className="flex flex-wrap items-center gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={selectedIndex === 0}
                            onClick={() =>
                              useMusicProjectStore.getState().moveClip(selectedClip.id, -1)
                            }
                          >
                            <ArrowUp className="h-4 w-4" /> Move earlier
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={selectedIndex === clips.length - 1}
                            onClick={() =>
                              useMusicProjectStore.getState().moveClip(selectedClip.id, 1)
                            }
                          >
                            <ArrowDown className="h-4 w-4" /> Move later
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => remove(selectedClip)}
                          >
                            <Trash2 className="h-4 w-4" /> Remove clip
                          </Button>
                        </div>
                      </div>
                    </section>
                  ) : null}
                </div>
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
