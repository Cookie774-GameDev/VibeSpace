/**
 * Single routing layer for in-app voice output (preview + replies).
 * Mirrors auth `voiceEngine` / `voicePreset` so Settings, voice panel, and
 * runtime always speak through the same path.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import type { VoiceTtsPreset } from './voicePlans';
import {
  isSpeechSynthesisSupported,
  speakText,
  stopSpeech,
  VOICE_PREVIEW_TEXT,
  preloadSpeechVoices,
} from './speechSynthesis';
import { kokoroLocalProvider } from './providers/kokoroLocal';
import { playBase64Audio } from './audioPlayback';
import { ModelManager } from './modelManager';
import { VOICE_PRESETS } from './voicePlans';
import { resolveKokoroSpeed } from './speechRate';
import { TtsService } from './TtsService';
import { deepgramTtsProvider } from './providers/deepgramTts';
import type { StreamingVoiceSession } from './streamingVoice';
import { VoiceService } from './VoiceService';
import { useVoiceStore } from './store';

let activePlaybackAbort: AbortController | null = null;
let activeStreamingSession: StreamingVoiceSession | null = null;
const KOKORO_STREAM_SYNTH_AHEAD = 2;

export function registerActiveStreamingVoiceSession(
  session: StreamingVoiceSession | null,
): void {
  activeStreamingSession = session;
}

function beginPlaybackAbortScope(): AbortController {
  activePlaybackAbort?.abort();
  const controller = new AbortController();
  activePlaybackAbort = controller;
  return controller;
}

function endPlaybackAbortScope(controller: AbortController): void {
  if (activePlaybackAbort === controller) activePlaybackAbort = null;
}

export function voicePresetToTtsPreset(preset: VoicePresetId): VoiceTtsPreset {
  return preset === 'aurora' ? 'friday' : 'jarvis';
}

const kokoroAudioCache = new Map<string, Promise<{ audio: string; mime: string }>>();
const KOKORO_CACHE_MAX = 64;

let kokoroBootstrapPromise: Promise<void> | null = null;

/** Background Kokoro download on desktop launch (non-blocking, idempotent). */
export async function bootstrapKokoroVoiceOnLaunch(): Promise<void> {
  if (kokoroBootstrapPromise) return kokoroBootstrapPromise;
  kokoroBootstrapPromise = (async () => {
    try {
      await import('@tauri-apps/api/core');
    } catch {
      return;
    }
    await ensureKokoroReadyForSpeech();
  })().catch(() => {
    /* download is best-effort; Windows/local voice remains fallback */
  });
  return kokoroBootstrapPromise;
}

async function speakInstalledVoiceFallback(
  text: string,
  voicePreset: VoicePresetId,
): Promise<void> {
  try {
    await speakText(text, { voicePreset, engine: 'local' });
  } catch {
    await speakText(text, { voicePreset, engine: 'system' });
  }
}

function trimKokoroCache(): void {
  while (kokoroAudioCache.size > KOKORO_CACHE_MAX) {
    const oldest = kokoroAudioCache.keys().next().value;
    if (!oldest) break;
    kokoroAudioCache.delete(oldest);
  }
}

async function synthesizeKokoroPhrase(
  text: string,
  preset: VoiceTtsPreset,
): Promise<{ audio: string; mime: string }> {
  const invoke = await import('@tauri-apps/api/core')
    .then((m) => m.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
    .catch(() => null);
  if (!invoke) throw new Error('kokoro_unavailable');

  const voicePreset = VOICE_PRESETS[preset];
  return invoke<{ audio: string; mime: string }>('kokoro_speak', {
    text,
    voice: voicePreset.kokoroVoice,
    speed: resolveKokoroSpeed(voicePreset.speed),
  });
}

async function getCachedKokoroAudio(
  text: string,
  preset: VoiceTtsPreset,
): Promise<{ audio: string; mime: string }> {
  const key = `${preset}:${text}`;
  let pending = kokoroAudioCache.get(key);
  if (!pending) {
    pending = synthesizeKokoroPhrase(text, preset);
    kokoroAudioCache.set(key, pending);
    trimKokoroCache();
    pending.catch(() => kokoroAudioCache.delete(key));
  }
  return pending;
}

export async function ensureKokoroReadyForSpeech(
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (await kokoroLocalProvider.isAvailable()) {
    await kokoroLocalProvider.warmup?.();
    return true;
  }
  const ok = await ModelManager.ensureKokoroReady((p) => onProgress?.(p.percent));
  if (!ok) return false;
  await kokoroLocalProvider.warmup?.();
  return kokoroLocalProvider.isAvailable();
}

/** Pre-synthesize Kokoro preview clips so Preview plays instantly. */
export async function warmKokoroPreviewCache(presets: VoiceTtsPreset[] = ['jarvis', 'friday']): Promise<void> {
  if (!(await kokoroLocalProvider.isAvailable())) return;
  await Promise.all(
    presets.map((preset) => getCachedKokoroAudio(VOICE_PREVIEW_TEXT, preset).catch(() => undefined)),
  );
}

export async function warmVoiceEngine(engine: VoiceEngine): Promise<void> {
  if (engine === 'kokoro') {
    if (await ensureKokoroReadyForSpeech()) {
      await warmKokoroPreviewCache();
    }
    return;
  }
  if (engine === 'system' || engine === 'local') {
    await preloadSpeechVoices(engine);
  }
  if (engine === 'deepgram') {
    TtsService.setProvider('deepgram_tts');
    await TtsService.warmup();
  }
}

function stopPlaybackOnly(): void {
  activePlaybackAbort?.abort();
  activePlaybackAbort = null;
  stopSpeech();
  TtsService.stop();
  kokoroLocalProvider.stop();
}

/** Bumped on every new preview or explicit cancel — in-flight previews check this. */
let voicePreviewGeneration = 0;

/** Stop any preview immediately (e.g. before switching voice engine). */
export function cancelVoicePreview(): void {
  voicePreviewGeneration += 1;
  stopPlaybackOnly();
}

export function isVoiceModuleOpen(): boolean {
  return useUIStore.getState().voiceModalOpen;
}

/** Hard stop when the voice panel is dismissed — cuts playback and listening. */
export function handleVoiceModuleClosed(): void {
  stopAllVoiceOutput();
  VoiceService.stopListening();
  useUIStore.getState().setVoiceListening(false);
  useVoiceStore.getState().setPartialTranscript('');
  useVoiceStore.getState().setState('idle');
}

export function stopAllVoiceOutput(): void {
  const streaming = activeStreamingSession;
  activeStreamingSession = null;
  streaming?.haltPlayback();
  stopPlaybackOnly();
}

export interface SpeakWithSettingsOptions {
  voiceEngine?: VoiceEngine;
  voicePreset?: VoicePresetId;
  text?: string;
  signal?: AbortSignal;
  /** When true, speak even if the voice modal is closed (e.g. chat speak-replies). */
  allowBackground?: boolean;
}

interface KokoroStreamItem {
  text: string;
  audio?: Promise<{ audio: string; mime: string }>;
}

export interface KokoroStreamingPlayer {
  enqueue(text: string): void;
  complete(): Promise<void>;
  stop(): void;
}

class KokoroStreamingPlayerImpl implements KokoroStreamingPlayer {
  private readonly ttsPreset: VoiceTtsPreset;
  private readonly voicePreset: VoicePresetId;
  private readonly controller = new AbortController();
  private readonly items: KokoroStreamItem[] = [];
  private readonly ready: Promise<boolean>;
  private playbackLoop: Promise<void> | null = null;
  private wakePlayback: (() => void) | null = null;
  private completing = false;
  private stopped = false;
  private inFlightSynth = 0;

  constructor(voicePreset: VoicePresetId) {
    this.voicePreset = voicePreset;
    this.ttsPreset = voicePresetToTtsPreset(voicePreset);
    this.ready = (async () => {
      if (await kokoroLocalProvider.isAvailable()) return true;
      return ensureKokoroReadyForSpeech();
    })();
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.stopped) return;
    this.items.push({ text: trimmed });
    this.pumpSynthesis();
    this.ensurePlaybackLoop();
    this.wake();
  }

  async complete(): Promise<void> {
    this.completing = true;
    this.ensurePlaybackLoop();
    this.wake();
    await this.playbackLoop;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.items.length = 0;
    this.wake();
    kokoroLocalProvider.stop();
    stopSpeech();
  }

  private ensurePlaybackLoop(): void {
    if (!this.playbackLoop) {
      this.playbackLoop = this.playQueuedAudio();
    }
  }

  private pumpSynthesis(): void {
    while (!this.stopped && this.inFlightSynth < KOKORO_STREAM_SYNTH_AHEAD) {
      const next = this.items.find((item) => !item.audio);
      if (!next) return;
      this.inFlightSynth += 1;
      next.audio = this.ready
        .then((ready) => {
          if (!ready) throw new Error('kokoro_unavailable');
          return getCachedKokoroAudio(next.text, this.ttsPreset);
        })
        .finally(() => {
          this.inFlightSynth = Math.max(0, this.inFlightSynth - 1);
          this.pumpSynthesis();
          this.wake();
        });
    }
  }

  private async playQueuedAudio(): Promise<void> {
    while (!this.stopped) {
      const item = this.items[0];
      if (!item) {
        if (this.completing) return;
        await this.waitForWork();
        continue;
      }

      this.pumpSynthesis();
      if (!item.audio) {
        await this.waitForWork();
        continue;
      }
      const audio = item.audio;
      try {
        const result = await audio;
        if (this.stopped || this.controller.signal.aborted) return;
        await playBase64Audio(result.audio, result.mime || 'audio/wav', {
          volume: 1,
          signal: this.controller.signal,
        });
      } catch {
        if (this.stopped || this.controller.signal.aborted) return;
        await speakInstalledVoiceFallback(item.text, this.voicePreset);
      } finally {
        if (this.items[0] === item) this.items.shift();
        this.pumpSynthesis();
      }
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      this.wakePlayback = resolve;
    });
  }

  private wake(): void {
    const wake = this.wakePlayback;
    this.wakePlayback = null;
    wake?.();
  }
}

export function createKokoroStreamingPlayer(
  voicePreset: VoicePresetId,
): KokoroStreamingPlayer {
  return new KokoroStreamingPlayerImpl(voicePreset);
}

export async function speakWithSettings(
  text: string,
  options: SpeakWithSettingsOptions = {},
): Promise<void> {
  const trimmed = (options.text ?? text).trim();
  if (!trimmed) return;
  if (!options.allowBackground && !isVoiceModuleOpen()) return;

  const state = useAuthStore.getState();
  const engine = options.voiceEngine ?? state.voiceEngine ?? 'kokoro';
  const voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);

  if (engine === 'deepgram') {
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset(ttsPreset);
    await TtsService.speak(trimmed);
    return;
  }

  if (engine === 'kokoro') {
    if (!(await kokoroLocalProvider.isAvailable())) {
      const ready = await ensureKokoroReadyForSpeech();
      if (!ready) {
        await speakInstalledVoiceFallback(trimmed, voicePreset);
        return;
      }
    }
    const controller = beginPlaybackAbortScope();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const { audio, mime } = await getCachedKokoroAudio(trimmed, ttsPreset);
      if (controller.signal.aborted) return;
      await playBase64Audio(audio, mime || 'audio/wav', {
        volume: 1,
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) return;
      await speakInstalledVoiceFallback(trimmed, voicePreset);
    } finally {
      endPlaybackAbortScope(controller);
    }
    return;
  }

  const controller = beginPlaybackAbortScope();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    await speakText(trimmed, { voicePreset, engine });
  } finally {
    endPlaybackAbortScope(controller);
  }
}

export async function previewVoiceWithSettings(
  voicePreset: VoicePresetId,
  voiceEngine?: VoiceEngine,
): Promise<void> {
  const generation = ++voicePreviewGeneration;
  stopAllVoiceOutput();
  const stale = () => generation !== voicePreviewGeneration;

  const engine = voiceEngine ?? useAuthStore.getState().voiceEngine ?? 'kokoro';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);

  if (engine === 'deepgram') {
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset(ttsPreset);
    if (!(await deepgramTtsProvider.isAvailable())) {
      if (stale()) return;
      throw new Error('Sign in to use launch Deepgram cloud voice, or add your own API key in Settings → Voice.');
    }
    if (stale()) return;
    await TtsService.testVoice(ttsPreset);
    if (stale()) TtsService.stop();
    return;
  }

  if (engine === 'kokoro') {
    if (!(await kokoroLocalProvider.isAvailable())) {
      const ready = await ensureKokoroReadyForSpeech();
      if (stale()) return;
      if (!ready) {
        throw new Error('Kokoro is not ready. Download the model first.');
      }
    }
    if (stale()) return;
    const { audio, mime } = await getCachedKokoroAudio(VOICE_PREVIEW_TEXT, ttsPreset);
    if (stale()) return;
    const controller = beginPlaybackAbortScope();
    try {
      await playBase64Audio(audio, mime || 'audio/wav', { volume: 1, signal: controller.signal });
    } finally {
      endPlaybackAbortScope(controller);
      if (stale()) kokoroLocalProvider.stop();
    }
    return;
  }

  if (!isSpeechSynthesisSupported()) {
    throw new Error('Speech synthesis is not available in this runtime.');
  }
  if (stale()) return;
  const controller = beginPlaybackAbortScope();
  try {
    await speakText(VOICE_PREVIEW_TEXT, { voicePreset, engine });
    if (stale()) stopSpeech();
  } finally {
    endPlaybackAbortScope(controller);
  }
}
