import type { PersonaPreset } from '@/types/common';
import { PERSONAS } from './personas';

export const VOICE_PREVIEW_TEXT = "Hi, how's your day going? Jarvis is online.";

export interface SpeakTextOptions {
  persona?: PersonaPreset;
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

function getSpeechSynthesis(): SpeechSynthesis | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  return window.speechSynthesis;
}

export function isSpeechSynthesisSupported(): boolean {
  return getSpeechSynthesis() !== null && typeof SpeechSynthesisUtterance !== 'undefined';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function voiceScore(voice: SpeechSynthesisVoice, persona: PersonaPreset, lang?: string): number {
  const haystack = `${voice.name} ${voice.voiceURI} ${voice.lang}`.toLowerCase();
  let score = 0;
  if (lang && voice.lang.toLowerCase().startsWith(lang.toLowerCase().slice(0, 2))) score += 12;
  if (!lang && voice.lang.toLowerCase().startsWith('en')) score += 10;
  if (voice.default) score += 3;
  if (voice.localService) score += 2;
  for (const hint of QUALITY_HINTS) {
    if (haystack.includes(hint)) score += 6;
  }
  PREFERRED_VOICE_NAMES[persona].forEach((name, index) => {
    if (haystack.includes(name)) score += 20 - index;
  });
  return score;
}

export function selectPersonaVoice(
  voices: readonly SpeechSynthesisVoice[],
  persona: PersonaPreset = 'jarvis',
  options: Pick<SpeakTextOptions, 'lang' | 'voiceName'> = {},
): SpeechSynthesisVoice | undefined {
  if (voices.length === 0) return undefined;
  if (options.voiceName) {
    const requested = options.voiceName.toLowerCase();
    const exact = voices.find((voice) => voice.name.toLowerCase() === requested);
    if (exact) return exact;
    const partial = voices.find((voice) => voice.name.toLowerCase().includes(requested));
    if (partial) return partial;
  }
  return [...voices].sort(
    (a, b) => voiceScore(b, persona, options.lang) - voiceScore(a, persona, options.lang),
  )[0];
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
    }, 500);
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
  const synthesis = getSpeechSynthesis();
  if (!synthesis || typeof SpeechSynthesisUtterance === 'undefined') {
    throw new Error('Speech synthesis is not available in this runtime.');
  }

  const persona = options.persona ?? 'jarvis';
  const personaVoice = PERSONAS[persona]?.voice;
  const voices = await getVoices();
  const selectedVoice = selectPersonaVoice(voices, persona, options);
  const utterance = new SpeechSynthesisUtterance(trimmed);
  utterance.voice = selectedVoice ?? null;
  utterance.lang = options.lang ?? selectedVoice?.lang ?? 'en-US';
  utterance.rate = clamp(options.rate ?? personaVoice?.rate ?? 1, 0.7, 1.3);
  utterance.pitch = clamp(options.pitch ?? personaVoice?.pitch ?? 1, 0.6, 1.4);
  utterance.volume = clamp(options.volume ?? 1, 0, 1);

  synthesis.cancel();

  await new Promise<void>((resolve, reject) => {
    const fallbackMs = Math.min(12_000, Math.max(2_000, trimmed.length * 80));
    const timeout = window.setTimeout(() => resolve(), fallbackMs);
    utterance.onend = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    utterance.onerror = (event) => {
      window.clearTimeout(timeout);
      reject(new Error(event.error || 'Speech synthesis failed.'));
    };
    synthesis.speak(utterance);
  });
}

export function speakPersonaPreview(persona: PersonaPreset, text = VOICE_PREVIEW_TEXT): Promise<void> {
  return speakText(text, { persona });
}
