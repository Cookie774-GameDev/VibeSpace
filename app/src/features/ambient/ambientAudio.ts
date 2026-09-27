import type { AmbientTrack } from '@/stores/ui';
import { AMBIENT_TRACKS, getAmbientTrackIndex } from './tracks';
import { musicClipUrl, type MusicClip } from './music-studio/musicProject';

export interface AmbientLoadError {
  url: string;
  message: string;
  at: number;
}

export type AmbientLoadStatus =
  | { state: 'idle' }
  | { state: 'playing'; url: string }
  | { state: 'error'; url: string; message: string };

export interface AmbientPlaybackProgress {
  clipId: string | null;
  currentTime: number;
  duration: number;
}

export function musicProjectSignature(clips: readonly MusicClip[], loop: boolean): string {
  return JSON.stringify({
    loop,
    clips: clips.map((clip) => [
      clip.id,
      musicClipUrl(clip),
      clip.trimStart,
      clip.trimEnd,
      clip.speed,
    ]),
  });
}

function mediaErrorMessage(audio: HTMLAudioElement): string {
  const err = audio.error;
  if (!err) return 'Failed to load track';
  switch (err.code) {
    case 1:
      return 'Playback aborted';
    case 2:
      return 'Network error — check R2 public access';
    case 3:
      return 'Decode error — file may be corrupt or not MP3';
    case 4:
      return 'Could not play this track — file missing or unsupported format';
    default:
      return err.message || `Media error ${err.code}`;
  }
}

export class AmbientAudioEngine {
  private static instance: AmbientAudioEngine | null = null;
  private audio: HTMLAudioElement | null = null;
  private currentTrackIndex = 0;
  private isEngineRunning = false;
  private currentVolumePercent = 40;
  private lastLoadError: AmbientLoadError | null = null;
  private loadStatus: AmbientLoadStatus = { state: 'idle' };
  private listeners = new Set<() => void>();
  private statusListeners = new Set<(status: AmbientLoadStatus) => void>();
  private progressListeners = new Set<(progress: AmbientPlaybackProgress) => void>();
  private projectClips: MusicClip[] | null = null;
  private projectIndex = 0;
  private projectLoop = true;
  private projectSignature = '';
  private playbackAttempt = 0;

  private constructor() {}

  public static getInstance(): AmbientAudioEngine {
    if (!AmbientAudioEngine.instance) {
      AmbientAudioEngine.instance = new AmbientAudioEngine();
    }
    return AmbientAudioEngine.instance;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public subscribeStatus(listener: (status: AmbientLoadStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.loadStatus);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  public subscribeProgress(listener: (progress: AmbientPlaybackProgress) => void): () => void {
    this.progressListeners.add(listener);
    listener(this.playbackProgress());
    return () => {
      this.progressListeners.delete(listener);
    };
  }

  public getLastLoadError(): AmbientLoadError | null {
    return this.lastLoadError;
  }

  public getLoadStatus(): AmbientLoadStatus {
    return this.loadStatus;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private notifyStatus(): void {
    for (const listener of this.statusListeners) listener(this.loadStatus);
  }

  private playbackProgress(): AmbientPlaybackProgress {
    const currentTime = this.audio?.currentTime;
    const duration = this.audio?.duration;
    return {
      clipId: this.currentProjectClip()?.id ?? null,
      currentTime: Number.isFinite(currentTime) ? Math.max(0, currentTime ?? 0) : 0,
      duration: Number.isFinite(duration) ? Math.max(0, duration ?? 0) : 0,
    };
  }

  private notifyProgress(): void {
    const progress = this.playbackProgress();
    for (const listener of this.progressListeners) listener(progress);
  }

  private setLoadStatus(status: AmbientLoadStatus): void {
    this.loadStatus = status;
    this.notifyStatus();
  }

  private setLoadError(url: string, message: string): void {
    this.lastLoadError = { url, message, at: Date.now() };
    this.setLoadStatus({ state: 'error', url, message });
    this.notify();
  }

  private markPlaying(url: string): void {
    this.lastLoadError = null;
    this.setLoadStatus({ state: 'playing', url });
    this.notify();
  }

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.loop = true;
      this.audio.addEventListener('error', this.handleTrackError);
      this.audio.addEventListener('ended', this.handleEnded);
      this.audio.addEventListener('timeupdate', this.handleTimeUpdate);
    }
    return this.audio;
  }

  private currentTrackDef() {
    return AMBIENT_TRACKS[this.currentTrackIndex] ?? AMBIENT_TRACKS[0];
  }

  private resolvedAudioUrl(url: string): string {
    try {
      return new URL(url, window.location.href).href;
    } catch {
      return url;
    }
  }

  private loadCurrentTrack(): void {
    const audio = this.getAudio();
    const nextUrl = this.currentTrackDef().url;
    if (!nextUrl) return;
    const resolved = this.resolvedAudioUrl(nextUrl);
    const current = audio.currentSrc || audio.src;
    if (!current || this.resolvedAudioUrl(current) !== resolved) {
      audio.src = nextUrl;
      audio.load();
    }
  }

  private startPlayback(): void {
    if (!this.isEngineRunning) return;
    this.loadCurrentTrack();
    this.setLoadStatus({ state: 'idle' });
    const attempt = ++this.playbackAttempt;
    void this.getAudio()
      .play()
      .then(() => {
        if (attempt === this.playbackAttempt && this.isEngineRunning)
          this.markPlaying(this.currentTrackDef().url);
      })
      .catch((err: unknown) => {
        if (attempt !== this.playbackAttempt) return;
        const message = err instanceof Error ? err.message : 'Playback blocked until user gesture';
        this.stop();
        this.setLoadError(this.currentTrackDef().url, message);
        console.warn('Ambient music playback is waiting for a user gesture:', err);
      });
  }

  private currentProjectClip(): MusicClip | null {
    return this.projectClips?.[this.projectIndex] ?? null;
  }

  private startProjectClip(): void {
    if (!this.isEngineRunning || !this.projectClips?.length) return;
    let attempts = 0;
    let clip = this.currentProjectClip();
    let url = clip ? musicClipUrl(clip) : null;
    while (!url && attempts < this.projectClips.length) {
      this.projectIndex = (this.projectIndex + 1) % this.projectClips.length;
      clip = this.currentProjectClip();
      url = clip ? musicClipUrl(clip) : null;
      attempts += 1;
    }
    if (!clip || !url) {
      this.stop();
      this.setLoadError('', 'Saved mix needs at least one available track');
      return;
    }
    this.setLoadStatus({ state: 'idle' });
    const audio = this.getAudio();
    audio.loop = false;
    audio.playbackRate = clip.speed;
    audio.src = url;
    audio.load();
    const seek = () => {
      try {
        audio.currentTime = clip!.trimStart;
        this.notifyProgress();
      } catch {
        // Some media engines reject seeking until metadata is fully available.
      }
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
    const attempt = ++this.playbackAttempt;
    void audio
      .play()
      .then(() => {
        if (attempt === this.playbackAttempt && this.isEngineRunning) this.markPlaying(url!);
      })
      .catch((err: unknown) => {
        if (attempt !== this.playbackAttempt) return;
        const message = err instanceof Error ? err.message : 'Playback blocked until user gesture';
        this.stop();
        this.setLoadError(url!, message);
      });
  }

  private advanceProject(): void {
    if (!this.projectClips?.length) return;
    const next = this.projectIndex + 1;
    if (next >= this.projectClips.length && !this.projectLoop) {
      this.stop();
      return;
    }
    this.projectIndex = next % this.projectClips.length;
    this.startProjectClip();
  }

  private handleEnded = (): void => {
    if (this.projectClips) this.advanceProject();
  };

  private handleTimeUpdate = (): void => {
    const clip = this.currentProjectClip();
    if (
      clip?.trimEnd !== null &&
      clip?.trimEnd !== undefined &&
      this.getAudio().currentTime >= clip.trimEnd
    ) {
      this.advanceProject();
      return;
    }
    this.notifyProgress();
  };

  private handleTrackError = (): void => {
    const failedUrl = this.projectClips
      ? (musicClipUrl(this.currentProjectClip()!) ?? '')
      : this.currentTrackDef().url;
    const audio = this.getAudio();
    const message = mediaErrorMessage(audio);
    this.stop();
    this.setLoadError(failedUrl, message);
    console.warn(`Ambient music failed to load: ${failedUrl} — ${message}`);
  };

  public play(track: AmbientTrack, volume: number): void {
    this.projectClips = null;
    this.projectSignature = '';
    this.notifyProgress();
    const nextTrackIndex = getAmbientTrackIndex(track);
    const trackChanged = nextTrackIndex !== this.currentTrackIndex;
    this.currentTrackIndex = nextTrackIndex;
    this.currentVolumePercent = volume;
    this.isEngineRunning = true;

    const audio = this.getAudio();
    audio.loop = true;
    audio.playbackRate = 1;
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    if (trackChanged) audio.pause();
    this.startPlayback();
  }

  public playProject(clips: readonly MusicClip[], loop: boolean, volume: number): void {
    const available = clips.filter((clip) => Boolean(musicClipUrl(clip)));
    if (available.length === 0) {
      this.stop();
      this.setLoadError('', 'Saved mix needs at least one available track');
      return;
    }
    const signature = musicProjectSignature(available, loop);
    const changed = signature !== this.projectSignature;
    this.projectClips = available.map((clip) => ({ ...clip }));
    this.projectLoop = loop;
    this.currentVolumePercent = volume;
    this.isEngineRunning = true;
    this.getAudio().volume = Math.max(0, Math.min(1, volume / 100));
    if (changed) {
      this.projectSignature = signature;
      this.projectIndex = 0;
      this.getAudio().pause();
      this.startProjectClip();
    } else if (this.getAudio().paused) {
      void this.resume();
    }
  }

  /** Start a mix at a chosen clip without changing its saved order. */
  public playProjectAt(
    clips: readonly MusicClip[],
    loop: boolean,
    volume: number,
    index: number,
  ): void {
    const available = clips.filter((clip) => Boolean(musicClipUrl(clip)));
    if (available.length === 0) {
      this.playProject(clips, loop, volume);
      return;
    }
    this.projectClips = available.map((clip) => ({ ...clip }));
    this.projectLoop = loop;
    this.projectSignature = musicProjectSignature(available, loop);
    this.projectIndex =
      ((Math.trunc(index) % available.length) + available.length) % available.length;
    this.currentVolumePercent = volume;
    this.isEngineRunning = true;
    this.getAudio().volume = Math.max(0, Math.min(1, volume / 100));
    this.getAudio().pause();
    this.startProjectClip();
  }

  public pause(): void {
    this.playbackAttempt += 1;
    this.isEngineRunning = false;
    this.audio?.pause();
    this.setLoadStatus({ state: 'idle' });
    this.notifyProgress();
  }

  public stop(): void {
    this.playbackAttempt += 1;
    this.isEngineRunning = false;
    this.setLoadStatus({ state: 'idle' });
    if (!this.audio) return;
    this.audio.pause();
  }

  public setVolume(volume: number): void {
    this.currentVolumePercent = volume;
    if (this.audio) {
      this.audio.volume = Math.max(0, Math.min(1, volume / 100));
    }
  }

  public seek(seconds: number): boolean {
    if (!this.audio || !this.projectClips?.length || !Number.isFinite(seconds)) return false;
    const clip = this.currentProjectClip();
    if (!clip) return false;
    const mediaEnd = Number.isFinite(this.audio.duration)
      ? this.audio.duration
      : Number.POSITIVE_INFINITY;
    const playableEnd = Math.min(clip.trimEnd ?? mediaEnd, mediaEnd);
    this.audio.currentTime = Math.max(clip.trimStart, Math.min(seconds, playableEnd));
    this.notifyProgress();
    return true;
  }

  public setTrack(track: AmbientTrack): void {
    this.projectClips = null;
    this.projectSignature = '';
    this.currentTrackIndex = getAmbientTrackIndex(track);
    if (this.isEngineRunning) {
      this.getAudio().pause();
      this.startPlayback();
    }
  }

  public async resume(): Promise<void> {
    if (!this.isEngineRunning) return;
    this.setLoadStatus({ state: 'idle' });
    this.getAudio().volume = Math.max(0, Math.min(1, this.currentVolumePercent / 100));
    const attempt = ++this.playbackAttempt;
    const url = this.projectClips
      ? (musicClipUrl(this.currentProjectClip()!) ?? '')
      : this.currentTrackDef().url;
    try {
      await this.getAudio().play();
      if (attempt === this.playbackAttempt && this.isEngineRunning) this.markPlaying(url);
    } catch (err: unknown) {
      if (attempt !== this.playbackAttempt) return;
      const message = err instanceof Error ? err.message : 'Playback blocked until user gesture';
      this.stop();
      this.setLoadError(url, message);
      console.warn('Ambient music playback is waiting for a user gesture:', err);
    }
  }

  public isPlaying(): boolean {
    return this.isEngineRunning && Boolean(this.audio && !this.audio.paused);
  }

  public dispose(): void {
    this.stop();
    this.projectClips = null;
    this.projectSignature = '';
    this.projectIndex = 0;
    if (!this.audio) return;
    this.audio.removeEventListener('error', this.handleTrackError);
    this.audio.removeEventListener('ended', this.handleEnded);
    this.audio.removeEventListener('timeupdate', this.handleTimeUpdate);
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio = null;
    this.listeners.clear();
    this.statusListeners.clear();
    this.progressListeners.clear();
  }
}
