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
export { WakeWordHost } from './WakeWordHost';

// Services
export { VoiceService } from './VoiceService';
export type { VoiceEventMap, VoiceErrorKind } from './VoiceService';
export {
  isSpeechSynthesisSupported,
  selectPersonaVoice,
  speakPersonaPreview,
  speakText,
  VOICE_PREVIEW_TEXT,
} from './speechSynthesis';
export {
  speakWithSettings,
  previewVoiceWithSettings,
  stopAllVoiceOutput,
  warmVoiceEngine,
  ensureKokoroReadyForSpeech,
} from './voiceRouter';
export { createStreamingVoiceSession, StreamingVoiceSession } from './streamingVoice';
export type { SpeakTextOptions } from './speechSynthesis';
export { IntentClassifier, classify } from './IntentClassifier';
export type { Intent, VoiceIntent, VoiceSlots } from './IntentClassifier';

// TTS (speaking) subsystem — voice subscription system
export { TtsService } from './TtsService';
export type { SpeakOptions, VoiceUsageSnapshot, TtsStatus } from './TtsService';
export { ModelManager, resolveModelPath, detectOS } from './modelManager';
export type { ModelManifest, ModelStatus, DownloadProgress, OS } from './modelManager';
export {
  cleanTextForSpeech,
  chunkText,
  prepareForSpeech,
  looksLikeRawData,
} from './textCleanup';
export {
  VOICE_PLANS,
  VOICE_PROVIDERS,
  VOICE_PRESETS,
  DEFAULT_VOICE_TTS_PRESET,
  usageCopy,
  FALLBACK_MESSAGES,
  COST_PER_SECOND_USD,
} from './voicePlans';
export type {
  VoicePlanId,
  VoiceProviderId,
  VoiceTtsPreset,
  VoicePresetDef,
} from './voicePlans';

// Stores
export { useVoiceStore } from './store';
export type { VoiceState, FinalTranscript } from './store';

// Personas
export { PERSONAS, PERSONA_ORDER } from './personas';
export type { PersonaPreset, PersonaConfig, PersonaVoiceConfig } from './personas';
