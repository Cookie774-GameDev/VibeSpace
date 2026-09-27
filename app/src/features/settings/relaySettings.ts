export type RelayCollaborationScope = 'off' | 'project' | 'entire-app';

export interface RelaySettings {
  scope: RelayCollaborationScope;
  automaticParticipation: boolean;
  excludedParticipants: string[];
}

export interface RelayParticipantScope {
  projectId?: string | null;
  sessionId?: string | null;
}

export type RelaySettingsListener = (settings: RelaySettings) => void;

export const DEFAULT_RELAY_SETTINGS: RelaySettings = {
  scope: 'off',
  automaticParticipation: false,
  excludedParticipants: [],
};

const STORAGE_KEY = 'vibespace:agent-relay:settings:v1';
const MAX_EXCLUSIONS = 500;
const MAX_ID_LENGTH = 200;
const settingsListeners = new Set<RelaySettingsListener>();
let storageListenerAttached = false;

function copySettings(settings: RelaySettings): RelaySettings {
  return { ...settings, excludedParticipants: [...settings.excludedParticipants] };
}

function notifySettingsListeners(settings: RelaySettings): void {
  for (const listener of [...settingsListeners]) {
    try {
      listener(copySettings(settings));
    } catch {
      // A host subscriber must not break a settings write or another subscriber.
    }
  }
}

function handleRelaySettingsStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    notifySettingsListeners(
      event.newValue ? normalizeRelaySettings(JSON.parse(event.newValue)) : DEFAULT_RELAY_SETTINGS,
    );
  } catch {
    notifySettingsListeners(DEFAULT_RELAY_SETTINGS);
  }
}

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

/** Subscribe to local writes and preference changes from another same-origin app window. */
export function subscribeRelaySettings(listener: RelaySettingsListener): () => void {
  settingsListeners.add(listener);
  if (typeof window !== 'undefined' && !storageListenerAttached) {
    window.addEventListener('storage', handleRelaySettingsStorage);
    storageListenerAttached = true;
  }
  return () => {
    settingsListeners.delete(listener);
    if (settingsListeners.size === 0 && typeof window !== 'undefined' && storageListenerAttached) {
      window.removeEventListener('storage', handleRelaySettingsStorage);
      storageListenerAttached = false;
    }
  };
}

/** Scope check used before enrolling, reading, sending, delivering, or waking a participant. */
export function canParticipateInRelay(
  settings: RelaySettings,
  participant: RelayParticipantScope,
  activeProjectId?: string | null,
): boolean {
  const normalized = normalizeRelaySettings(settings);
  if (normalized.scope === 'off') return false;

  const projectId = participant.projectId?.trim();
  const sessionId = participant.sessionId?.trim();
  if (!projectId || !sessionId) return false;
  if (
    normalized.excludedParticipants.includes(projectId) ||
    normalized.excludedParticipants.includes(sessionId)
  ) {
    return false;
  }
  if (normalized.scope === 'project') {
    const activeProject = activeProjectId?.trim();
    if (!activeProject || projectId !== activeProject) return false;
  }
  return true;
}

/** Automatic check-ins/replies add a second explicit opt-in to the scope check. */
export function canAutomaticallyParticipateInRelay(
  settings: RelaySettings,
  participant: RelayParticipantScope,
  activeProjectId?: string | null,
): boolean {
  const normalized = normalizeRelaySettings(settings);
  return (
    normalized.automaticParticipation &&
    canParticipateInRelay(normalized, participant, activeProjectId)
  );
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
  notifySettingsListeners(normalized);
  return normalized;
}
