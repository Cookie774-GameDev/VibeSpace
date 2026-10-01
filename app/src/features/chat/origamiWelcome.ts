export type OrigamiWelcomeVariant = 'boat' | 'lotus';

const STORAGE_KEY = 'vibespace:origami-welcome:v1';
const MAX_ASSIGNMENTS = 192;

type StoredWelcomeState = {
  assignments: Array<[string, OrigamiWelcomeVariant]>;
};

type WelcomeSample = () => number;

function fallbackFor(chatId: string): OrigamiWelcomeVariant {
  let hash = 2166136261;
  for (const character of chatId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 'boat' : 'lotus';
}

function parseState(value: string | null): StoredWelcomeState {
  if (!value) return { assignments: [] };

  try {
    const parsed = JSON.parse(value) as Partial<StoredWelcomeState>;
    const assignments = Array.isArray(parsed.assignments)
      ? parsed.assignments.filter(
          (entry): entry is [string, OrigamiWelcomeVariant] =>
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            (entry[1] === 'boat' || entry[1] === 'lotus'),
        )
      : [];
    return {
      assignments: assignments.slice(-MAX_ASSIGNMENTS),
    };
  } catch {
    return { assignments: [] };
  }
}

function sampleWelcome(): number {
  const values = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(values);
    return values[0] / 0x1_0000_0000;
  }
  return Math.random();
}

/**
 * Gives each newly encountered chat an independent 50/50 assignment between
 * the two owner-approved welcome compositions, then persists the result so the
 * same chat remains visually stable across navigation and reloads. Storage or
 * randomness failures fall back to a deterministic, UI-only hash.
 */
export function resolveOrigamiWelcomeVariant(
  chatId: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
  sample: WelcomeSample = sampleWelcome,
): OrigamiWelcomeVariant {
  if (!chatId) return 'boat';

  try {
    const state = parseState(storage?.getItem(STORAGE_KEY) ?? null);
    const existing = state.assignments.find(([id]) => id === chatId);
    if (existing) return existing[1];

    const sampledValue = sample();
    if (!Number.isFinite(sampledValue) || sampledValue < 0 || sampledValue >= 1) {
      throw new Error('Origami welcome sample must be between zero and one.');
    }
    const variant: OrigamiWelcomeVariant = sampledValue < 0.5 ? 'boat' : 'lotus';
    state.assignments.push([chatId, variant]);
    state.assignments = state.assignments.slice(-MAX_ASSIGNMENTS);
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
    return variant;
  } catch {
    return fallbackFor(chatId);
  }
}
