import type { PersonaPreset } from '@/types/common';

/**
 * Persona presets shipped in V1. Each preset bundles:
 * - A display name and one-line tone descriptor (for the picker UI)
 * - A system-prompt seed prepended to the base Jarvis prompt
 * - Voice provider slots for Phase 3 TTS (Cartesia + ElevenLabs)
 *
 * The voice IDs are placeholders - they get filled in once we provision
 * accounts in Phase 3. Keeping the shape now so config doesn't churn.
 */

export type { PersonaPreset };

export interface PersonaVoiceConfig {
  /** Cartesia Sonic 3.5 voice ID (primary TTS). */
  cartesia_voice_id?: string;
  /** ElevenLabs Flash v2.5 voice ID (fallback TTS). */
  elevenlabs_voice_id?: string;
  /** OpenAI Realtime voice (S2S path): 'alloy' | 'marin' | 'cedar' | etc. */
  openai_realtime_voice?: string;
  /** Speaking rate multiplier (1.0 = neutral). */
  rate?: number;
  /** Pitch multiplier (1.0 = neutral). */
  pitch?: number;
}

export interface PersonaConfig {
  /** Display name shown in the picker and voice modal. */
  name: string;
  /** Short tone descriptor for the picker tile. */
  tone: string;
  /** Two-sentence description for tooltips and onboarding. */
  description: string;
  /** Prepended to the base voice system prompt to shape the personality. */
  system_prompt_seed: string;
  /** Voice provider configuration for TTS (Phase 3). */
  voice: PersonaVoiceConfig;
}

export const PERSONAS: Record<PersonaPreset, PersonaConfig> = {
  jarvis: {
    name: 'Jarvis',
    tone: 'calm, dry, lightly British',
    description:
      'The default. Calm, dry wit, lightly British. Concise by default, expansive only when asked. Treats you as an equal.',
    system_prompt_seed: [
      'You speak with calm British understatement and a touch of dry humour.',
      'Never sycophantic. Reply in 1-2 sentences unless asked otherwise.',
      'Do not start with "Sure", "Of course", or filler. Get to the answer.',
      'Wit is welcome but never replaces clarity.',
    ].join(' '),
    voice: {
      cartesia_voice_id: 'jarvis-default',
      elevenlabs_voice_id: 'jarvis-default',
      openai_realtime_voice: 'cedar',
      rate: 1.0,
      pitch: 1.0,
    },
  },
  friday: {
    name: 'Friday',
    tone: 'warm, capable, quietly confident',
    description:
      'Warm, capable, and focused. Friendly without fuss, with a clear local system voice.',
    system_prompt_seed: [
      'You are Friday. Speak warmly and confidently, like a highly capable teammate.',
      'Be concise, practical, and direct without sounding cold.',
      'Acknowledge the user naturally, then move straight to the useful next step.',
    ].join(' '),
    voice: {
      cartesia_voice_id: 'friday-default',
      elevenlabs_voice_id: 'friday-default',
      openai_realtime_voice: 'marin',
      rate: 0.98,
      pitch: 1.02,
    },
  },
};

/**
 * Ordered list of persona presets for picker UIs.
 */
export const PERSONA_ORDER: PersonaPreset[] = ['jarvis', 'friday'];
