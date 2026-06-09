/**
 * Voice subscription plan metadata + preset definitions for the frontend.
 *
 * Server-side is the source of truth for entitlements (Stripe webhook -> tier ->
 * voice_usage). These constants are display/UX only: usage copy, preset labels,
 * and the cost model mirror used to render quotas. Never trust these for gating.
 */

export type VoicePlanId = 'free' | 'starter' | 'pro' | 'ultra';

export const COST_PER_SECOND_USD = 0.00025; // mirrors edge function + migration

export interface VoicePlanInfo {
  id: VoicePlanId;
  label: string;
  priceUsd: number;
  cloudBudgetUsd: number;
  /** Derived monthly cloud seconds (budget / cost-per-second). */
  cloudSeconds: number;
}

function seconds(budget: number): number {
  return Math.floor(budget / COST_PER_SECOND_USD);
}

export const VOICE_PLANS: Record<VoicePlanId, VoicePlanInfo> = {
  free: { id: 'free', label: 'Free', priceUsd: 0, cloudBudgetUsd: 0, cloudSeconds: 0 },
  starter: { id: 'starter', label: 'Starter', priceUsd: 10, cloudBudgetUsd: 2, cloudSeconds: seconds(2) },
  pro: { id: 'pro', label: 'Pro', priceUsd: 50, cloudBudgetUsd: 10, cloudSeconds: seconds(10) },
  ultra: { id: 'ultra', label: 'Ultra', priceUsd: 100, cloudBudgetUsd: 20, cloudSeconds: seconds(20) },
};

// ─── Voice providers (independent of chat providers) ─────────────────────────
export type VoiceProviderId =
  | 'kokoro_local'
  | 'openai_tts'
  | 'deepgram_tts'
  | 'elevenlabs_tts'
  | 'system_tts_fallback';

export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  /** True if it bills against company cloud quota (paid plans only). */
  cloud: boolean;
}

export const VOICE_PROVIDERS: Record<VoiceProviderId, VoiceProviderInfo> = {
  kokoro_local: { id: 'kokoro_local', label: 'Free Local Voice — Kokoro', cloud: false },
  openai_tts: { id: 'openai_tts', label: 'Best AI Voice — OpenAI', cloud: true },
  deepgram_tts: { id: 'deepgram_tts', label: 'Cheap Fast Voice — Deepgram', cloud: true },
  elevenlabs_tts: { id: 'elevenlabs_tts', label: 'Cinematic Premium — ElevenLabs', cloud: true },
  system_tts_fallback: { id: 'system_tts_fallback', label: 'System Fallback', cloud: false },
};

// ─── Voice presets ───────────────────────────────────────────────────────────
export type VoiceTtsPreset = 'jarvis' | 'friday';

export interface VoicePresetDef {
  id: VoiceTtsPreset;
  label: string;
  /** Kokoro voice id. */
  kokoroVoice: string;
  /** Kokoro speed (plan-specified ranges). */
  speed: number;
  description: string;
}

export const VOICE_PRESETS: Record<VoiceTtsPreset, VoicePresetDef> = {
  jarvis: {
    id: 'jarvis',
    label: 'Jarvis',
    kokoroVoice: 'bm_daniel',
    speed: 0.94, // 0.92-0.96
    description: 'Calm, clean, British-inspired futuristic AI assistant.',
  },
  friday: {
    id: 'friday',
    label: 'Friday',
    kokoroVoice: 'bf_emma',
    speed: 1.05, // 1.02-1.08
    description: 'Clear, tactical, fast female AI assistant.',
  },
};

export const DEFAULT_VOICE_TTS_PRESET: VoiceTtsPreset = 'jarvis';

// ─── Usage display copy (matches plan spec) ──────────────────────────────────
function fmtMinutes(secs: number): string {
  return `${Math.round(secs / 60)} min`;
}
function fmtHours(secs: number): string {
  return `${(secs / 3600).toFixed(1)} hr`;
}

export function usageCopy(
  plan: VoicePlanId,
  usedSeconds: number,
  limitSeconds: number,
): string {
  if (plan === 'free') return 'Local Kokoro voice included. Cloud voice not included.';
  if (plan === 'starter') {
    return `Cloud voice: ${fmtMinutes(usedSeconds)} used / ${fmtMinutes(limitSeconds)} included. Local Kokoro voice unlimited.`;
  }
  // pro / ultra shown in hours
  return `Cloud voice: ${fmtHours(usedSeconds)} used / ${fmtHours(limitSeconds)} included. Local Kokoro voice unlimited.`;
}

export const FALLBACK_MESSAGES = {
  quotaExceeded: "You've used your monthly cloud voice time. I switched to free local Kokoro voice.",
  cloudFailure: 'Cloud voice is temporarily unavailable. I switched to local Kokoro voice.',
  modelDownloading: 'Local voice model is downloading. You can still use chat while it downloads.',
  allFailed: 'Voice playback is unavailable right now, but chat still works.',
} as const;
