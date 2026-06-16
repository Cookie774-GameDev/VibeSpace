/**
 * Composer toolbar mic — speech-to-text routing.
 *
 * Separate from Jarvis voice module / wake word / phone voice.
 * Provider choice lives in auth store (Settings → Speech to Text).
 */

import { VoiceService } from '@/features/voice/VoiceService';
import { useAuthStore } from '@/stores/auth';
import { isTauri } from '@/lib/utils';
import type { ComposerSttProvider, FasterWhisperModelId } from '@/types/common';
import { FasterWhisperManager } from './fasterWhisperManager';
import { cleanupAudioRecorder, encodeWav, getAudioContextCtor } from './audio';

export const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
export const STT_INACTIVITY_MS = 30_000;
export const STT_ACTIVITY_RMS = 0.015;

export function getComposerSttProvider(): ComposerSttProvider {
  return useAuthStore.getState().composerSttProvider ?? 'system';
}

export function getFasterWhisperModel(): FasterWhisperModelId {
  return useAuthStore.getState().fasterWhisperModel ?? 'small';
}

export function isSystemSttAvailable(): boolean {
  return VoiceService.isSupported();
}

export async function triggerWindowsNativeDictation(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('trigger_os_dictation');
    return true;
  } catch {
    return false;
  }
}

export async function transcribeGroq(blob: Blob, apiKey: string): Promise<string> {
  if (blob.size === 0 || !apiKey) return '';
  const form = new FormData();
  form.set('file', new File([blob], 'jarvis-dictation.wav', { type: 'audio/wav' }));
  form.set('model', GROQ_STT_MODEL);
  form.set('response_format', 'json');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Groq STT ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}

export async function transcribeFasterWhisper(blob: Blob, modelId: FasterWhisperModelId): Promise<string> {
  return FasterWhisperManager.transcribe(modelId, blob);
}

export interface FasterWhisperRecorder {
  captureWav: () => Blob | null;
  stop: () => void;
}

/** Record microphone audio for batch transcription (faster-whisper / Groq path). */
export async function startBatchAudioRecorder(
  onVolume: (rms: number) => void,
  onInactivity: () => void,
): Promise<FasterWhisperRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Float32Array[] = [];
  const AudioCtor = getAudioContextCtor();
  if (!AudioCtor) throw new Error('Audio recording is not available in this runtime.');

  const context = new AudioCtor();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  let lastActivity = Date.now();

  processor.onaudioprocess = (event) => {
    const channel = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const sample = channel[i] ?? 0;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / Math.max(1, channel.length));
    if (rms > STT_ACTIVITY_RMS) lastActivity = Date.now();
    onVolume(Math.min(1, rms * 8));
    chunks.push(new Float32Array(channel));
  };

  source.connect(processor);
  processor.connect(context.destination);

  const inactivityTimer = window.setInterval(() => {
    if (Date.now() - lastActivity >= STT_INACTIVITY_MS) onInactivity();
  }, 1000);

  const teardown = () => {
    window.clearInterval(inactivityTimer);
    cleanupAudioRecorder(processor, source, context, stream);
  };

  return {
    captureWav() {
      if (chunks.length === 0) return null;
      return encodeWav(chunks, context.sampleRate);
    },
    stop() {
      teardown();
    },
  };
}
