import { beforeEach, describe, expect, it } from 'vitest';
import { resolveOrigamiWelcomeVariant } from './origamiWelcome';

const makeStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
};

describe('Origami empty-chat welcome variants', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = makeStorage();
  });

  it('keeps each chat stable while independently sampling a 50/50 welcome', () => {
    const samples = [0.1, 0.2, 0.8, 0.9];
    const sample = () => samples.shift() ?? 0;

    expect(resolveOrigamiWelcomeVariant('chat-a', storage, sample)).toBe('boat');
    expect(resolveOrigamiWelcomeVariant('chat-a', storage, sample)).toBe('boat');
    expect(resolveOrigamiWelcomeVariant('chat-b', storage, sample)).toBe('boat');
    expect(resolveOrigamiWelcomeVariant('chat-c', storage, sample)).toBe('lotus');
    expect(resolveOrigamiWelcomeVariant('chat-d', storage, sample)).toBe('lotus');
    expect(samples).toEqual([]);
  });

  it('preserves valid assignments written by the earlier storage shape', () => {
    storage.setItem(
      'vibespace:origami-welcome:v1',
      JSON.stringify({
        assignments: [
          ['chat-boat', 'boat'],
          ['chat-lotus', 'lotus'],
        ],
        next: 'boat',
      }),
    );

    expect(resolveOrigamiWelcomeVariant('chat-boat', storage, () => 0.9)).toBe('boat');
    expect(resolveOrigamiWelcomeVariant('chat-lotus', storage, () => 0.1)).toBe('lotus');
  });

  it('recovers from malformed or unavailable storage deterministically', () => {
    storage.setItem('vibespace:origami-welcome:v1', '{broken');
    expect(resolveOrigamiWelcomeVariant('chat-safe', storage)).toMatch(/^(boat|lotus)$/u);

    const unavailable = {
      ...makeStorage(),
      getItem: () => {
        throw new Error('blocked');
      },
    } as Storage;
    expect(resolveOrigamiWelcomeVariant('chat-safe', unavailable)).toBe(
      resolveOrigamiWelcomeVariant('chat-safe', unavailable),
    );
  });
});
