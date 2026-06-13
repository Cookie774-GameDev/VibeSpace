/**
 * Single routing layer for in-app voice output (preview + replies).
 * Mirrors auth `voiceEngine` / `voicePreset` so Settings, voice panel, and
 * runtime always speak through the same path.
 */
import type { VoiceEngine, VoicePresetId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
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

let activePlaybackAbort: AbortController | null = null;
let activeStreamingSession: StreamingVoiceSession | null = null;

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
}

export async function speakWithSettings(
  text: string,
  options: SpeakWithSettingsOptions = {},
): Promise<void> {
  const trimmed = (options.text ?? text).trim();
  if (!trimmed) return;

  const state = useAuthStore.getState();
  const engine = options.voiceEngine ?? state.voiceEngine ?? 'system';
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
        await speakText(trimmed, { voicePreset, engine: 'system' });
        return;
      }
    }
    const controller = beginPlaybackAbortScope();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const { audio, mime } = await synthesizeKokoroPhrase(trimmed, ttsPreset);
      if (controller.signal.aborted) return;
      await playBase64Audio(audio, mime || 'audio/wav', {
        volume: 1,
        signal: controller.signal,
      });
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

  const engine = voiceEngine ?? useAuthStore.getState().voiceEngine ?? 'system';
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
