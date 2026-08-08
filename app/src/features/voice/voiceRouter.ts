/**
 * Single routing layer for in-app voice output (preview + replies).
 * Mirrors auth `voiceEngine` / `voicePreset` so Settings, voice panel, and
 * runtime always speak through the same path.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import { toast } from '@/components/ui/toast';
import { isTauri } from '@/lib/utils';
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
import { jarvisHighLocalProvider } from './providers/jarvisHighLocal';
import { playBase64Audio } from './audioPlayback';
import { ModelManager } from './modelManager';
import { TtsService } from './TtsService';
import { deepgramTtsProvider } from './providers/deepgramTts';
import type { StreamingVoiceSession } from './streamingVoice';
import { VoiceService } from './VoiceService';
import { useVoiceStore } from './store';
import type { JarvisCancellationRequestResult } from '@/lib/jarvis/contracts/execution';

let activePlaybackAbort: AbortController | null = null;
let activeStreamingSession: StreamingVoiceSession | null = null;
type VoiceTurnCancellationHandle = Readonly<{
  requestCancellation(): Promise<JarvisCancellationRequestResult>;
}>;
let activeVoiceTurnCancellation: VoiceTurnCancellationHandle | null = null;
const JARVIS_STREAM_SYNTH_AHEAD = 2;
const JARVIS_PREVIEW_ASSET = '/voice/jarvis-high-preview.mp3';
let bundledPreviewAudio: HTMLAudioElement | null = null;

/** Monotonic session id — bumped when the voice module opens; zeroed on close. */
let activeVoiceSessionId = 0;
let voiceModuleMarkedOpen = false;

export function getActiveVoiceSessionId(): number {
  return activeVoiceSessionId;
}

/** True only while the voice panel is open and its session has not been cancelled. */
export function canVoiceModuleSpeak(): boolean {
  return voiceModuleMarkedOpen && activeVoiceSessionId > 0 && useUIStore.getState().voiceModalOpen;
}

/**
 * Sync voice lifecycle when the panel opens or closes.
 * Idempotent — safe from UI store, lifecycle host, and close handlers.
 */
export function syncVoiceModuleOpenState(isOpen: boolean): void {
  if (isOpen) {
    if (!voiceModuleMarkedOpen) {
      voiceModuleMarkedOpen = true;
      activeVoiceSessionId += 1;
    }
    return;
  }
  handleVoiceModuleClosed();
}

export function registerActiveStreamingVoiceSession(session: StreamingVoiceSession | null): void {
  activeStreamingSession = session;
}

/**
 * Registers the one process-local protected voice-turn handle. The returned
 * disposer can clear only the exact handle it registered.
 */
export function registerActiveVoiceTurnCancellation(
  handle: VoiceTurnCancellationHandle | null,
): () => void {
  if (handle === null) {
    activeVoiceTurnCancellation = null;
    return () => undefined;
  }
  if (activeVoiceTurnCancellation && activeVoiceTurnCancellation !== handle) {
    throw new Error('voice_turn_handle_already_registered');
  }
  activeVoiceTurnCancellation = handle;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (activeVoiceTurnCancellation === handle) activeVoiceTurnCancellation = null;
  };
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

const jarvisAudioCache = new Map<string, Promise<{ audio: string; mime: string }>>();
const JARVIS_CACHE_MAX = 64;

let jarvisBootstrapPromise: Promise<void> | null = null;

/**
 * Background Jarvis High download on desktop launch (non-blocking, idempotent).
 *
 * Not silent when it matters: if Jarvis High is the user's selected voice engine
 * and the model cannot be prepared (download failed, checksum mismatch,
 * engine not compiled), a toast explains that replies will fall back to the
 * installed system voice and points at Settings → Voice to retry. Users on
 * other engines are not nagged - the download stays best-effort for them.
 */
export async function bootstrapJarvisVoiceOnLaunch(): Promise<void> {
  if (jarvisBootstrapPromise) return jarvisBootstrapPromise;
  jarvisBootstrapPromise = (async () => {
    try {
      await import('@tauri-apps/api/core');
    } catch {
      return;
    }
    const ready = await ensureJarvisReadyForSpeech();
    // Only warn inside the real desktop app - the browser preview never has
    // the native bridge, so the toast would be pure noise there.
    if (!ready && isTauri && useAuthStore.getState().voiceEngine === 'jarvis') {
      toast.warning(
        'Jarvis High voice not ready',
        'The local voice model could not be prepared. Jarvis will use the operating-system fallback for now — open Settings → Voice to retry the download.',
      );
    }
  })().catch(() => {
    /* download is best-effort; Windows/local voice remains fallback */
  });
  return jarvisBootstrapPromise;
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

function trimJarvisCache(): void {
  while (jarvisAudioCache.size > JARVIS_CACHE_MAX) {
    const oldest = jarvisAudioCache.keys().next().value;
    if (!oldest) break;
    jarvisAudioCache.delete(oldest);
  }
}

async function synthesizeJarvisPhrase(
  text: string,
  _preset: VoiceTtsPreset,
): Promise<{ audio: string; mime: string }> {
  const invoke = await import('@tauri-apps/api/core')
    .then((m) => m.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
    .catch(() => null);
  if (!invoke) throw new Error('jarvis_voice_unavailable');

  return invoke<{ audio: string; mime: string }>('jarvis_voice_speak', {
    text,
    speed: 1,
  });
}

async function getCachedJarvisAudio(
  text: string,
  preset: VoiceTtsPreset,
): Promise<{ audio: string; mime: string }> {
  const key = `${preset}:${text}`;
  let pending = jarvisAudioCache.get(key);
  if (!pending) {
    pending = synthesizeJarvisPhrase(text, preset);
    jarvisAudioCache.set(key, pending);
    trimJarvisCache();
    pending.catch(() => jarvisAudioCache.delete(key));
  }
  return pending;
}

export async function ensureJarvisReadyForSpeech(
  onProgress?: (percent: number) => void,
): Promise<boolean> {
  if (await jarvisHighLocalProvider.isAvailable()) {
    await jarvisHighLocalProvider.warmup?.();
    return true;
  }
  const ok = await ModelManager.ensureJarvisReady((p) => onProgress?.(p.percent));
  if (!ok) return false;
  await jarvisHighLocalProvider.warmup?.();
  return jarvisHighLocalProvider.isAvailable();
}

/** Pre-synthesize phrases used outside the bundled immediate preview. */
export async function warmJarvisSpeechCache(
  presets: VoiceTtsPreset[] = ['jarvis', 'friday'],
): Promise<void> {
  if (!(await jarvisHighLocalProvider.isAvailable())) return;
  await Promise.all(
    presets.map((preset) =>
      getCachedJarvisAudio(VOICE_PREVIEW_TEXT, preset).catch(() => undefined),
    ),
  );
}

export async function warmVoiceEngine(engine: VoiceEngine): Promise<void> {
  if (engine === 'jarvis') {
    await ensureJarvisReadyForSpeech();
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
  jarvisHighLocalProvider.stop();
  bundledPreviewAudio?.pause();
  bundledPreviewAudio = null;
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

/** Hard stop when the voice panel is dismissed — cuts playback, listening, and in-flight voice AI. */
export function handleVoiceModuleClosed(): void {
  voiceModuleMarkedOpen = false;
  activeVoiceSessionId = 0;
  const cancellation = stopCurrentVoiceResponse();
  VoiceService.stopListening();
  useUIStore.getState().setVoiceListening(false);
  useVoiceStore.getState().setPartialTranscript('');
  useVoiceStore.getState().setState('idle');
  void cancellation.then(
    () => useVoiceStore.getState().endSession(),
    () => useVoiceStore.getState().endSession(),
  );
}

export function stopAllVoiceOutput(): void {
  const streaming = activeStreamingSession;
  activeStreamingSession = null;
  streaming?.haltPlayback();
  stopPlaybackOnly();
}

/**
 * Stop the current spoken reply mid-response WITHOUT closing the voice panel:
 * cancels the in-flight AI run and halts every playback engine so the user
 * can immediately ask something else. Used by the orb's stop control.
 */
export async function stopCurrentVoiceResponse(): Promise<
  JarvisCancellationRequestResult | undefined
> {
  const cancellation = activeVoiceTurnCancellation?.requestCancellation();
  stopAllVoiceOutput();
  return cancellation;
}

export interface SpeakWithSettingsOptions {
  voiceEngine?: VoiceEngine;
  voicePreset?: VoicePresetId;
  text?: string;
  signal?: AbortSignal;
  /** When true, speak even if the voice modal is closed (e.g. chat speak-replies). */
  allowBackground?: boolean;
}

interface JarvisStreamItem {
  text: string;
  audio?: Promise<{ audio: string; mime: string }>;
}

export interface JarvisStreamingPlayer {
  enqueue(text: string): void;
  complete(): Promise<void>;
  stop(): void;
}

class JarvisStreamingPlayerImpl implements JarvisStreamingPlayer {
  private readonly ttsPreset: VoiceTtsPreset;
  private readonly voicePreset: VoicePresetId;
  private readonly controller = new AbortController();
  private readonly items: JarvisStreamItem[] = [];
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
      if (await jarvisHighLocalProvider.isAvailable()) return true;
      return ensureJarvisReadyForSpeech();
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
    jarvisHighLocalProvider.stop();
    stopSpeech();
  }

  private ensurePlaybackLoop(): void {
    if (!this.playbackLoop) {
      this.playbackLoop = this.playQueuedAudio();
    }
  }

  private pumpSynthesis(): void {
    while (!this.stopped && this.inFlightSynth < JARVIS_STREAM_SYNTH_AHEAD) {
      const next = this.items.find((item) => !item.audio);
      if (!next) return;
      this.inFlightSynth += 1;
      next.audio = this.ready
        .then((ready) => {
          if (!ready) throw new Error('jarvis_voice_unavailable');
          return getCachedJarvisAudio(next.text, this.ttsPreset);
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

export function createJarvisStreamingPlayer(voicePreset: VoicePresetId): JarvisStreamingPlayer {
  return new JarvisStreamingPlayerImpl(voicePreset);
}

export async function speakWithSettings(
  text: string,
  options: SpeakWithSettingsOptions = {},
): Promise<void> {
  const trimmed = (options.text ?? text).trim();
  if (!trimmed) return;
  if (!options.allowBackground && !canVoiceModuleSpeak()) return;

  const state = useAuthStore.getState();
  const engine = options.voiceEngine ?? state.voiceEngine ?? 'jarvis';
  const voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);

  if (engine === 'deepgram') {
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset(ttsPreset);
    await TtsService.speak(trimmed);
    return;
  }

  if (engine === 'jarvis') {
    if (voicePreset === 'aurora') {
      await speakInstalledVoiceFallback(trimmed, voicePreset);
      return;
    }
    if (!(await jarvisHighLocalProvider.isAvailable())) {
      const ready = await ensureJarvisReadyForSpeech();
      if (!ready) {
        await speakInstalledVoiceFallback(trimmed, voicePreset);
        return;
      }
    }
    const controller = beginPlaybackAbortScope();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const { audio, mime } = await getCachedJarvisAudio(trimmed, ttsPreset);
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

  const engine = voiceEngine ?? useAuthStore.getState().voiceEngine ?? 'jarvis';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);

  if (engine === 'deepgram') {
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset(ttsPreset);
    if (!(await deepgramTtsProvider.isAvailable())) {
      if (stale()) return;
      throw new Error(
        'Sign in to use launch Deepgram cloud voice, or add your own API key in Settings → Voice.',
      );
    }
    if (stale()) return;
    await TtsService.testVoice(ttsPreset);
    if (stale()) TtsService.stop();
    return;
  }

  if (engine === 'jarvis' && voicePreset === 'jarvis-prime') {
    const audio = new Audio(JARVIS_PREVIEW_ASSET);
    bundledPreviewAudio = audio;
    await audio.play();
    if (stale()) audio.pause();
    return;
  }

  if (engine === 'jarvis' && voicePreset === 'aurora') {
    if (stale()) return;
    await speakInstalledVoiceFallback(VOICE_PREVIEW_TEXT, voicePreset);
    if (stale()) stopSpeech();
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
