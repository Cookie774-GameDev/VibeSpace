import type { PersonaPreset } from '@/types/common';

/**
 * Persona presets used by both the onboarding picker and the Voice settings section.
 *
 * These will eventually be sourced from `@/features/voice/personas` (owned by the
 * voice subagent). Until that lands we keep the canonical list here so we don't
 * cross feature boundaries. Keep the shape compatible with the future export.
 */
export interface PersonaInfo {
  id: PersonaPreset;
  name: string;
  /** One-line tone description shown on the card */
  tone: string;
  /** Longer, optional flavor used in onboarding hover/preview */
  description?: string;
}

export const PERSONAS: PersonaInfo[] = [
  {
    id: 'jarvis',
    name: 'Jarvis',
    tone: 'Crisp, attentive, dryly witty.',
    description: 'The default. Composed, helpful, never theatrical.',
  },
  {
    id: 'athena',
    name: 'Athena',
    tone: 'Strategic, even-keeled, decisive.',
    description: 'Optimized for planning and judgment calls.',
  },
  {
    id: 'edge',
    name: 'Edge',
    tone: 'Fast, irreverent, gets to the point.',
    description: 'For when you want answers, not preamble.',
  },
  {
    id: 'watson',
    name: 'Watson',
    tone: 'Patient, scholarly, methodical.',
    description: 'Best for deep research and long context.',
  },
  {
    id: 'hal',
    name: 'HAL',
    tone: 'Calm, exact, faintly unsettling.',
    description: 'Speak softly, carry a big context window.',
  },
];
