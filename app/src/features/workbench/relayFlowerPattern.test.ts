import { describe, expect, it } from 'vitest';
import { relayFlowerSpecs } from './relayFlowerPattern';

describe('relay flower background', () => {
  it('keeps each bloom stable while varying neighboring flowers', () => {
    const first = relayFlowerSpecs('room-one', 330, 740, 0);
    expect(first.length).toBeGreaterThan(3);
    expect(relayFlowerSpecs('room-one', 330, 740, 0)).toEqual(first);
    expect(new Set(first.map(({ petals, radius, rotation }) => `${petals}:${radius}:${rotation}`)).size).toBe(first.length);
    expect(new Set(first.map(({ stemLength, stemBend, thorns }) => `${stemLength}:${stemBend}:${thorns}`)).size).toBe(first.length);
    expect(new Set(first.map(({ x }) => Math.round(x))).size).toBeGreaterThan(2);
    expect(new Set(first.map(({ thorns }) => thorns)).size).toBeGreaterThan(1);
    expect(relayFlowerSpecs('room-two', 330, 740, 0)).not.toEqual(first);
  });

  it('tracks scroll by the same section coordinates as the chat botanical pattern', () => {
    const atTop = relayFlowerSpecs('room-one', 330, 740, 0);
    const scrolled = relayFlowerSpecs('room-one', 330, 740, 30);
    expect(scrolled[0].x).toBe(atTop[0].x);
    expect(scrolled[0].y).toBe(atTop[0].y - 30);
  });
});
