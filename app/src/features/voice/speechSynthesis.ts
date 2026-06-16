import type { PersonaPreset, VoiceEngine, VoicePresetId } from '@/types/common';
import { useAuthStore } from '@/stores/auth';
import { PERSONAS } from './personas';
import { DEFAULT_VOICE_PRESET, getVoiceProfile } from './voiceProfiles';
import { resolveSpeechRate } from './speechRate';

export const VOICE_PREVIEW_TEXT = "Hi, how's your day doing? Jarvis is online.";
export const VOICE_ACKNOWLEDGEMENT_TEXT = 'Ready.';
const VOICE_LOAD_TIMEOUT_MS = 2_500;
const SPEECH_KEEPALIVE_MS = 4_000;

export interface SpeakTextOptions {
  persona?: PersonaPreset;
  voicePreset?: VoicePresetId;
  engine?: VoiceEngine;
  rate?: number;
  pitch?: number;
  volume?: number;
  lang?: string;
  voiceName?: string;
}

const PREFERRED_VOICE_NAMES: Record<PersonaPreset, string[]> = {
  jarvis: ['daniel', 'ryan', 'george', 'guy', 'mark', 'david', 'alex', 'english united kingdom'],
  athena: ['aria', 'serena', 'sonia', 'jenny', 'samantha', 'zira', 'english united kingdom'],
  edge: ['guy', 'mark', 'alex', 'ryan', 'david', 'daniel'],
  watson: ['jenny', 'samantha', 'aria', 'sonia', 'zira', 'serena'],
  hal: ['david', 'daniel', 'george', 'ryan', 'mark', 'alex'],
};

const QUALITY_HINTS = ['natural', 'premium', 'enhanced', 'neural', 'online'];
const CANCELLATION_ERRORS = new Set(['interrupted', 'canceled', 'cancelled']);

let activeSpeechRequestId = 0;

export const SPEECH_SYNTHESIS_START_EVENT = 'jarvis:speech:start';
export const SPEECH_SYNTHESIS_END_EVENT = 'jarvis:speech:end';
export const STREAMING_VOICE_START_EVENT = 'jarvis:streaming-voice:start';
export const STREAMING_VOICE_END_EVENT = 'jarvis:streaming-voice:end';

function dispatchSpeechEvent(name: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name));
}

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

export function isSpeechSynthesisSupported(): boolean {
  return getSpeechSynthesis() !== null && typeof SpeechSynthesisUtterance !== 'undefined';
}

/**
 * Immediately stop any in-progress Web Speech playback and invalidate any
 * pending speak loop. Used when the app is closing/hiding so Jarvis does not
 * keep talking in the background.
 */
export function stopSpeech(): void {
  activeSpeechRequestId += 1;
  try {
    getSpeechSynthesis()?.cancel();
  } catch {
    /* ignore */
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function baseVoiceScore(voice: SpeechSynthesisVoice, lang?: string): number {
  const haystack = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  let score = 0;
  if (lang && voice.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2))) score += 12;
  if (!lang && voice.lang.toLowerCase().startsWith('en')) score += 10;
  if (voice.default) score += 3;
  if (voice.localService) score += 2;
  for (const hint of QUALITY_HINTS) {
    if (haystack.includes(hint)) score += 6;
  }
  return score;
}

function voiceScore(voice: SpeechSynthesisVoice, persona: PersonaPreset, lang?: string): number {
  const haystack = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  let score = baseVoiceScore(voice, lang);
  PREFERRED_VOICE_NAMES[persona].forEach((name, index) => {
    if (haystack.includes(name)) score += 20 - index;
  });
  return score;
}

function profileVoiceScore(
  voice: SpeechSynthesisVoice,
  profileId: VoicePresetId,
  lang?: string,
): number {
  const profile = getVoiceProfile(profileId);
  const haystack = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  let score = baseVoiceScore(voice, lang);
  profile.preferredNames.forEach((name, index) => {
    if (haystack.includes(name)) score += 22 - index;
  });
  return score;
}

function candidateVoices(
  voices: readonly SpeechSynthesisVoice[],
  engine: VoiceEngine = 'system',
): SpeechSynthesisVoice[] {
  return engine === 'local' ? voices.filter((voice) => voice.localService) : [...voices];
}

export function selectPersonaVoice(
  voices: readonly SpeechSynthesisVoice[],
  persona: PersonaPreset = 'jarvis',
  options: Pick<SpeakTextOptions, 'lang' | 'voiceName' | 'engine'> = {},
): SpeechSynthesisVoice | undefined {
  const candidates = candidateVoices(voices, options.engine);
  if (candidates.length === 0) return undefined;
  if (options.voiceName) {
    const requested = options.voiceName.toLowerCase();
    const exact = candidates.find((voice) => voice.name.toLowerCase() === requested);
    if (exact) return exact;
    const partial = candidates.find((voice) => voice.name.toLowerCase().includes(requested));
    if (partial) return partial;
  }
  return candidates.sort(
    (a, b) => voiceScore(b, persona, options.lang) - voiceScore(a, persona, options.lang),
  )[0];
}

export function selectVoiceProfileVoice(
  voices: readonly SpeechSynthesisVoice[],
  preset: VoicePresetId = DEFAULT_VOICE_PRESET,
  options: Pick<SpeakTextOptions, 'lang' | 'voiceName' | 'engine'> = {},
): SpeechSynthesisVoice | undefined {
  const candidates = candidateVoices(voices, options.engine);
  if (candidates.length === 0) return undefined;
  if (options.voiceName) {
    const requested = options.voiceName.toLowerCase();
    const exact = candidates.find((voice) => voice.name.toLowerCase() === requested);
    if (exact) return exact;
    const partial = candidates.find((voice) => voice.name.toLowerCase().includes(requested));
    if (partial) return partial;
  }
  return candidates.sort(
    (a, b) =>
      profileVoiceScore(b, preset, options.lang) - profileVoiceScore(a, preset, options.lang),
  )[0];
}

export async function getInstalledSpeechVoices(
  engine: VoiceEngine = 'system',
): Promise<SpeechSynthesisVoice[]> {
  const voices = await getVoices();
  return candidateVoices(voices, engine);
}

/** Warm the OS voice list so the first preview/reply is not blocked on voiceschanged. */
export async function preloadSpeechVoices(engine: VoiceEngine = 'system'): Promise<void> {
  const voices = await getVoices();
  candidateVoices(voices, engine);
}

export async function isLocalSpeechAvailable(): Promise<boolean> {
  const voices = await getInstalledSpeechVoices('local');
  return voices.length > 0;
}

async function getVoices(): Promise<SpeechSynthesisVoice[]> {
  const synthesis = getSpeechSynthesis();
  if (!synthesis) return [];
  const existing = synthesis.getVoices();
  if (existing.length > 0) return existing;
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      synthesis.onvoiceschanged = null;
      resolve(synthesis.getVoices());
    }, VOICE_LOAD_TIMEOUT_MS);
    synthesis.onvoiceschanged = () => {
      window.clearTimeout(timeout);
      synthesis.onvoiceschanged = null;
      resolve(synthesis.getVoices());
    };
  });
}

export async function speakText(text: string, options: SpeakTextOptions = {}): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Speech text must be non-empty.');

  const state = useAuthStore.getState();
  const engine = options.engine ?? state.voiceEngine ?? 'kokoro';
  if (engine === 'kokoro') {
    const { speakWithSettings } = await import('./voiceRouter');
    await speakWithSettings(trimmed, {
      voicePreset: options.voicePreset ?? state.voicePreset,
      voiceEngine: 'kokoro',
      allowBackground: true,
    });
    return;
  }

  const synthesis = getSpeechSynthesis();
  if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    throw new Error('Speech synthesis is not available in this runtime.');
  }

  const requestId = activeSpeechRequestId + 1;
  activeSpeechRequestId = requestId;
  synthesis.cancel();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  if (requestId !== activeSpeechRequestId) return;

  const preset = options.voicePreset ?? state.voicePreset ?? DEFAULT_VOICE_PRESET;
  const persona = options.persona ?? state.personaPreset ?? 'jarvis';
  const useVoiceProfile = options.voicePreset !== undefined || options.persona === undefined;
  const profile = getVoiceProfile(preset);
  const personaVoice = PERSONAS[persona]?.voice;
  const voices = await getVoices();
  if (requestId !== activeSpeechRequestId) return;

  const selectedVoice = useVoiceProfile
    ? selectVoiceProfileVoice(voices, preset, { ...options, engine })
    : selectPersonaVoice(voices, persona, { ...options, engine });
  if (engine === 'local' && !selectedVoice) {
    throw new Error(
      'No installed local system voice was found. Install a Windows speech voice pack or switch Voice Engine to System.',
    );
  }
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.voice = selectedVoice ?? null;
  utterance.lang = options.lang ?? selectedVoice?.lang ?? 'en-US';
  const baseRate = options.rate ?? (useVoiceProfile ? profile.rate : personaVoice?.rate) ?? 1.22;
  utterance.rate = clamp(resolveSpeechRate(baseRate), 0.85, 2);
  utterance.pitch = clamp(
    options.pitch ?? (useVoiceProfile ? profile.pitch : personaVoice?.pitch) ?? 1,
    0.6,
    1.4,
  );
  utterance.volume = clamp(options.volume ?? 1, 0, 1);

  await new Promise<void>((resolve, reject) => {
    const fallbackMs = Math.min(20_000, Math.max(1_800, trimmed.length * 55));
    let settled = false;
    let timeout = 0;
    let keepAlive = 0;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearInterval(keepAlive);
      dispatchSpeechEvent(SPEECH_SYNTHESIS_END_EVENT);
      complete();
    };
    timeout = window.setTimeout(() => settle(resolve), fallbackMs);
    keepAlive = window.setInterval(() => {
      if (requestId === activeSpeechRequestId && (synthesis.speaking || synthesis.pending)) {
        synthesis.resume();
      }
    }, SPEECH_KEEPALIVE_MS);
    utterance.onend = () => {
      settle(resolve);
    };
    utterance.onerror = (event) => {
      if (requestId !== activeSpeechRequestId || CANCELLATION_ERRORS.has(event.error)) {
        settle(resolve);
        return;
      }
      settle(() => reject(new Error(event.error || 'Speech synthesis failed.')));
    };
    dispatchSpeechEvent(SPEECH_SYNTHESIS_START_EVENT);
    synthesis.speak(utterance);
    synthesis.resume();
    window.setTimeout(() => {
      if (!settled && requestId === activeSpeechRequestId) {
        synthesis.resume();
      }
    }, 120);
  });
}

export function speakPersonaPreview(
  persona: PersonaPreset,
  text = VOICE_PREVIEW_TEXT,
): Promise<void> {
  return speakText(text, { persona });
}

export function speakVoicePreview(
  preset: VoicePresetId,
  text = VOICE_PREVIEW_TEXT,
  engine?: VoiceEngine,
): Promise<void> {
  const resolvedEngine = engine ?? useAuthStore.getState().voiceEngine ?? 'kokoro';
  return speakText(text, { voicePreset: preset, engine: resolvedEngine });
}
