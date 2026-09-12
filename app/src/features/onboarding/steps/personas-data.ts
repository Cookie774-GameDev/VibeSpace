import type { PersonaPreset } from '@/types/common';

/**
 * Persona presets used by both the onboarding picker and the Voice settings section.
 *
 * Keep this picker representation aligned with the canonical voice catalog.
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
    id: 'friday',
    name: 'Friday',
    tone: 'Warm, capable, quietly confident.',
    description: 'Friendly and focused, with a clear local system voice.',
  },
];
