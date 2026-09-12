export const CONSOLE_PREFERENCE_KEY = 'vibespace.agentic-console.preferences';
export const CONSOLE_PREFERENCE_EVENT = 'vibespace:agentic-console-preferences';

export const CONSOLE_PROFILES = [
  { id: 'paper-white', label: 'Paper White' },
  { id: 'solar-sand', label: 'Solar Sand' },
  { id: 'sakura-mist', label: 'Sakura Mist' },
  { id: 'icebound', label: 'Icebound' },
  { id: 'vibespace-amber', label: 'VibeSpace Amber' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'midnight-blue', label: 'Midnight Blue' },
  { id: 'monokai-ember', label: 'Monokai Ember' },
  { id: 'matrix-moss', label: 'Matrix Moss' },
  { id: 'oled-void', label: 'OLED Void' },
] as const;

export type ConsoleProfile = (typeof CONSOLE_PROFILES)[number]['id'];
export type ConsoleView = 'agentic' | 'classic';
export type ConsoleDensity = 'comfortable' | 'compact';
export type ConsoleCaret = 'standard' | 'block';

export type ConsolePreferences = {
  version: 1;
  view: ConsoleView;
  profile: ConsoleProfile;
  density: ConsoleDensity;
  caret: ConsoleCaret;
};

export const DEFAULT_CONSOLE_PREFERENCES: ConsolePreferences = {
  version: 1,
  view: 'agentic',
  profile: 'vibespace-amber',
  density: 'comfortable',
  caret: 'standard',
};

export type ChatPresentationCommand =
  | { kind: 'console-theme'; profile: ConsoleProfile; notice: string }
  | { kind: 'console-theme-help'; notice: string }
  | { kind: 'appearance'; argument: string; notice?: string };

const PROFILE_IDS = new Set<string>(CONSOLE_PROFILES.map((profile) => profile.id));
const GLOBAL_THEME_ALIASES = new Map([
  ['jarvis', 'Jarvis Core'],
  ['jarvis-core', 'Jarvis Core'],
  ['vibespace', 'VibeSpace'],
  ['default', 'Default'],
  ['monochrome', 'MonoChrome'],
  ['sakura', 'Sakura'],
  ['warm', 'Warm'],
  ['origami', 'Origami'],
]);

let snapshot = DEFAULT_CONSOLE_PREFERENCES;
const listeners = new Set<() => void>();

function applyCaretPreference(preferences: ConsolePreferences): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.agenticConsoleCaret =
      preferences.view === 'agentic' ? preferences.caret : 'standard';
  }
}

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function isPreferences(value: unknown): value is ConsolePreferences {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ConsolePreferences>;
  return (
    candidate.version === 1 &&
    (candidate.view === 'agentic' || candidate.view === 'classic') &&
    typeof candidate.profile === 'string' &&
    PROFILE_IDS.has(candidate.profile) &&
    (candidate.density === 'comfortable' || candidate.density === 'compact') &&
    (candidate.caret === 'standard' || candidate.caret === 'block')
  );
}

function retireClassicView(preferences: ConsolePreferences): ConsolePreferences {
  return preferences.view === 'classic' ? { ...preferences, view: 'agentic' } : preferences;
}

export function loadConsolePreferences(): ConsolePreferences {
  if (typeof localStorage === 'undefined') return DEFAULT_CONSOLE_PREFERENCES;
  try {
    const value = JSON.parse(localStorage.getItem(CONSOLE_PREFERENCE_KEY) ?? 'null');
    snapshot = retireClassicView(isPreferences(value) ? value : DEFAULT_CONSOLE_PREFERENCES);
    if (isPreferences(value) && value.view === 'classic') {
      localStorage.setItem(CONSOLE_PREFERENCE_KEY, JSON.stringify(snapshot));
    }
  } catch {
    snapshot = DEFAULT_CONSOLE_PREFERENCES;
  }
  applyCaretPreference(snapshot);
  return snapshot;
}

export function saveConsolePreferences(next: ConsolePreferences): void {
  snapshot = retireClassicView(isPreferences(next) ? next : DEFAULT_CONSOLE_PREFERENCES);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(CONSOLE_PREFERENCE_KEY, JSON.stringify(snapshot));
    } catch {
      // Presentation preferences are non-critical; keep the in-memory value.
    }
  }
  applyCaretPreference(snapshot);
  listeners.forEach((listener) => listener());
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CONSOLE_PREFERENCE_EVENT, { detail: snapshot }));
  }
}

export function updateConsolePreferences(patch: Partial<ConsolePreferences>): ConsolePreferences {
  const next = { ...loadConsolePreferences(), ...patch, version: 1 as const };
  saveConsolePreferences(next);
  return snapshot;
}

export function getConsolePreferencesSnapshot(): ConsolePreferences {
  return snapshot;
}

export function subscribeConsolePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function parseChatPresentationCommand(input: string): ChatPresentationCommand | null {
  const match = input.trim().match(/^\/(theme|appearance)(?:\s+(.+?))?\s*$/i);
  if (!match) return null;
  const command = match[1]?.toLowerCase();
  const rawArgument = match[2]?.trim() ?? '';
  const argument = normalize(rawArgument);

  if (command === 'appearance') {
    return {
      kind: 'appearance',
      argument,
    };
  }

  if (!argument) {
    return {
      kind: 'console-theme-help',
      notice: `Chat console themes: ${CONSOLE_PROFILES.map((profile) => profile.label).join(', ')}. Use /theme <name>.`,
    };
  }

  const legacyLabel = GLOBAL_THEME_ALIASES.get(argument);
  if (legacyLabel) {
    return {
      kind: 'appearance',
      argument,
      notice: `Global themes moved to /appearance. Applying ${legacyLabel}.`,
    };
  }

  const profile = CONSOLE_PROFILES.find(
    (candidate) => candidate.id === argument || normalize(candidate.label) === argument,
  );
  if (!profile) {
    return {
      kind: 'console-theme-help',
      notice: `Unknown console theme. Available: ${CONSOLE_PROFILES.map((item) => item.label).join(', ')}.`,
    };
  }
  return {
    kind: 'console-theme',
    profile: profile.id,
    notice: `Chat console theme set to ${profile.label}.`,
  };
}
