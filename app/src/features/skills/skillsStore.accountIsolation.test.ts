import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/stores/auth';
import { readSkillsStore, resetSkillsStoreForTests } from './skillsStore';

describe('skills account isolation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetSkillsStoreForTests();
  });

  it('does not expose or overwrite another account custom skill catalog', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    const firstId = readSkillsStore().addCustomSkill({ name: 'Account A skill' });
    expect(readSkillsStore().customSkills.map(({ id }) => id)).toEqual([firstId]);

    useAuthStore.setState({ cloudSession: null, localUserId: 'account-b' });
    expect(readSkillsStore().customSkills).toEqual([]);
    const secondId = readSkillsStore().addCustomSkill({ name: 'Account B skill' });

    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    expect(readSkillsStore().customSkills.map(({ id }) => id)).toEqual([firstId]);
    expect(readSkillsStore().customSkills.some(({ id }) => id === secondId)).toBe(false);
  });

  it('quarantines the former global catalog because its account owner is unknowable', () => {
    window.localStorage.setItem(
      'jarvis-skills-catalog-v1',
      JSON.stringify({
        state: {
          customSkills: [{ id: 'legacy-private-skill', name: 'Private legacy skill' }],
          presetOverrides: {},
          deletedPresets: [],
        },
        version: 0,
      }),
    );
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-new' });

    expect(readSkillsStore().customSkills).toEqual([]);
  });

  it('rejects prototype keys and bounds oversized persisted catalogs', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    const oversizedTools = Array.from({ length: 150 }, (_, index) => `tool-${index}`);
    const overrides = JSON.parse(
      '{"safe":{"name":"Safe"},"__proto__":{"name":"polluted"},"constructor":{"name":"bad"}}',
    );
    window.localStorage.setItem(
      'vibespace-skills-catalog-v2:account-a',
      JSON.stringify({
        customSkills: Array.from({ length: 550 }, (_, index) => ({
          id: `skill-${index}`,
          name: 'n'.repeat(400),
          description: 'd'.repeat(4_000),
          tools: oversizedTools,
          systemPromptAddendum: index === 0 ? 'p'.repeat(60_000) : 'prompt',
          body: index === 0 ? 'b'.repeat(60_000) : 'body',
          color_hue: 35,
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        })),
        presetOverrides: overrides,
        deletedPresets: ['__proto__', 'constructor', 'safe'],
      }),
    );

    const state = readSkillsStore();
    expect(Object.getPrototypeOf(state.presetOverrides)).toBeNull();
    expect(state.presetOverrides).toEqual({ safe: { name: 'Safe' } });
    expect(state.deletedPresets).toEqual(['safe']);
    expect(state.customSkills).toHaveLength(500);
    expect(state.customSkills[0].name.length).toBeLessThanOrEqual(200);
    expect(state.customSkills[0].description.length).toBeLessThanOrEqual(2_000);
    expect(state.customSkills[0].tools).toHaveLength(100);
    expect(state.customSkills[0].systemPromptAddendum.length).toBeLessThanOrEqual(50_000);
    expect(state.customSkills[0].body.length).toBeLessThanOrEqual(50_000);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('normalizes and clones malicious or oversized values on writes', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-a' });
    const state = readSkillsStore();
    state.setPresetOverride('__proto__', { name: 'polluted' });
    state.setPresetOverride('safe', {
      name: 'n'.repeat(400),
      tools: Array.from({ length: 120 }, (_, index) => `tool-${index}`),
    });
    const sourceTools = ['read'];
    const id = state.addCustomSkill({ name: 'A'.repeat(400) });
    readSkillsStore().updateCustomSkill(id, { tools: sourceTools });
    sourceTools.push('mutated-after-write');

    const current = readSkillsStore();
    expect(Object.getPrototypeOf(current.presetOverrides)).toBeNull();
    expect(current.presetOverrides.__proto__).toBeUndefined();
    expect(current.presetOverrides.safe?.name).toHaveLength(200);
    expect(current.presetOverrides.safe?.tools).toHaveLength(100);
    expect(current.customSkills[0].name).toHaveLength(200);
    expect(current.customSkills[0].tools).toEqual(['read']);
  });

  it('restores an exact custom skill once without changing its identity or content', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-restore' });
    const id = readSkillsStore().addCustomSkill({ name: 'Recoverable skill' });
    readSkillsStore().updateCustomSkill(id, {
      description: 'Preserve this description',
      tools: ['read', 'write'],
      systemPromptAddendum: 'Preserve this addendum.',
      body: '# Preserve this body',
      color_hue: 217,
      emoji: '🛟',
      enabled: false,
    });
    const original = readSkillsStore().getCustomSkill(id);
    expect(original).toBeDefined();

    readSkillsStore().removeCustomSkill(id);
    readSkillsStore().restoreCustomSkill(original!);

    expect(readSkillsStore().getCustomSkill(id)).toEqual(original);
    expect(() => readSkillsStore().restoreCustomSkill(original!)).toThrow(
      'A skill with this identity already exists.',
    );
  });

  it('does not publish a custom skill removal when durable persistence fails', () => {
    useAuthStore.setState({ cloudSession: null, localUserId: 'account-storage-failure' });
    const id = readSkillsStore().addCustomSkill({ name: 'Must remain active' });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('storage unavailable');
    });

    expect(() => readSkillsStore().removeCustomSkill(id)).toThrow();
    expect(readSkillsStore().getCustomSkill(id)?.name).toBe('Must remain active');
    setItem.mockRestore();
  });
});
