import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** User-authored skill persisted in localStorage (Supabase sync not wired yet). */
export interface CustomSkillRecord {
  id: string;
  name: string;
  description: string;
  tools: string[];
  systemPromptAddendum: string;
  /** Extended markdown body shown in the Skills library editor. */
  body: string;
  color_hue: number;
  emoji?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Partial edits applied on top of a built-in preset from `SKILLS`. */
export interface PresetOverride {
  name?: string;
  description?: string;
  tools?: string[];
  systemPromptAddendum?: string;
  body?: string;
  color_hue?: number;
  emoji?: string;
  enabled?: boolean;
}

interface SkillsStoreState {
  customSkills: CustomSkillRecord[];
  presetOverrides: Record<string, PresetOverride>;
  /** Preset ids the user removed from the library (restorable). */
  deletedPresets: string[];
  addCustomSkill: (partial?: Partial<Pick<CustomSkillRecord, 'name' | 'description' | 'emoji'>>) => string;
  updateCustomSkill: (id: string, patch: Partial<Omit<CustomSkillRecord, 'id' | 'createdAt'>>) => void;
  removeCustomSkill: (id: string) => void;
  setPresetOverride: (id: string, patch: PresetOverride) => void;
  clearPresetOverride: (id: string) => void;
  deletePreset: (id: string) => void;
  restorePreset: (id: string) => void;
  restoreAllPresets: () => void;
  setSkillEnabled: (id: string, enabled: boolean, source: 'preset' | 'custom') => void;
}

function newCustomId(): string {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const useSkillsStore = create<SkillsStoreState>()(
  persist(
    (set, get) => ({
      customSkills: [],
      presetOverrides: {},
      deletedPresets: [],

      addCustomSkill: (partial) => {
        const id = newCustomId();
        const now = Date.now();
        const record: CustomSkillRecord = {
          id,
          name: partial?.name?.trim() || 'New skill',
          description: partial?.description?.trim() || 'Custom instructions for this turn',
          tools: [],
          systemPromptAddendum: 'Describe how the assistant should behave when this skill is active.',
          body: '',
          color_hue: 35,
          emoji: partial?.emoji ?? '✨',
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        set({ customSkills: [record, ...get().customSkills] });
        return id;
      },

      updateCustomSkill: (id, patch) => {
        const now = Date.now();
        set({
          customSkills: get().customSkills.map((skill) =>
            skill.id === id ? { ...skill, ...patch, updatedAt: now } : skill,
          ),
        });
      },

      removeCustomSkill: (id) => {
        set({ customSkills: get().customSkills.filter((s) => s.id !== id) });
      },

      setPresetOverride: (id, patch) => {
        set({
          presetOverrides: {
            ...get().presetOverrides,
            [id]: { ...get().presetOverrides[id], ...patch },
          },
        });
      },

      clearPresetOverride: (id) => {
        const next = { ...get().presetOverrides };
        delete next[id];
        set({ presetOverrides: next });
      },

      deletePreset: (id) => {
        const deleted = new Set(get().deletedPresets);
        deleted.add(id);
        set({ deletedPresets: Array.from(deleted) });
      },

      restorePreset: (id) => {
        set({
          deletedPresets: get().deletedPresets.filter((x) => x !== id),
          presetOverrides: (() => {
            const next = { ...get().presetOverrides };
            delete next[id];
            return next;
          })(),
        });
      },

      restoreAllPresets: () => {
        set({ deletedPresets: [], presetOverrides: {} });
      },

      setSkillEnabled: (id, enabled, source) => {
        if (source === 'custom') {
          get().updateCustomSkill(id, { enabled });
          return;
        }
        get().setPresetOverride(id, { enabled });
      },
    }),
    { name: 'jarvis-skills-catalog-v1' },
  ),
);

/** Non-hook read for runtime / catalog merge (same pattern as milestonesStore). */
export function readSkillsStore(): SkillsStoreState {
  return useSkillsStore.getState();
}
