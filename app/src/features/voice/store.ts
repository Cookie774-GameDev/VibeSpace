import { create } from 'zustand';
import type { PersonaPreset } from '@/types/common';

/**
 * Voice-feature local state. Distinct from the global `useUIStore`:
 * - `useUIStore` owns BOOLEANS that other features need to know about
 *   (`voiceModalOpen`, `voiceListening` for the GlowBorder).
 * - `useVoiceStore` (this) owns the rich voice-only state - transcripts,
 *   semantic state machine, persona selection.
 *
 * We keep them split so a feature can subscribe to `voiceListening` without
 * pulling in transcript history.
 */

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface FinalTranscript {
  text: string;
  ts: number;
}

interface VoiceStore {
  /** Current voice state machine position - drives the orb visual. */
  state: VoiceState;
  /** Last error message if `state === 'error'`. */
  errorMessage: string | null;
  /** Live partial transcript while the user is speaking. Gets replaced. */
  partialTranscript: string;
  /** History of finalized utterances during the current session. */
  finalTranscript: FinalTranscript[];
  /** Active persona preset (mirrored from auth store but cached locally). */
  persona: PersonaPreset;

  // Actions
  setState: (s: VoiceState, errorMessage?: string) => void;
  setPartialTranscript: (text: string) => void;
  pushFinalTranscript: (text: string) => void;
  clearTranscripts: () => void;
  setPersona: (p: PersonaPreset) => void;
  reset: () => void;
}

const defaults = {
  state: 'idle' as VoiceState,
  errorMessage: null,
  partialTranscript: '',
  finalTranscript: [] as FinalTranscript[],
  persona: 'jarvis' as PersonaPreset,
};

export const useVoiceStore = create<VoiceStore>((set) => ({
  ...defaults,

  setState: (s, errorMessage) =>
    set({
      state: s,
      errorMessage: s === 'error' ? errorMessage ?? 'Voice error' : null,
    }),

  setPartialTranscript: (text) => set({ partialTranscript: text }),

  pushFinalTranscript: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => ({
      finalTranscript: [...s.finalTranscript, { text: trimmed, ts: Date.now() }],
      partialTranscript: '',
    }));
  },

  clearTranscripts: () => set({ partialTranscript: '', finalTranscript: [] }),

  setPersona: (p) => set({ persona: p }),

  reset: () => set(defaults),
}));
