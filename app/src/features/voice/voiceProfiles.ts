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
    name: 'Jarvis Prime',
    description: 'Calm, intelligent, clean, and subtly synthetic.',
    bestFor: 'Default assistant',
    rate: 0.94,
    pitch: 0.86,
    preferredNames: ['ryan', 'daniel', 'george', 'guy', 'mark', 'david', 'english united kingdom'],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Warm, polished, and reassuring with a lighter tone.',
    bestFor: 'Conversation',
    rate: 1,
    pitch: 1.08,
    preferredNames: ['aria', 'serena', 'samantha', 'sonia', 'zira', 'jenny'],
  },
  {
    id: 'atlas',
    name: 'Atlas',
    description: 'Deep, measured, and authoritative without sounding harsh.',
    bestFor: 'Reports',
    rate: 0.88,
    pitch: 0.72,
    preferredNames: ['guy', 'mark', 'david', 'george', 'alex', 'daniel'],
  },
  {
    id: 'nova',
    name: 'Nova',
    description: 'Bright, quick, and expressive for everyday assistance.',
    bestFor: 'Fast replies',
    rate: 1.08,
    pitch: 1.16,
    preferredNames: ['jenny', 'sonia', 'aria', 'samantha', 'serena', 'zira'],
  },
  {
    id: 'sentinel',
    name: 'Sentinel',
    description: 'Precise, restrained, and slightly robotic.',
    bestFor: 'Technical work',
    rate: 0.92,
    pitch: 0.78,
    preferredNames: ['david', 'mark', 'george', 'ryan', 'daniel', 'alex'],
  },
] as const;

export function getVoiceProfile(id: VoicePresetId): VoiceProfile {
  return VOICE_PROFILES.find((profile) => profile.id === id) ?? VOICE_PROFILES[0];
}
