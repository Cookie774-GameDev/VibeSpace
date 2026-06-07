import { describe, expect, it } from 'vitest';
import {
  AMBIENT_TRACKS,
  FREE_AMBIENT_TRACK,
  getAmbientTrackIndex,
  getPlayableAmbientTrack,
  planAllowsAmbientTrack,
} from './tracks';

describe('ambient hosted playlist', () => {
  it('contains five ordered remote music placeholders', () => {
    expect(AMBIENT_TRACKS).toHaveLength(5);
    expect(AMBIENT_TRACKS.map((track) => track.id)).toEqual([
      'music-1',
      'music-2',
      'music-3',
      'music-4',
      'music-5',
    ]);
    expect(AMBIENT_TRACKS.every((track) => track.url.startsWith('https://'))).toBe(true);
  });

  it('allows every playlist track on every plan', () => {
    for (const track of AMBIENT_TRACKS) {
      expect(planAllowsAmbientTrack(track.id, 'free')).toBe(true);
    }
  });

  it('falls back to the first track for an old persisted track value', () => {
    const oldTrack = 'calm-focus' as never;
    expect(getPlayableAmbientTrack(oldTrack, 'free')).toBe(FREE_AMBIENT_TRACK);
    expect(getAmbientTrackIndex(oldTrack)).toBe(0);
  });
});
