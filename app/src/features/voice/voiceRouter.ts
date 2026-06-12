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
import { TtsService } from './TtsService';
import { getDeepgramVoiceKey } from '@/lib/security/voiceKeys';

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
    speed: voicePreset.speed,
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

export function stopAllVoiceOutput(): void {
  stopSpeech();
  void import('./TtsService')
    .then(({ TtsService }) => TtsService.stop())
    .catch(() => {});
  kokoroLocalProvider.stop();
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
    const key = await getDeepgramVoiceKey();
    if (key) {
      TtsService.setProvider('deepgram_tts');
      TtsService.setVoicePreset(ttsPreset);
      await TtsService.speak(trimmed);
      return;
    }
  }

  if (engine === 'kokoro') {
    if (!(await kokoroLocalProvider.isAvailable())) {
      const ready = await ensureKokoroReadyForSpeech();
      if (!ready) {
        await speakText(trimmed, { voicePreset, engine: 'system' });
        return;
      }
    }
    const controller = new AbortController();
    options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    const { audio, mime } = await synthesizeKokoroPhrase(trimmed, ttsPreset);
    if (controller.signal.aborted) return;
    await playBase64Audio(audio, mime || 'audio/wav', {
      volume: 1,
      signal: controller.signal,
    });
    return;
  }

  await speakText(trimmed, { voicePreset, engine });
}

export async function previewVoiceWithSettings(
  voicePreset: VoicePresetId,
  voiceEngine?: VoiceEngine,
): Promise<void> {
  stopAllVoiceOutput();
  const engine = voiceEngine ?? useAuthStore.getState().voiceEngine ?? 'system';
  const ttsPreset = voicePresetToTtsPreset(voicePreset);

  if (engine === 'deepgram') {
    const key = await getDeepgramVoiceKey();
    if (!key) throw new Error('Add your Deepgram API key in Settings → Voice first.');
    TtsService.setProvider('deepgram_tts');
    TtsService.setVoicePreset(ttsPreset);
    await TtsService.testVoice(ttsPreset);
    return;
  }

  if (engine === 'kokoro') {
    if (!(await kokoroLocalProvider.isAvailable())) {
      const ready = await ensureKokoroReadyForSpeech();
      if (!ready) {
        throw new Error('Kokoro is not ready. Download the model first.');
      }
    }
    const { audio, mime } = await getCachedKokoroAudio(VOICE_PREVIEW_TEXT, ttsPreset);
    const controller = new AbortController();
    await playBase64Audio(audio, mime || 'audio/wav', { volume: 1, signal: controller.signal });
    return;
  }

  if (!isSpeechSynthesisSupported()) {
    throw new Error('Speech synthesis is not available in this runtime.');
  }
  await speakText(VOICE_PREVIEW_TEXT, { voicePreset, engine });
}
