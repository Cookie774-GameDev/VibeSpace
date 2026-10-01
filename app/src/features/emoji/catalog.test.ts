import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIBESPACE_EMOJI_ID,
  VIBESPACE_EMOJIS,
  findVibeSpaceEmoji,
  searchVibeSpaceEmojis,
} from './catalog';

describe('VibeSpace emoji catalog', () => {
  it('ships exactly 100 stable, uniquely named definitions', () => {
    expect(VIBESPACE_EMOJIS).toHaveLength(100);
    expect(new Set(VIBESPACE_EMOJIS.map((emoji) => emoji.id)).size).toBe(100);
    expect(new Set(VIBESPACE_EMOJIS.map((emoji) => emoji.name.toLowerCase())).size).toBe(100);
    expect(VIBESPACE_EMOJIS.every((emoji) => /^vibe:[a-z0-9-]+$/u.test(emoji.id))).toBe(true);
  });

  it('provides a stable fallback and searches names, motifs, and palettes', () => {
    expect(findVibeSpaceEmoji(DEFAULT_VIBESPACE_EMOJI_ID)?.name).toBe('Aurora Spark');
    expect(searchVibeSpaceEmojis('builder').map((emoji) => emoji.name)).toEqual([
      'Aurora Builder',
      'Ember Builder',
      'Ocean Builder',
      'Orchid Builder',
      'Solar Builder',
      'Forest Builder',
      'Frost Builder',
      'Rose Builder',
      'Copper Builder',
      'Midnight Builder',
    ]);
    expect(searchVibeSpaceEmojis('midnight')).toHaveLength(10);
    expect(searchVibeSpaceEmojis('not-a-real-icon')).toEqual([]);
  });
});
