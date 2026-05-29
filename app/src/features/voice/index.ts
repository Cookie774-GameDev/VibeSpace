/**
 * Public surface of the voice feature.
 *
 * Import shape (per the subagent contract):
 *   import { VoiceModal, GlowBorder, VoiceTrigger, VoiceCaption,
 *            VoiceService, IntentClassifier, useVoiceStore,
 *            PERSONAS, PersonaPreset } from '@/features/voice';
 */

// Components
export { Orb } from './Orb';
export type { OrbProps } from './Orb';
export { GlowBorder } from './GlowBorder';
export { VoiceCaption } from './VoiceCaption';
export { VoiceTrigger } from './VoiceTrigger';
export type { VoiceTriggerProps } from './VoiceTrigger';
export { VoiceModal } from './VoiceModal';

// Services
export { VoiceService } from './VoiceService';
export type { VoiceEventMap, VoiceErrorKind } from './VoiceService';
export { IntentClassifier, classify } from './IntentClassifier';
export type { Intent, VoiceIntent, VoiceSlots } from './IntentClassifier';

// Stores
export { useVoiceStore } from './store';
export type { VoiceState, FinalTranscript } from './store';

// Personas
export { PERSONAS, PERSONA_ORDER } from './personas';
export type { PersonaPreset, PersonaConfig, PersonaVoiceConfig } from './personas';
