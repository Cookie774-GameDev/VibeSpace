/**
 * Unified skill catalog — built-in presets from `SKILLS` merged with
 * user custom skills and per-preset overrides (localStorage via skillsStore).
 */

import { SKILLS, type Skill } from '@/lib/agents/skills';
import type { SkillManifest } from './loader';
import { readSkillsStore, type CustomSkillRecord, type PresetOverride } from './skillsStore';

const PRESET_EMOJI: Record<string, string> = {
  coding: '💻',
  research: '🔍',
  writing: '✍️',
  planning: '📋',
  scheduling: '📅',
  terminal: '⌨️',
  web: '🌐',
  files: '📁',
  voice: '🎙️',
  music: '🎵',
  calendar: '🗓️',
  github: '🐙',
  supabase: '⚡',
  opencode: '🧩',
  memory: '🧠',
  summarization: '📝',
};

export interface SkillPickerOption {
  id: string;
  label: string;
  description: string;
  metadata: string;
  emoji?: string;
}

function presetBody(skill: Skill, override?: PresetOverride): string {
  if (override?.body?.trim()) return override.body.trim();
  const lines = [`# ${skill.name}`, '', skill.description];
  if (skill.systemPromptAddendum.trim()) {
    lines.push('', '## Instructions', '', skill.systemPromptAddendum.trim());
  }
  return lines.join('\n');
}

function applyPresetOverride(skill: Skill, override?: PresetOverride): Skill {
  if (!override) return skill;
  return {
    ...skill,
    name: override.name ?? skill.name,
    description: override.description ?? skill.description,
    tools: override.tools ?? skill.tools,
    systemPromptAddendum: override.systemPromptAddendum ?? skill.systemPromptAddendum,
    color_hue: override.color_hue ?? skill.color_hue,
  };
}

export function customRecordToSkill(record: CustomSkillRecord): Skill {
  const addendum =
    record.systemPromptAddendum.trim() ||
    record.body.trim() ||
    record.description.trim();
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    tools: [...record.tools],
    systemPromptAddendum: addendum,
    color_hue: record.color_hue,
  };
}

export function resolvePresetSkill(id: string): Skill | undefined {
  const base = SKILLS[id];
  if (!base) return undefined;
  const store = readSkillsStore();
  if (store.deletedPresets.includes(id)) return undefined;
  return applyPresetOverride(base, store.presetOverrides[id]);
}

export function resolveCatalogSkill(id: string): Skill | undefined {
  const preset = resolvePresetSkill(id);
  if (preset) return preset;
  const custom = readSkillsStore().customSkills.find((s) => s.id === id);
  return custom ? customRecordToSkill(custom) : undefined;
}

/** Stable order matching the input list; unknown ids are dropped. */
export function resolveCatalogSkills(ids: string[]): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const skill = resolveCatalogSkill(id);
    if (skill) out.push(skill);
  }
  return out;
}

export function getAllCatalogSkills(): Skill[] {
  const store = readSkillsStore();
  const presets = Object.keys(SKILLS)
    .filter((id) => !store.deletedPresets.includes(id))
    .map((id) => resolvePresetSkill(id)!)
    .filter((skill): skill is Skill => Boolean(skill))
    .filter((skill) => {
      const override = store.presetOverrides[skill.id];
      return override?.enabled !== false;
    });
  const customs = store.customSkills
    .filter((c) => c.enabled !== false)
    .map(customRecordToSkill);
  return [...presets, ...customs];
}

function skillToManifest(
  skill: Skill,
  opts: {
    source: SkillManifest['source'];
    isPreset: boolean;
    enabled: boolean;
    emoji?: string;
    body?: string;
    filePath: string;
  },
): SkillManifest {
  const store = readSkillsStore();
  const override = opts.isPreset ? store.presetOverrides[skill.id] : undefined;
  const custom = !opts.isPreset
    ? store.customSkills.find((c) => c.id === skill.id)
    : undefined;
  return {
    name: skill.id,
    title: skill.name,
    kind: 'skill',
    description: skill.description,
    tools: skill.tools,
    tags: opts.isPreset ? ['preset'] : ['custom'],
    enabled: opts.enabled,
    body: opts.body ?? presetBody(SKILLS[skill.id] ?? skill, override),
    source: opts.source,
    filePath: opts.filePath,
    catalogId: skill.id,
    isPreset: opts.isPreset,
    colorHue: skill.color_hue,
    emoji: opts.emoji ?? override?.emoji ?? (opts.isPreset ? PRESET_EMOJI[skill.id] : custom?.emoji),
    systemPromptAddendum: skill.systemPromptAddendum,
  };
}

export function getUnifiedSkillManifests(): SkillManifest[] {
  const store = readSkillsStore();
  const manifests: SkillManifest[] = [];

  for (const id of Object.keys(SKILLS)) {
    if (store.deletedPresets.includes(id)) continue;
    const skill = resolvePresetSkill(id);
    if (!skill) continue;
    const override = store.presetOverrides[id];
    const enabled = override?.enabled !== false;
    manifests.push(
      skillToManifest(skill, {
        source: 'builtin',
        isPreset: true,
        enabled,
        emoji: override?.emoji ?? PRESET_EMOJI[id],
        body: override?.body ?? presetBody(SKILLS[id]!, override),
        filePath: `preset://${id}`,
      }),
    );
  }

  for (const custom of store.customSkills) {
    const skill = customRecordToSkill(custom);
    manifests.push(
      skillToManifest(skill, {
        source: 'project',
        isPreset: false,
        enabled: custom.enabled,
        emoji: custom.emoji,
        body: custom.body || presetBody(skill),
        filePath: `custom://${custom.id}`,
      }),
    );
  }

  return manifests.sort((a, b) => a.title.localeCompare(b.title));
}

export function getSkillPickerOptions(): SkillPickerOption[] {
  return getAllCatalogSkills().map((skill) => {
    const store = readSkillsStore();
    const isPreset = Boolean(SKILLS[skill.id]);
    const emoji = isPreset
      ? store.presetOverrides[skill.id]?.emoji ?? PRESET_EMOJI[skill.id]
      : store.customSkills.find((c) => c.id === skill.id)?.emoji;
    return {
      id: skill.id,
      label: skill.name,
      description: skill.description,
      metadata: skill.tools.length > 0 ? skill.tools.join(', ') : 'prompt',
      emoji,
    };
  });
}

export function composeCatalogSkillAddenda(ids: string[]): string {
  return resolveCatalogSkills(ids)
    .map((s) => s.systemPromptAddendum.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function unionCatalogSkillTools(ids: string[]): string[] {
  const set = new Set<string>();
  for (const skill of resolveCatalogSkills(ids)) {
    for (const tool of skill.tools) set.add(tool);
  }
  return Array.from(set).sort();
}

export function manifestToPresetOverride(manifest: SkillManifest): PresetOverride {
  const base = SKILLS[manifest.catalogId ?? manifest.name];
  return {
    name: manifest.title,
    description: manifest.description,
    tools: manifest.tools,
    systemPromptAddendum: manifest.systemPromptAddendum,
    body: manifest.body,
    color_hue: manifest.colorHue,
    emoji: manifest.emoji,
    enabled: manifest.enabled,
  };
}

export function manifestToCustomPatch(manifest: SkillManifest): Partial<CustomSkillRecord> {
  return {
    name: manifest.title,
    description: manifest.description ?? '',
    tools: manifest.tools ?? [],
    systemPromptAddendum: manifest.systemPromptAddendum ?? '',
    body: manifest.body,
    color_hue: manifest.colorHue ?? 35,
    emoji: manifest.emoji,
    enabled: manifest.enabled !== false,
  };
}
