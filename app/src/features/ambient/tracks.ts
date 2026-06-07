import type { PlanId } from '@/lib/entitlements';
import type { AmbientTrack } from '@/stores/ui';

export interface AmbientTrackDef {
  id: AmbientTrack;
  label: string;
  desc: string;
  url: string;
  premium: false;
}

// Replace these five placeholder URLs with the public Cloudflare R2 URLs.
// The player advances through the list in order and repeats after track 5.
export const AMBIENT_TRACKS: readonly AmbientTrackDef[] = [
  {
    id: 'music-1',
    label: 'Music 1',
    desc: 'Cloudflare R2 track placeholder',
    url: 'https://YOUR-R2-PUBLIC-DOMAIN.example/jarvis-music-1.mp3',
    premium: false,
  },
  {
    id: 'music-2',
    label: 'Music 2',
    desc: 'Cloudflare R2 track placeholder',
    url: 'https://YOUR-R2-PUBLIC-DOMAIN.example/jarvis-music-2.mp3',
    premium: false,
  },
  {
    id: 'music-3',
    label: 'Music 3',
    desc: 'Cloudflare R2 track placeholder',
    url: 'https://YOUR-R2-PUBLIC-DOMAIN.example/jarvis-music-3.mp3',
    premium: false,
  },
  {
    id: 'music-4',
    label: 'Music 4',
    desc: 'Cloudflare R2 track placeholder',
    url: 'https://YOUR-R2-PUBLIC-DOMAIN.example/jarvis-music-4.mp3',
    premium: false,
  },
  {
    id: 'music-5',
    label: 'Music 5',
    desc: 'Cloudflare R2 track placeholder',
    url: 'https://YOUR-R2-PUBLIC-DOMAIN.example/jarvis-music-5.mp3',
    premium: false,
  },
] as const;

export const FREE_AMBIENT_TRACK: AmbientTrack = 'music-1';

export function getAmbientTrackDef(track: AmbientTrack): AmbientTrackDef {
  return AMBIENT_TRACKS.find((item) => item.id === track) ?? AMBIENT_TRACKS[0];
}

export function getAmbientTrackIndex(track: AmbientTrack): number {
  const index = AMBIENT_TRACKS.findIndex((item) => item.id === track);
  return index >= 0 ? index : 0;
}

export function planAllowsAmbientTrack(_track: AmbientTrack, _plan: PlanId, _admin = false): boolean {
  return true;
}

export function getPlayableAmbientTrack(track: AmbientTrack, _plan: PlanId, _admin = false): AmbientTrack {
  return getAmbientTrackDef(track).id;
}
