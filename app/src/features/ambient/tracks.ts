import type { PlanId } from '@/lib/entitlements';
import type { AmbientTrack } from '@/stores/ui';

export type AmbientTrackCategory = 'soundscape' | 'calm' | 'soothing' | 'lofi' | 'rap';

export interface AmbientTrackDef {
  id: AmbientTrack;
  label: string;
  desc: string;
  category: AmbientTrackCategory;
  premium: boolean;
}

export const FREE_AMBIENT_TRACK: AmbientTrack = 'calm-focus';

export const AMBIENT_TRACKS: readonly AmbientTrackDef[] = [
  { id: 'calm-focus', label: 'Calm Focus', desc: 'Soft no-copyright synth piano', category: 'calm', premium: false },
  { id: 'calm-piano', label: 'Calm Piano', desc: 'Minimal procedural piano pulses', category: 'calm', premium: false },
  { id: 'soothing-rain', label: 'Soothing Rain', desc: 'Gentle rain with warm pads', category: 'soothing', premium: false },
  { id: 'soothing-space', label: 'Soothing Space', desc: 'Slow celestial pads and shimmer', category: 'soothing', premium: false },
  { id: 'warm-hearth', label: 'Warm Hearth', desc: 'Crackling fireside pad', category: 'soundscape', premium: false },
  { id: 'deep-ocean', label: 'Deep Ocean', desc: 'Low sub swells and waves', category: 'soundscape', premium: false },
  { id: 'starlight', label: 'Starlight', desc: 'Ethereal cosmic shimmer', category: 'soundscape', premium: false },
  { id: 'forest-rain', label: 'Forest Rain', desc: 'Soft rain and distant thunder', category: 'soundscape', premium: false },
  { id: 'lofi-night', label: 'Lo-Fi Night', desc: 'Procedural chill beat loop', category: 'lofi', premium: true },
  { id: 'lofi-rain', label: 'Lo-Fi Rain', desc: 'Chill beat with soft rain texture', category: 'lofi', premium: true },
  { id: 'rap-cipher', label: 'Rap Cipher', desc: 'Procedural 808 cipher groove', category: 'rap', premium: true },
  { id: 'rap-instrumental', label: 'Rap Instrumental', desc: 'Procedural 808 beat bed', category: 'rap', premium: true },
] as const;

export function getAmbientTrackDef(track: AmbientTrack): AmbientTrackDef {
  return AMBIENT_TRACKS.find((item) => item.id === track) ?? AMBIENT_TRACKS[0];
}

export function planAllowsAmbientTrack(track: AmbientTrack, plan: PlanId, admin = false): boolean {
  if (admin) return true;
  const def = getAmbientTrackDef(track);
  return !def.premium || plan !== 'free';
}

export function getPlayableAmbientTrack(track: AmbientTrack, plan: PlanId, admin = false): AmbientTrack {
  return planAllowsAmbientTrack(track, plan, admin) ? track : FREE_AMBIENT_TRACK;
}
