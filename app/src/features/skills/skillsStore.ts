import { create } from 'zustand';
import { getActiveAccountIdentity } from '@/lib/accountIdentity';

/** User-authored skill persisted in account-isolated local storage. */
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

interface SkillsCatalogState {
  customSkills: CustomSkillRecord[];
  presetOverrides: Record<string, PresetOverride>;
  deletedPresets: string[];
}

interface SkillsStoreState extends SkillsCatalogState {
  scopeKey: string;
  getCustomSkill: (id: string) => CustomSkillRecord | undefined;
  addCustomSkill: (
    partial?: Partial<Pick<CustomSkillRecord, 'name' | 'description' | 'emoji'>>,
  ) => string;
  restoreCustomSkill: (record: CustomSkillRecord) => void;
  updateCustomSkill: (
    id: string,
    patch: Partial<Omit<CustomSkillRecord, 'id' | 'createdAt'>>,
  ) => void;
  removeCustomSkill: (id: string) => void;
  setPresetOverride: (id: string, patch: PresetOverride) => void;
  clearPresetOverride: (id: string) => void;
  deletePreset: (id: string) => void;
  restorePreset: (id: string) => void;
  restoreAllPresets: () => void;
  setSkillEnabled: (id: string, enabled: boolean, source: 'preset' | 'custom') => void;
}

const STORAGE_PREFIX = 'vibespace-skills-catalog-v2';
const SESSION_SCOPE = '__session__';
const MAX_SKILLS = 500;
const MAX_PRESET_ENTRIES = 500;
const MAX_ID_CHARS = 200;
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_DOCUMENT_CHARS = 50_000;
const MAX_TOOLS = 100;
const MAX_TOOL_CHARS = 200;
const MAX_EMOJI_CHARS = 32;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function emptyCatalog(): SkillsCatalogState {
  return {
    customSkills: [],
    presetOverrides: Object.create(null) as Record<string, PresetOverride>,
    deletedPresets: [],
  };
}

function newCustomId(): string {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function storageKey(scopeKey: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(scopeKey)}`;
}

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id && id.length <= MAX_ID_CHARS && !FORBIDDEN_KEYS.has(id) ? id : null;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

function boundedTools(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((tool): tool is string => typeof tool === 'string')
    .slice(0, MAX_TOOLS)
    .map((tool) => tool.slice(0, MAX_TOOL_CHARS));
}

function normalizeCustomSkill(value: unknown): CustomSkillRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const skill = value as Record<string, unknown>;
  const id = safeId(skill.id);
  const name = boundedText(skill.name, MAX_NAME_CHARS);
  const description = boundedText(skill.description, MAX_DESCRIPTION_CHARS);
  const tools = boundedTools(skill.tools);
  const systemPromptAddendum = boundedText(skill.systemPromptAddendum, MAX_DOCUMENT_CHARS);
  const body = boundedText(skill.body, MAX_DOCUMENT_CHARS);
  const emoji = skill.emoji === undefined ? undefined : boundedText(skill.emoji, MAX_EMOJI_CHARS);
  if (
    !id ||
    name === null ||
    description === null ||
    !tools ||
    systemPromptAddendum === null ||
    body === null ||
    typeof skill.color_hue !== 'number' ||
    !Number.isFinite(skill.color_hue) ||
    emoji === null ||
    typeof skill.enabled !== 'boolean' ||
    typeof skill.createdAt !== 'number' ||
    !Number.isSafeInteger(skill.createdAt) ||
    typeof skill.updatedAt !== 'number' ||
    !Number.isSafeInteger(skill.updatedAt)
  ) {
    return null;
  }
  return {
    id,
    name,
    description,
    tools,
    systemPromptAddendum,
    body,
    color_hue: Math.min(360, Math.max(0, skill.color_hue)),
    ...(emoji === undefined ? {} : { emoji }),
    enabled: skill.enabled,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function normalizePresetOverride(value: unknown): PresetOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const override = value as Record<string, unknown>;
  if (
    Object.keys(override).some(
      (key) =>
        ![
          'name',
          'description',
          'tools',
          'systemPromptAddendum',
          'body',
          'color_hue',
          'emoji',
          'enabled',
        ].includes(key),
    )
  ) {
    return null;
  }
  const normalized: PresetOverride = {};
  if (override.name !== undefined) {
    const value = boundedText(override.name, MAX_NAME_CHARS);
    if (value === null) return null;
    normalized.name = value;
  }
  if (override.description !== undefined) {
    const value = boundedText(override.description, MAX_DESCRIPTION_CHARS);
    if (value === null) return null;
    normalized.description = value;
  }
  if (override.tools !== undefined) {
    const value = boundedTools(override.tools);
    if (!value) return null;
    normalized.tools = value;
  }
  for (const key of ['systemPromptAddendum', 'body'] as const) {
    if (override[key] === undefined) continue;
    const value = boundedText(override[key], MAX_DOCUMENT_CHARS);
    if (value === null) return null;
    normalized[key] = value;
  }
  if (override.emoji !== undefined) {
    const value = boundedText(override.emoji, MAX_EMOJI_CHARS);
    if (value === null) return null;
    normalized.emoji = value;
  }
  if (override.color_hue !== undefined) {
    if (typeof override.color_hue !== 'number' || !Number.isFinite(override.color_hue)) return null;
    normalized.color_hue = Math.min(360, Math.max(0, override.color_hue));
  }
  if (override.enabled !== undefined) {
    if (typeof override.enabled !== 'boolean') return null;
    normalized.enabled = override.enabled;
  }
  return normalized;
}

function recoverCatalog(value: unknown): SkillsCatalogState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCatalog();
  const candidate = value as Record<string, unknown>;
  const customSkills: CustomSkillRecord[] = [];
  const seenSkills = new Set<string>();
  if (Array.isArray(candidate.customSkills)) {
    for (const raw of candidate.customSkills.slice(0, MAX_SKILLS)) {
      const skill = normalizeCustomSkill(raw);
      if (skill && !seenSkills.has(skill.id)) {
        seenSkills.add(skill.id);
        customSkills.push(skill);
      }
    }
  }
  const presetOverrides = Object.create(null) as Record<string, PresetOverride>;
  if (
    candidate.presetOverrides &&
    typeof candidate.presetOverrides === 'object' &&
    !Array.isArray(candidate.presetOverrides)
  ) {
    for (const [rawId, rawOverride] of Object.entries(candidate.presetOverrides).slice(
      0,
      MAX_PRESET_ENTRIES,
    )) {
      const id = safeId(rawId);
      const override = normalizePresetOverride(rawOverride);
      if (id && override) presetOverrides[id] = override;
    }
  }
  const deletedPresets = Array.isArray(candidate.deletedPresets)
    ? [
        ...new Set(
          candidate.deletedPresets
            .map((id) => safeId(id))
            .filter((id): id is string => id !== null),
        ),
      ].slice(0, MAX_PRESET_ENTRIES)
    : [];
  return { customSkills, presetOverrides, deletedPresets };
}

function loadCatalog(scopeKey: string): SkillsCatalogState {
  if (scopeKey === SESSION_SCOPE || typeof window === 'undefined') return emptyCatalog();
  try {
    const raw = window.localStorage.getItem(storageKey(scopeKey));
    return raw ? recoverCatalog(JSON.parse(raw)) : emptyCatalog();
  } catch {
    return emptyCatalog();
  }
}

function persistCatalog(scopeKey: string, catalog: SkillsCatalogState): void {
  if (scopeKey === SESSION_SCOPE || typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(scopeKey), JSON.stringify(catalog));
}

function commitCatalog(
  set: (patch: Partial<SkillsStoreState>) => void,
  get: () => SkillsStoreState,
  patch: Partial<SkillsCatalogState>,
): void {
  const normalized = recoverCatalog({
    customSkills: patch.customSkills ?? get().customSkills,
    presetOverrides: patch.presetOverrides ?? get().presetOverrides,
    deletedPresets: patch.deletedPresets ?? get().deletedPresets,
  });
  persistCatalog(get().scopeKey, normalized);
  set(normalized);
}

export const useSkillsStore = create<SkillsStoreState>()((set, get) => ({
  ...emptyCatalog(),
  scopeKey: SESSION_SCOPE,

  getCustomSkill: (id) => {
    const skill = get().customSkills.find((candidate) => candidate.id === id);
    return skill ? (normalizeCustomSkill(skill) ?? undefined) : undefined;
  },

  addCustomSkill: (partial) => {
    const id = newCustomId();
    const now = Date.now();
    const record: CustomSkillRecord = {
      id,
      name: partial?.name?.trim().slice(0, MAX_NAME_CHARS) || 'New skill',
      description:
        partial?.description?.trim().slice(0, MAX_DESCRIPTION_CHARS) ||
        'Custom instructions for this turn',
      tools: [],
      systemPromptAddendum: 'Describe how the assistant should behave when this skill is active.',
      body: '',
      color_hue: 35,
      emoji: partial?.emoji?.slice(0, MAX_EMOJI_CHARS) ?? '✨',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    commitCatalog(set, get, { customSkills: [record, ...get().customSkills] });
    return id;
  },

  restoreCustomSkill: (record) => {
    const normalized = normalizeCustomSkill(record);
    if (!normalized) throw new Error('This skill cannot be restored.');
    if (get().customSkills.some((skill) => skill.id === normalized.id)) {
      throw new Error('A skill with this identity already exists.');
    }
    commitCatalog(set, get, { customSkills: [normalized, ...get().customSkills] });
  },

  updateCustomSkill: (id, patch) => {
    const now = Date.now();
    commitCatalog(set, get, {
      customSkills: get().customSkills.map((skill) =>
        skill.id === id ? { ...skill, ...patch, updatedAt: now } : skill,
      ),
    });
  },

  removeCustomSkill: (id) => {
    commitCatalog(set, get, {
      customSkills: get().customSkills.filter((skill) => skill.id !== id),
    });
  },

  setPresetOverride: (id, patch) => {
    if (!safeId(id)) return;
    commitCatalog(set, get, {
      presetOverrides: Object.assign(Object.create(null), get().presetOverrides, {
        [id]: { ...get().presetOverrides[id], ...patch },
      }) as Record<string, PresetOverride>,
    });
  },

  clearPresetOverride: (id) => {
    if (!safeId(id)) return;
    const next = Object.assign(Object.create(null), get().presetOverrides) as Record<
      string,
      PresetOverride
    >;
    delete next[id];
    commitCatalog(set, get, { presetOverrides: next });
  },

  deletePreset: (id) => {
    if (!safeId(id)) return;
    const deleted = new Set(get().deletedPresets);
    deleted.add(id);
    commitCatalog(set, get, { deletedPresets: Array.from(deleted) });
  },

  restorePreset: (id) => {
    if (!safeId(id)) return;
    const presetOverrides = Object.assign(Object.create(null), get().presetOverrides) as Record<
      string,
      PresetOverride
    >;
    delete presetOverrides[id];
    commitCatalog(set, get, {
      deletedPresets: get().deletedPresets.filter((candidate) => candidate !== id),
      presetOverrides,
    });
  },

  restoreAllPresets: () => {
    commitCatalog(set, get, { deletedPresets: [], presetOverrides: {} });
  },

  setSkillEnabled: (id, enabled, source) => {
    if (source === 'custom') {
      get().updateCustomSkill(id, { enabled });
      return;
    }
    get().setPresetOverride(id, { enabled });
  },
}));

function activateSkillsScope(): void {
  const scopeKey = getActiveAccountIdentity()?.accountId ?? SESSION_SCOPE;
  if (useSkillsStore.getState().scopeKey === scopeKey) return;
  useSkillsStore.setState({ ...loadCatalog(scopeKey), scopeKey });
}

/** Non-hook read for runtime / catalog merge (same pattern as milestonesStore). */
export function readSkillsStore(): SkillsStoreState {
  activateSkillsScope();
  return useSkillsStore.getState();
}

export function resetSkillsStoreForTests(): void {
  useSkillsStore.setState({ ...emptyCatalog(), scopeKey: SESSION_SCOPE });
}
