import { TOKEN_OPTIMIZATION_MODES, type TokenOptimizationMode } from './contracts';

export const DURABLE_TOKEN_OPTIMIZATION_PREFERENCES_KEY =
  'vibespace.token-optimization.durable-preferences.v1';

const MAX_CHAT_OVERRIDES = 256;
const MAX_WRITE_ATTEMPTS = 4;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MODES = new Set<string>(TOKEN_OPTIMIZATION_MODES);

export interface DurablePreferenceValue {
  readonly value: string | null;
  readonly storageRevision: string | null;
}

export interface DurableTokenOptimizationPreferenceStorage {
  read(key: string): Promise<DurablePreferenceValue>;
  compareAndSet(
    key: string,
    expectedStorageRevision: string | null,
    value: string,
  ): Promise<Readonly<{ applied: boolean; storageRevision: string }>>;
}

export interface DurableTokenOptimizationPreferences {
  readonly version: 1;
  readonly revision: number;
  readonly globalMode: TokenOptimizationMode;
  readonly chatOverrides: Readonly<Record<string, TokenOptimizationMode>>;
}

export interface DurableTokenOptimizationPreferenceRepository {
  getSnapshot(): Promise<DurableTokenOptimizationPreferences>;
  resolveMode(chatKey?: string | null): Promise<TokenOptimizationMode>;
  setGlobalMode(
    mode: TokenOptimizationMode,
    mutationId: string,
  ): Promise<DurableTokenOptimizationPreferences>;
  setChatOverride(
    chatKey: string,
    mode: TokenOptimizationMode,
    mutationId: string,
  ): Promise<DurableTokenOptimizationPreferences>;
  clearChatOverride(
    chatKey: string,
    mutationId: string,
  ): Promise<DurableTokenOptimizationPreferences>;
}

interface PersistedPreferences {
  readonly version: 1;
  readonly revision: number;
  readonly globalMode: TokenOptimizationMode;
  readonly chatOverrides: Record<string, TokenOptimizationMode>;
  readonly lastMutationId?: string;
  readonly lastMutationFingerprint?: string;
}

function isMode(value: unknown): value is TokenOptimizationMode {
  return typeof value === 'string' && MODES.has(value);
}

function assertSafeKey(label: string, value: string): void {
  if (!SAFE_KEY.test(value)) throw new Error(`Invalid ${label}.`);
}

function orderedOverrides(
  overrides: Readonly<Record<string, TokenOptimizationMode>>,
): Record<string, TokenOptimizationMode> {
  return Object.fromEntries(
    Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parse(raw: string | null): PersistedPreferences {
  if (!raw) {
    return { version: 1, revision: 0, globalMode: 'normal', chatOverrides: {} };
  }
  try {
    const value = JSON.parse(raw) as Partial<PersistedPreferences>;
    if (
      value.version !== 1 ||
      typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !isMode(value.globalMode) ||
      !value.chatOverrides ||
      typeof value.chatOverrides !== 'object' ||
      Array.isArray(value.chatOverrides)
    ) {
      throw new Error('invalid');
    }
    const chatOverrides: Record<string, TokenOptimizationMode> = {};
    for (const [chatKey, mode] of Object.entries(value.chatOverrides)) {
      if (Object.keys(chatOverrides).length >= MAX_CHAT_OVERRIDES) break;
      if (SAFE_KEY.test(chatKey) && isMode(mode)) chatOverrides[chatKey] = mode;
    }
    return {
      version: 1,
      revision: value.revision,
      globalMode: value.globalMode,
      chatOverrides: orderedOverrides(chatOverrides),
      ...(typeof value.lastMutationId === 'string' && SAFE_KEY.test(value.lastMutationId)
        ? { lastMutationId: value.lastMutationId }
        : {}),
      ...(typeof value.lastMutationFingerprint === 'string' &&
      value.lastMutationFingerprint.length <= 512
        ? { lastMutationFingerprint: value.lastMutationFingerprint }
        : {}),
    };
  } catch {
    return { version: 1, revision: 0, globalMode: 'normal', chatOverrides: {} };
  }
}

function publicSnapshot(value: PersistedPreferences): DurableTokenOptimizationPreferences {
  return Object.freeze({
    version: 1,
    revision: value.revision,
    globalMode: value.globalMode,
    chatOverrides: Object.freeze(orderedOverrides(value.chatOverrides)),
  });
}

export function createDurableTokenOptimizationPreferenceRepository(
  storage: DurableTokenOptimizationPreferenceStorage,
): DurableTokenOptimizationPreferenceRepository {
  const load = async () => {
    const stored = await storage.read(DURABLE_TOKEN_OPTIMIZATION_PREFERENCES_KEY);
    return { stored, preferences: parse(stored.value) };
  };

  const mutate = async (
    mutationId: string,
    fingerprint: string,
    update: (current: PersistedPreferences) => PersistedPreferences,
  ): Promise<DurableTokenOptimizationPreferences> => {
    assertSafeKey('preference mutation id', mutationId);
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const { stored, preferences } = await load();
      if (preferences.lastMutationId === mutationId) {
        if (preferences.lastMutationFingerprint !== fingerprint) {
          throw new Error('Preference mutation id was reused for a different write.');
        }
        return publicSnapshot(preferences);
      }
      const updated = update(preferences);
      const next: PersistedPreferences = {
        ...updated,
        version: 1,
        revision: preferences.revision + 1,
        chatOverrides: orderedOverrides(updated.chatOverrides),
        lastMutationId: mutationId,
        lastMutationFingerprint: fingerprint,
      };
      const written = await storage.compareAndSet(
        DURABLE_TOKEN_OPTIMIZATION_PREFERENCES_KEY,
        stored.storageRevision,
        JSON.stringify(next),
      );
      if (written.applied) return publicSnapshot(next);
    }
    throw new Error('Token optimization preferences changed concurrently.');
  };

  return {
    async getSnapshot() {
      return publicSnapshot((await load()).preferences);
    },
    async resolveMode(chatKey) {
      const snapshot = publicSnapshot((await load()).preferences);
      if (!chatKey) return snapshot.globalMode;
      assertSafeKey('chat preference key', chatKey);
      return snapshot.chatOverrides[chatKey] ?? snapshot.globalMode;
    },
    async setGlobalMode(mode, mutationId) {
      if (!isMode(mode)) throw new Error('Invalid token optimization mode.');
      return mutate(mutationId, `global:${mode}`, (current) => ({
        ...current,
        globalMode: mode,
      }));
    },
    async setChatOverride(chatKey, mode, mutationId) {
      assertSafeKey('chat preference key', chatKey);
      if (!isMode(mode)) throw new Error('Invalid token optimization mode.');
      return mutate(mutationId, `chat:${chatKey}:${mode}`, (current) => {
        const overrides = { ...current.chatOverrides, [chatKey]: mode };
        if (
          !Object.prototype.hasOwnProperty.call(current.chatOverrides, chatKey) &&
          Object.keys(overrides).length > MAX_CHAT_OVERRIDES
        ) {
          throw new Error('Too many token optimization chat overrides.');
        }
        return { ...current, chatOverrides: overrides };
      });
    },
    async clearChatOverride(chatKey, mutationId) {
      assertSafeKey('chat preference key', chatKey);
      return mutate(mutationId, `clear:${chatKey}`, (current) => {
        const overrides = { ...current.chatOverrides };
        delete overrides[chatKey];
        return { ...current, chatOverrides: overrides };
      });
    },
  };
}
