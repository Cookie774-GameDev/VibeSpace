export type RlmRoute = 'direct' | 'retrieval' | 'rlm';

export interface RlmPreferenceLayer {
  chat?: boolean;
  workspace?: boolean;
  user?: boolean;
}

/** Default is ON. Chat override wins, then workspace, then user. */
export function resolveRlmEnabled(preference: RlmPreferenceLayer): boolean {
  return preference.chat ?? preference.workspace ?? preference.user ?? true;
}

export type RlmCommand =
  | { kind: 'open' }
  | { kind: 'status' }
  | { kind: 'set'; enabled: boolean }
  | { kind: 'refresh' }
  | { kind: 'trace' };

export function parseRlmCommand(input: string): RlmCommand | null {
  const parts = input.trim().toLocaleLowerCase('en-US').split(/\s+/u).filter(Boolean);
  if (parts[0] !== '/rlm' || parts.length > 2) return null;
  if (parts.length === 1) return { kind: 'open' };
  switch (parts[1]) {
    case 'on': return { kind: 'set', enabled: true };
    case 'off': return { kind: 'set', enabled: false };
    case 'status': return { kind: 'status' };
    case 'refresh': return { kind: 'refresh' };
    case 'trace': return { kind: 'trace' };
    default: return null;
  }
}

export interface PersistedRlmState {
  schemaVersion: 1;
  userDefault: boolean;
  workspaceOverrides: Readonly<Record<string, boolean>>;
  chatOverrides: Readonly<Record<string, boolean>>;
}

export const DEFAULT_RLM_STATE: PersistedRlmState = Object.freeze({
  schemaVersion: 1,
  userDefault: true,
  workspaceOverrides: Object.freeze({}),
  chatOverrides: Object.freeze({}),
});

const MAX_OVERRIDE_ENTRIES = 2_000;

function validScopeId(value: string): boolean {
  const clean = value.trim();
  return Boolean(clean && clean.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(clean));
}

export function sanitizeRlmState(value: unknown): PersistedRlmState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_RLM_STATE;
  const raw = value as Record<string, unknown>;
  const sanitizeOverrides = (candidate: unknown): Readonly<Record<string, boolean>> => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return Object.freeze({});
    const output: Record<string, boolean> = {};
    for (const [key, setting] of Object.entries(candidate as Record<string, unknown>).slice(0, MAX_OVERRIDE_ENTRIES)) {
      const clean = key.trim();
      if (validScopeId(clean) && typeof setting === 'boolean') output[clean] = setting;
    }
    return Object.freeze(output);
  };
  return Object.freeze({
    schemaVersion: 1,
    userDefault: typeof raw.userDefault === 'boolean' ? raw.userDefault : true,
    workspaceOverrides: sanitizeOverrides(raw.workspaceOverrides),
    chatOverrides: sanitizeOverrides(raw.chatOverrides),
  });
}
