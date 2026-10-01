import { describe, expect, it } from 'vitest';
import { NatureAvatarAllocator, natureAvatarForOrdinal, NATURE_PROFILE_IDS } from './natureAvatarAssignment';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('nature avatar assignment', () => {
  it('uses all 27 color portraits before repeating them in grayscale', () => {
    expect(NATURE_PROFILE_IDS).toHaveLength(27);
    expect(new Set(NATURE_PROFILE_IDS).size).toBe(27);
    expect(natureAvatarForOrdinal(1)).toMatchObject({ profileId: '01-leaf-ghost', monochrome: false });
    expect(natureAvatarForOrdinal(27)).toMatchObject({ profileId: '27-fawn', monochrome: false });
    expect(natureAvatarForOrdinal(28)).toMatchObject({ profileId: '01-leaf-ghost', monochrome: true });
    expect(natureAvatarForOrdinal(54)).toMatchObject({ profileId: '27-fawn', monochrome: true });
    expect(natureAvatarForOrdinal(55)).toMatchObject({ profileId: '01-leaf-ghost', monochrome: true });
  });

  it('keeps one identity in one slot across repeated views and reloads', () => {
    const saved = storage();
    const first = new NatureAvatarAllocator(saved);
    expect(first.assign('agent-1').ordinal).toBe(1);
    expect(first.assign('agent-1').ordinal).toBe(1);
    expect(first.assign('agent-2').ordinal).toBe(2);
    const reloaded = new NatureAvatarAllocator(saved);
    expect(reloaded.assign('agent-1').ordinal).toBe(1);
    expect(reloaded.assign('agent-3').ordinal).toBe(3);
  });

  it('recovers from malformed saved order without losing a working avatar', () => {
    const saved = storage();
    saved.setItem('vibespace:nature-avatar-order:v1', '{bad');
    expect(new NatureAvatarAllocator(saved).assign('fresh').ordinal).toBe(1);
  });
});
