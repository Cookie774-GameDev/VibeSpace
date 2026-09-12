import { describe, expect, it } from 'vitest';
import { botanicalRandom, botanicalSections } from './chatBotanicalPattern';

describe('procedural chat foliage', () => {
  const sample = (chat: string, section: number, side = 0) => {
    const random = botanicalRandom(chat, section, side);
    return Array.from({ length: 20 }, random);
  };
  it('recreates the same artwork when revisiting history', () => {
    expect(sample('chat-a', 5)).toEqual(sample('chat-a', 5));
  });
  it('varies across sections, chats, and edges', () => {
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-a', 6));
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-b', 5));
    expect(sample('chat-a', 5)).not.toEqual(sample('chat-a', 5, 1));
    expect(sample('chat-a', 5).every(n => n >= 0 && n < 1)).toBe(true);
  });
  it('draws only the viewport sections regardless of history length', () => {
    expect(botanicalSections(0, 900)).toEqual([0, 1]);
    expect(botanicalSections(48000000, 900)).toEqual([100000, 100001]);
    expect(botanicalSections(-20, 480)).toEqual([0, 1]);
  });
});
