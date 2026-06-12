import type { VoicePresetId } from '@/types/common';

export interface VoiceProfile {
  id: VoicePresetId;
  name: string;
  description: string;
  bestFor: string;
  rate: number;
  pitch: number;
  preferredNames: string[];
}

export const DEFAULT_VOICE_PRESET: VoicePresetId = 'jarvis-prime';

export const VOICE_PROFILES: readonly VoiceProfile[] = [
  {
    id: 'jarvis-prime',
    name: 'JARVIS',
    description: 'Low, restrained, and clearly synthetic with a polished console tone.',
    bestFor: 'Classic command voice',
    rate: 1.22,
    pitch: 0.72,
    preferredNames: ['guy', 'george', 'daniel', 'ryan', 'mark', 'david', 'english united kingdom'],
  },
  {
    id: 'aurora',
    name: 'FRIDAY',
    description: 'Sharper, brighter, and more technical while still sounding machine-made.',
    bestFor: 'Fast tactical replies',
    rate: 1.28,
    pitch: 0.96,
    preferredNames: ['sonia', 'zira', 'aria', 'serena', 'jenny', 'samantha'],
  },
  {
    id: 'atlas',
    name: 'Onyx',
    description: 'Heavy, deliberate, and darker for status reports and diagnostics.',
    bestFor: 'Reports',
    rate: 1.12,
    pitch: 0.66,
    preferredNames: ['guy', 'mark', 'david', 'george', 'alex', 'daniel'],
  },
  {
    id: 'nova',
    name: 'Pulse',
    description: 'Quick, crisp, and lightly robotic without sounding human-soft.',
    bestFor: 'Fast replies',
    rate: 1.35,
    pitch: 0.9,
    preferredNames: ['jenny', 'sonia', 'zira', 'aria', 'samantha', 'serena'],
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    description: 'Precise, clipped, and intentionally robotic for technical work.',
    bestFor: 'Technical work',
    rate: 1.2,
    pitch: 0.68,
    preferredNames: ['david', 'mark', 'george', 'ryan', 'daniel', 'alex'],
  },
] as const;

export function getVoiceProfile(id: VoicePresetId): VoiceProfile {
  return VOICE_PROFILES.find((profile) => profile.id === id) ?? VOICE_PROFILES[0];
}
