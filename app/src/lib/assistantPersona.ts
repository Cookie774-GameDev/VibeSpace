/**
 * Authoritative selected-assistant persona for user-facing names.
 *
 * Only two values are supported: Jarvis (default) and Friday.
 * Internal identifiers (agent slugs, LiveKit identity prefixes, CSS tokens like
 * accent-sage) stay separate from display names.
 */

import { useAuthStore } from '@/stores/auth';
import type { PersonaPreset } from '@/types/common';

/** Supported conversational assistant personas (user-facing). */
export type AssistantPersonaId = 'jarvis' | 'friday';

export const DEFAULT_ASSISTANT_PERSONA: AssistantPersonaId = 'jarvis';

export const ASSISTANT_PERSONA_DISPLAY = {
  jarvis: 'Jarvis',
  friday: 'Friday',
} as const satisfies Record<AssistantPersonaId, 'Jarvis' | 'Friday'>;

export type AssistantPersonaDisplayName = (typeof ASSISTANT_PERSONA_DISPLAY)[AssistantPersonaId];

const LEGACY_PERSONA_TO_JARVIS = new Set([
  'sage',
  'athena',
  'edge',
  'watson',
  'hal',
  'claude',
  'gpt',
  'gemini',
]);

/**
 * Normalize any stored/API persona value onto the two supported ids.
 * Unknown and legacy values (including "sage") become Jarvis.
 */
export function normalizeAssistantPersonaId(raw: unknown): AssistantPersonaId {
  if (raw === 'friday' || raw === 'Friday' || raw === 'FRIDAY') return 'friday';
  if (raw === 'jarvis' || raw === 'Jarvis' || raw === 'JARVIS') return 'jarvis';
  if (typeof raw === 'string' && LEGACY_PERSONA_TO_JARVIS.has(raw.trim().toLowerCase())) {
    return 'jarvis';
  }
  return DEFAULT_ASSISTANT_PERSONA;
}

/** Display name for UI copy: "Jarvis" | "Friday". */
export function assistantPersonaDisplayName(raw?: unknown): AssistantPersonaDisplayName {
  return ASSISTANT_PERSONA_DISPLAY[normalizeAssistantPersonaId(raw)];
}

/** "Ask Jarvis" / "Ask Friday" for action labels. */
export function askAssistantLabel(raw?: unknown): string {
  return `Ask ${assistantPersonaDisplayName(raw)}`;
}

/** "Ask Jarvis about …" style titles. */
export function askAssistantAboutLabel(topic: string, raw?: unknown): string {
  return `Ask ${assistantPersonaDisplayName(raw)} about ${topic}`;
}

/** Align PersonaPreset with the authoritative assistant id. */
export function toPersonaPreset(raw?: unknown): PersonaPreset {
  return normalizeAssistantPersonaId(raw);
}

/**
 * Live selected display name from auth store. Re-renders when persona changes.
 */
export function useAssistantPersonaName(): AssistantPersonaDisplayName {
  const persona = useAuthStore((s) => s.personaPreset);
  return assistantPersonaDisplayName(persona);
}

/**
 * Live selected persona id from auth store.
 */
export function useAssistantPersonaId(): AssistantPersonaId {
  const persona = useAuthStore((s) => s.personaPreset);
  return normalizeAssistantPersonaId(persona);
}

/** Current selected display name without React (stores, services). */
export function getSelectedAssistantPersonaName(): AssistantPersonaDisplayName {
  return assistantPersonaDisplayName(useAuthStore.getState().personaPreset);
}

export function getSelectedAssistantPersonaId(): AssistantPersonaId {
  return normalizeAssistantPersonaId(useAuthStore.getState().personaPreset);
}
