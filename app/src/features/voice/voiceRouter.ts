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
const JARVIS_ACK_ASSET = '/voice/jarvis-on-it.wav';
let bundledPreviewAudio: HTMLAudioElement | null = null;
let bundledAcknowledgmentAudio: HTMLAudioElement | null = null;

/** Monotonic session id — bumped when the voice module opens; zeroed on close. */
let activeVoiceSessionId = 0;
let voiceModuleMarkedOpen = false;

export function getActiveVoiceSessionId(): number {
  return activeVoiceSessionId;
}

/** True while the voice panel is open, or Settings "speak replies" is enabled for chat. */
export function canVoiceModuleSpeak(): boolean {
  if (useAuthStore.getState().speakReplies === true) return true;
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
      // Warm only the selected engine. Actual speech owns failure reporting;
      // an optional warmup must not reject into the window's error handler.
      void warmVoiceEngine(useAuthStore.getState().voiceEngine ?? 'jarvis').catch(() => undefined);
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
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  try {
    await speakText(text, { voicePreset, engine: 'local' });
  } catch {
    if (signal?.aborted) return;
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

async function getCachedJarvisAudio(
  text: string,
  preset: VoiceTtsPreset,
  signal?: AbortSignal,
): Promise<{ audio: string; mime: string }> {
  if (signal?.aborted) throw new Error('jarvis_speech_cancelled');
  const key = `${preset}:${text}`;
  let pending = jarvisAudioCache.get(key);
  if (!pending) {
    const invoke = await import('@tauri-apps/api/core')
      .then((m) => m.invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>)
      .catch(() => null);
    if (signal?.aborted) throw new Error('jarvis_speech_cancelled');
    if (!invoke) throw new Error('jarvis_voice_unavailable');

    // Cache only admitted synthesis; a stopped importer must not occupy a newer request's slot.
    pending = jarvisAudioCache.get(key);
    if (!pending) {
      const admitted = invoke<{ audio: string; mime: string }>('jarvis_voice_speak', {
        text,
        speed: 1,
      });
      pending = admitted;
      jarvisAudioCache.set(key, admitted);
      trimJarvisCache();
      admitted.catch(() => {
        if (jarvisAudioCache.get(key) === admitted) jarvisAudioCache.delete(key);
      });
    }
  }
  return pending;
}

export async function ensureJarvisReadyForSpeech(
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const available = await jarvisHighLocalProvider.isAvailable();
  if (signal?.aborted) return false;
  if (available) {
    await jarvisHighLocalProvider.warmup?.();
    return !signal?.aborted;
  }
  const ok = await ModelManager.ensureJarvisReady((p) => onProgress?.(p.percent));
  if (!ok || signal?.aborted) return false;
  await jarvisHighLocalProvider.warmup?.();
  if (signal?.aborted) return false;
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
  bundledAcknowledgmentAudio?.pause();
  bundledAcknowledgmentAudio = null;
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
  const closingSessionId = useVoiceStore.getState().session?.sessionId;
  const cancellation = stopCurrentVoiceResponse();
  VoiceService.stopListening();
  useUIStore.getState().setVoiceListening(false);
  useVoiceStore.getState().setPartialTranscript('');
  useVoiceStore.getState().setState('idle');
  void cancellation.then(
    () => closingSessionId && useVoiceStore.getState().endSession(closingSessionId),
    () => closingSessionId && useVoiceStore.getState().endSession(closingSessionId),
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
      return ensureJarvisReadyForSpeech(undefined, this.controller.signal);
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
          return getCachedJarvisAudio(next.text, this.ttsPreset, this.controller.signal);
        })
        .finally(() => {
          this.inFlightSynth = Math.max(0, this.inFlightSynth - 1);
          this.pumpSynthesis();
          this.wake();
        });
      // Stop can retire queued audio before playback awaits it. Observe its rejection
      // now, while preserving the original promise for the active playback fallback.
      void next.audio.catch(() => {});
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
        await speakInstalledVoiceFallback(item.text, this.voicePreset, this.controller.signal);
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
  if (!trimmed || options.signal?.aborted) return;
  if (!options.allowBackground && !canVoiceModuleSpeak()) return;

  const state = useAuthStore.getState();
  const engine = options.voiceEngine ?? state.voiceEngine ?? 'jarvis';
  const voicePreset = options.voicePreset ?? state.voicePreset ?? 'jarvis-prime';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);
  // Stop must revoke the request while readiness is still pending, before playback exists.
  const controller = beginPlaybackAbortScope();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    if (trimmed === 'On it.' && engine === 'jarvis' && voicePreset === 'jarvis-prime') {
      bundledAcknowledgmentAudio?.pause();
      const audio = new Audio(JARVIS_ACK_ASSET);
      bundledAcknowledgmentAudio = audio;
      const stop = () => audio.pause();
      controller.signal.addEventListener('abort', stop, { once: true });
      try {
        await audio.play();
        return;
      } catch {
        if (controller.signal.aborted) return;
        // Preserve the selected engine's generated speech fallback.
      } finally {
        controller.signal.removeEventListener('abort', stop);
      }
    }

    if (engine === 'deepgram') {
      TtsService.setProvider('deepgram_tts');
      TtsService.setVoicePreset(ttsPreset);
      await TtsService.speak(trimmed, { failureMode: 'reject' });
      return;
    }

    if (engine === 'jarvis') {
      if (voicePreset === 'aurora') {
        await speakInstalledVoiceFallback(trimmed, voicePreset, controller.signal);
        return;
      }
      if (!(await jarvisHighLocalProvider.isAvailable())) {
        if (controller.signal.aborted) return;
        const ready = await ensureJarvisReadyForSpeech(undefined, controller.signal);
        if (controller.signal.aborted) return;
        if (!ready) {
          await speakInstalledVoiceFallback(trimmed, voicePreset, controller.signal);
          return;
        }
      }
      if (controller.signal.aborted) return;
      try {
        const { audio, mime } = await getCachedJarvisAudio(trimmed, ttsPreset, controller.signal);
        if (controller.signal.aborted) return;
        await playBase64Audio(audio, mime || 'audio/wav', {
          volume: 1,
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) return;
        await speakInstalledVoiceFallback(trimmed, voicePreset, controller.signal);
      }
      return;
    }

    await speakText(trimmed, { voicePreset, engine });
  } finally {
    options.signal?.removeEventListener('abort', abort);
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
