export type RelayCollaborationScope = 'off' | 'project' | 'entire-app';

export interface RelaySettings {
  scope: RelayCollaborationScope;
  automaticParticipation: boolean;
  excludedParticipants: string[];
}

export const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  scope: 'off',
  automaticParticipation: false,
  excludedParticipants: [],
};

const STORAGE_KEY = 'vibespace:agent-relay:settings:v1';
const MAX_EXCLUSIONS = 500;
const MAX_ID_LENGTH = 200;

function normalizeExclusions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim().slice(0, MAX_ID_LENGTH);
    if (id) unique.add(id);
    if (unique.size >= MAX_EXCLUSIONS) break;
  }
  return [...unique];
}

export function normalizeRelaySettings(value: unknown): RelaySettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_RELAY_SETTINGS };
  const candidate = value as Record<string, unknown>;
  const scope: RelayCollaborationScope =
    candidate.scope === 'project' || candidate.scope === 'entire-app' ? candidate.scope : 'off';
  return {
    scope,
    automaticParticipation: candidate.automaticParticipation === true,
    excludedParticipants: normalizeExclusions(candidate.excludedParticipants),
  };
}

export function readRelaySettings(storage?: Pick<Storage, 'getItem'>): RelaySettings {
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    const raw = target?.getItem(STORAGE_KEY);
    return raw ? normalizeRelaySettings(JSON.parse(raw)) : { ...DEFAULT_RELAY_SETTINGS };
  } catch {
    return { ...DEFAULT_RELAY_SETTINGS };
  }
}

export function writeRelaySettings(
  settings: RelaySettings,
  storage?: Pick<Storage, 'setItem'>,
): RelaySettings {
  const normalized = normalizeRelaySettings(settings);
  try {
    const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    target?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Keep the in-memory UI usable if browser storage is disabled or full.
  }
  return normalized;
}
