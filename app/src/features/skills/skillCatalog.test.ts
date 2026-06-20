import { beforeEach, describe, expect, it } from 'vitest';
import { SKILLS } from '@/lib/agents/skills';
import {
  getAllCatalogSkills,
  getUnifiedSkillManifests,
  resolveCatalogSkill,
  resolveCatalogSkills,
} from './skillCatalog';
import { useSkillsStore } from './skillsStore';

describe('skillCatalog', () => {
  beforeEach(() => {
    useSkillsStore.setState({
      customSkills: [],
      presetOverrides: {},
      deletedPresets: [],
    });
  });

  it('seeds all 16 built-in presets in the unified manifest list', () => {
    const manifests = getUnifiedSkillManifests();
    expect(manifests.filter((m) => m.isPreset)).toHaveLength(16);
    expect(manifests.map((m) => m.catalogId).sort()).toEqual(Object.keys(SKILLS).sort());
  });

  it('merges custom skills after presets', () => {
    const id = useSkillsStore.getState().addCustomSkill({ name: 'Deploy', description: 'Ship it' });
    const skills = getAllCatalogSkills();
    expect(skills.some((s) => s.id === id)).toBe(true);
    expect(skills.length).toBe(17);
  });

  it('applies preset overrides to resolveCatalogSkill', () => {
    useSkillsStore.getState().setPresetOverride('coding', {
      name: 'Code wizard',
      systemPromptAddendum: 'Always run tests.',
    });
    const skill = resolveCatalogSkill('coding');
    expect(skill?.name).toBe('Code wizard');
    expect(skill?.systemPromptAddendum).toBe('Always run tests.');
  });

  it('resolveCatalogSkills preserves order and drops unknown ids', () => {
    const ids = ['writing', 'missing', 'research'];
    const resolved = resolveCatalogSkills(ids);
    expect(resolved.map((s) => s.id)).toEqual(['writing', 'research']);
  });

  it('deleted presets are omitted from catalog lists', () => {
    useSkillsStore.getState().deletePreset('voice');
    expect(getAllCatalogSkills().some((s) => s.id === 'voice')).toBe(false);
    expect(getUnifiedSkillManifests().some((m) => m.catalogId === 'voice')).toBe(false);
  });

  it('restoreAllPresets brings back deleted presets', () => {
    useSkillsStore.getState().deletePreset('memory');
    useSkillsStore.getState().restoreAllPresets();
    expect(getAllCatalogSkills().some((s) => s.id === 'memory')).toBe(true);
  });
});
