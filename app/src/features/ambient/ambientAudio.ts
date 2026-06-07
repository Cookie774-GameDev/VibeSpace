import type { AmbientTrack } from '@/stores/ui';
import { AMBIENT_TRACKS, getAmbientTrackIndex } from './tracks';

export class AmbientAudioEngine {
  private static instance: AmbientAudioEngine | null = null;
  private audio: HTMLAudioElement | null = null;
  private currentTrackIndex = 0;
  private isEngineRunning = false;
  private currentVolumePercent = 40;

  private constructor() {}

  public static getInstance(): AmbientAudioEngine {
    if (!AmbientAudioEngine.instance) {
      AmbientAudioEngine.instance = new AmbientAudioEngine();
    }
    return AmbientAudioEngine.instance;
  }

  private getAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.audio.addEventListener('ended', this.playNextTrack);
      this.audio.addEventListener('error', this.handleTrackError);
    }
    return this.audio;
  }

  private loadCurrentTrack(): void {
    const audio = this.getAudio();
    const track = AMBIENT_TRACKS[this.currentTrackIndex] ?? AMBIENT_TRACKS[0];
    if (audio.src !== track.url) {
      audio.src = track.url;
      audio.load();
    }
  }

  private startPlayback(): void {
    if (!this.isEngineRunning) return;
    this.loadCurrentTrack();
    void this.getAudio().play().catch((err) => {
      console.warn('Ambient music playback is waiting for a user gesture:', err);
    });
  }

  private playNextTrack = (): void => {
    this.currentTrackIndex = (this.currentTrackIndex + 1) % AMBIENT_TRACKS.length;
    this.startPlayback();
  };

  private handleTrackError = (): void => {
    const failedTrack = AMBIENT_TRACKS[this.currentTrackIndex];
    console.warn(`Ambient music failed to load: ${failedTrack?.url ?? 'unknown track'}`);
  };

  public play(track: AmbientTrack, volume: number): void {
    const nextTrackIndex = getAmbientTrackIndex(track);
    const trackChanged = nextTrackIndex !== this.currentTrackIndex;
    this.currentTrackIndex = nextTrackIndex;
    this.currentVolumePercent = volume;
    this.isEngineRunning = true;

    const audio = this.getAudio();
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    if (trackChanged) audio.pause();
    this.startPlayback();
  }

  public stop(): void {
    this.isEngineRunning = false;
    if (!this.audio) return;
    this.audio.pause();
  }

  public setVolume(volume: number): void {
    this.currentVolumePercent = volume;
    if (this.audio) {
      this.audio.volume = Math.max(0, Math.min(1, volume / 100));
    }
  }

  public setTrack(track: AmbientTrack): void {
    this.currentTrackIndex = getAmbientTrackIndex(track);
    if (this.isEngineRunning) {
      this.getAudio().pause();
      this.startPlayback();
    }
  }

  public async resume(): Promise<void> {
    if (!this.isEngineRunning) return;
    this.getAudio().volume = Math.max(0, Math.min(1, this.currentVolumePercent / 100));
    try {
      await this.getAudio().play();
    } catch (err) {
      console.warn('Ambient music playback is waiting for a user gesture:', err);
    }
  }

  public isPlaying(): boolean {
    return this.isEngineRunning && Boolean(this.audio && !this.audio.paused);
  }

  public dispose(): void {
    this.stop();
    if (!this.audio) return;
    this.audio.removeEventListener('ended', this.playNextTrack);
    this.audio.removeEventListener('error', this.handleTrackError);
    this.audio.removeAttribute('src');
    this.audio.load();
    this.audio = null;
  }
}
